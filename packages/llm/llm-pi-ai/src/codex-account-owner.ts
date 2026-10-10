/** Account lifecycle over an exclusively owned durable vault; grants remain provider-private. */
import { randomUUID } from 'node:crypto'
import { brandString } from '@deepseek-ai/dsh-brand'
import { credentialKey } from '@deepseek-ai/dsh-credentials'
import type { CredentialKey } from '@deepseek-ai/dsh-credentials'
import type { Provider } from '@earendil-works/pi-ai'
import { LlmError } from '@deepseek-ai/dsh-llm'
import type { PiAiAccountBinding, CodexAccountId } from './account-binding.ts'
import type { PiAiAuthInjection } from './adapter.ts'
import type { CodexAccountLogin, CodexAccountLoginResult, CodexAccountsDescription, CodexModelAccount } from './codex-accounts.ts'
import { CODEX_PROVIDER, codexBoundStore, codexObserverToken } from './codex-grant.ts'
import type { CodexObserverToken, CodexRecordStore } from './codex-grant.ts'
import { createModels } from './models.ts'
import { runPiAiLogin } from './login.ts'

/** Non-secret manifest committed only after retired SDK work reaches terminal settlement. */
export interface CodexAccountManifest {
  readonly accounts: readonly CodexModelAccount[]
  readonly selected: CodexAccountId | null
  readonly epoch: number
}

/** Private vault and adapter dependencies; no raw grants cross the account service. */
export interface CodexAccountOwnerOptions {
  readonly records: CodexRecordStore
  readonly legacyPresent: () => Promise<boolean>
  readonly auth: PiAiAuthInjection
  readonly provider: Provider
  /** Reject absent or lost lifetime vault ownership. */
  readonly assertExclusive: () => void
  /** Synchronously retired on detected lease loss or an indeterminate vault commit. */
  readonly ownershipSignal?: AbortSignal
  /** Atomically remove grants for previously committed accounts removed from this manifest. */
  readonly commitManifest: (manifest: CodexAccountManifest) => Promise<void>
  /** Drain every attached adapter's account-specific terminal SDK leases. */
  readonly retireBinding: (binding: PiAiAccountBinding) => Promise<void>
}

interface Account {
  readonly view: CodexModelAccount
  readonly key: CredentialKey
  readonly operations: Set<Promise<unknown>>
  tombstone: number
}

/** Durable account lifecycle with no legacy adoption, inferred identity or selection fallback. */
export class CodexAccountOwner {
  private readonly accounts = new Map<CodexAccountId, Account>()
  private selected: CodexAccountId | null = null
  private epoch = 0
  private binding: PiAiAccountBinding | undefined
  private bindingController: AbortController | undefined
  private transition: Promise<void> = Promise.resolve()
  private login: { controller: AbortController; done: Promise<CodexAccountLoginResult> } | undefined
  private clearing: Promise<void> | undefined
  private disposed = false
  private disposal: Promise<void> | undefined
  private restored = false
  private published: CodexAccountManifest = { accounts: [], selected: null, epoch: 0 }

  constructor(private readonly options: CodexAccountOwnerOptions) {}

  /** Hide owner internals from JSON serialization.
   * @returns a fixed marker without credential dependencies or pending token results.
   */
  toJSON(): string { return 'CodexAccountOwner([REDACTED])' }
  /** Hide owner internals from Node object inspection.
   * @returns a fixed private-owner diagnostic marker.
   */
  [Symbol.for('nodejs.util.inspect.custom')](): string { return this.toJSON() }

  private assertOwner(): void {
    try {
      this.options.assertExclusive()
    } catch (error) {
      this.bindingController?.abort('Codex vault ownership lost')
      this.login?.controller.abort('Codex vault ownership lost')
      throw error
    }
    if (this.disposed) throw new LlmError('Codex account owner is disposed', 'ACCOUNT_OWNER_DISPOSED')
  }

  private account(view: CodexModelAccount): Account {
    return { view: Object.freeze({ ...view }), key: credentialKey('llm-pi-ai-codex-accounts', view.opaqueId),
      operations: new Set(), tombstone: 0 }
  }

  /**
   * Restore a parser-validated vault before exposing the service or admitting SDK work.
   * @param manifest - committed metadata whose referenced grants must all exist.
   * @returns after every managed grant validates; a missing selection never falls back.
   */
  async restore(manifest: CodexAccountManifest): Promise<void> {
    this.assertOwner()
    if (this.restored || this.accounts.size !== 0 || this.login !== undefined) {
      throw new LlmError('Codex account owner already initialized', 'ACCOUNT_OWNER_INITIALIZED')
    }
    this.restored = true
    const accounts = manifest.accounts.map(view => this.account(view))
    for (const account of accounts) {
      const stored = await this.store(account).credentials.read(CODEX_PROVIDER)
      if (stored === undefined) throw new LlmError('Committed Codex account grant is absent', 'INVALID_CODEX_GRANT')
    }
    this.assertOwner()
    for (const account of accounts) this.accounts.set(account.view.opaqueId, account)
    this.selected = manifest.selected
    this.epoch = manifest.epoch
    this.published = { ...manifest, accounts: accounts.map(account => account.view) }
    if (this.selected !== null) {
      const selected = this.accounts.get(this.selected)
      if (selected === undefined) throw new LlmError('Selected Codex account is absent', 'INVALID_CODEX_MANIFEST')
      this.bind(selected)
    }
  }

  private async commit(manifest: CodexAccountManifest): Promise<void> {
    this.assertOwner()
    await this.options.commitManifest(manifest)
    this.assertOwner()
    this.published = manifest
  }

  private manifest(selected = this.selected): CodexAccountManifest {
    return { accounts: [...this.accounts.values()].map(account => account.view), selected, epoch: this.epoch }
  }

  private guard(expectedEpoch?: number): void {
    if (expectedEpoch !== undefined && expectedEpoch !== this.published.epoch) {
      throw new LlmError('Codex account selection changed', 'CODEX_EPOCH_CONFLICT')
    }
  }

  /** Read committed account metadata without adopting legacy grants.
   * @returns committed public state and legacy presence, without grant contents.
   */
  async describe(): Promise<CodexAccountsDescription> {
    this.assertOwner()
    const legacy = await this.options.legacyPresent() ? 'unadopted' : 'absent'
    this.assertOwner()
    return { ...this.published, accounts: this.published.accounts.map(account => ({ ...account })), legacy }
  }

  /** Capture the selected immutable account epoch without fallback.
   * @returns the current binding; throws a no-selection error when none is selected.
   */
  captureBinding(): PiAiAccountBinding {
    this.assertOwner()
    if (this.binding === undefined) throw new LlmError('No managed Codex account is selected', 'NO_CODEX_ACCOUNT')
    this.binding.assertCurrent()
    return this.binding
  }

  private track<T>(account: Account, operation: Promise<T>): Promise<T> {
    account.operations.add(operation)
    void operation.finally(() => { account.operations.delete(operation) }).catch(() => {
      // The operation's initiating caller owns its rejection.
    })
    return operation
  }

  private store(account: Account, signal?: AbortSignal): PiAiAuthInjection {
    const tombstone = account.tombstone
    const credentials = codexBoundStore(this.options.records, account.key, () => {
      this.assertOwner()
      signal?.throwIfAborted()
      if (account.tombstone !== tombstone) throw new LlmError('Codex account was retired', 'STALE_CODEX_ACCOUNT')
    })
    const legacy = this.options.auth.credentials
    return {
      authContext: this.options.auth.authContext,
      credentials: {
        read: (id, options) => id === CODEX_PROVIDER
          ? this.track(account, credentials.read(id, options)) : legacy.read(id, options),
        modify: (id, mutate, options) => id === CODEX_PROVIDER
          ? this.track(account, credentials.modify(id, mutate, options)) : legacy.modify(id, mutate, options),
        delete: (id, options) => id === CODEX_PROVIDER
          ? this.track(account, credentials.delete(id, options)) : legacy.delete(id, options),
        list: options => this.track(account, credentials.list(options)),
      },
    }
  }

  /** Authorize and add one account without replacing selection.
   * @param request - label, human-authorized interaction, optional cancellation and epoch guard.
   * @returns an unselected account and its exact add-commit epoch.
   */
  beginLogin(request: CodexAccountLogin): Promise<CodexAccountLoginResult> {
    this.assertOwner()
    this.guard(request.expectedEpoch)
    if (this.login !== undefined || this.clearing !== undefined) {
      throw new LlmError('Codex sign-in or sign-out-all is already running', 'CODEX_LOGIN_IN_PROGRESS')
    }
    if (request.label.trim().length === 0 || [...request.label].length > 128
      || Buffer.byteLength(request.label, 'utf8') > 512 || /[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}]/u.test(request.label)) {
      throw new LlmError('Codex label must be 1–128 printable characters', 'INVALID_CODEX_LABEL')
    }
    if (this.accounts.size >= 128) throw new LlmError('Codex account limit reached', 'CODEX_ACCOUNT_LIMIT')
    const controller = new AbortController()
    const signal = AbortSignal.any([controller.signal,
      ...request.signal === undefined ? [] : [request.signal],
      ...this.options.ownershipSignal === undefined ? [] : [this.options.ownershipSignal],
    ])
    const opaqueId = brandString<CodexAccountId>(`account-${randomUUID()}`)
    const account = this.account({ opaqueId, label: request.label, email: null, plan: null })
    const done = this.addAccount(account, request, signal)
    const attempt = { controller, done }
    this.login = attempt
    void done.finally(() => { if (this.login === attempt) this.login = undefined }).catch(() => {
      // The initiating caller owns the login rejection.
    })
    return done
  }

  private async addAccount(account: Account, request: CodexAccountLogin, signal: AbortSignal): Promise<CodexAccountLoginResult> {
    try {
      const models = createModels(this.store(account, signal))
      const provider = this.options.provider
      const oauth = provider.auth.oauth
      if (provider.id !== CODEX_PROVIDER || oauth === undefined) {
        throw new LlmError('Codex OAuth provider is unavailable', 'CODEX_OAUTH_UNAVAILABLE')
      }
      let terminal: Promise<unknown> | undefined
      models.setProvider({ ...provider, auth: { oauth: { ...oauth, login: (interaction) => {
        const operation = oauth.login(interaction)
        terminal = operation
        return operation
      } } } })
      try {
        await runPiAiLogin(models, CODEX_PROVIDER, 'oauth', request.interaction, signal)
      } finally {
        await terminal?.catch(() => {
          // Models.login owns the outcome; this owner additionally owns OAuth quiescence.
        })
      }
      signal.throwIfAborted()
      this.assertOwner()
      return await this.enqueue(async () => {
        this.assertOwner()
        signal.throwIfAborted()
        this.guard(request.expectedEpoch)
        await this.commit({ ...this.manifest(), accounts: [...this.manifest().accounts, account.view] })
        this.accounts.set(account.view.opaqueId, account)
        return Object.freeze({ account: account.view, epoch: this.published.epoch })
      })
    } catch (error) {
      account.tombstone++
      await this.drainAccount(account)
      await this.options.records.deleteRecord(account.key)
      throw error
    }
  }

  /** Cancel active sign-in and wait for staging-key cleanup.
   * @returns after the sign-in attempt and staging-key cleanup finish.
   */
  async cancelLogin(): Promise<void> {
    const login = this.login
    if (login === undefined) return
    login.controller.abort('Codex sign-in cancelled')
    await login.done.catch(() => {
      // Cancellation waits for cleanup; the initiating caller owns its outcome.
    })
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.transition.then(operation)
    this.transition = next.then(() => {}, () => {
      // Each caller receives its error; later explicit operations may recover.
    })
    return next
  }

  private async drainAccount(account: Account): Promise<void> {
    // SDK auth races abort against refresh; the store mutation may outlive its event stream.
    while (account.operations.size > 0) await Promise.allSettled([...account.operations])
  }

  private async retireSelected(): Promise<void> {
    if (this.epoch >= Number.MAX_SAFE_INTEGER) throw new LlmError('Codex epoch exhausted', 'CODEX_EPOCH_EXHAUSTED')
    this.epoch++
    const binding = this.binding
    this.binding = undefined
    if (binding !== undefined) {
      this.bindingController?.abort('Codex selection retired')
      const account = this.accounts.get(binding.opaqueId)
      const results = await Promise.allSettled([
        this.options.retireBinding(binding),
        ...(account === undefined ? [] : [this.drainAccount(account)]),
      ])
      const failures = results.filter(result => result.status === 'rejected').map((result): unknown => result.reason)
      if (failures.length > 0) throw new AggregateError(failures, 'Codex account retirement failed')
    }
  }

  private bind(account: Account): void {
    const controller = new AbortController()
    const epoch = this.epoch
    const signal = this.options.ownershipSignal === undefined ? controller.signal
      : AbortSignal.any([controller.signal, this.options.ownershipSignal])
    const auth = this.store(account, signal)
    this.bindingController = controller
    this.binding = Object.freeze({
      opaqueId: account.view.opaqueId, epoch, auth, retireSignal: signal,
      assertCurrent: () => {
        this.assertOwner()
        if (signal.aborted || this.epoch !== epoch || this.selected !== account.view.opaqueId) {
          throw new LlmError('Codex account epoch was retired', 'STALE_CODEX_ACCOUNT')
        }
      },
    })
  }

  /** Retire the previous binding, then commit the explicitly selected account.
   * @param id - human-selected account.
   * @param expectedEpoch - optional committed selection epoch; native commands supply it.
   * @returns after previous SDK/auth work drains and selection commits.
   */
  select(id: CodexAccountId, expectedEpoch?: number): Promise<void> {
    return this.enqueue(async () => {
      this.assertOwner()
      this.guard(expectedEpoch)
      const account = this.accounts.get(id)
      if (account === undefined || account.tombstone !== 0) {
        throw new LlmError('Codex account is absent or tombstoned', 'UNKNOWN_CODEX_ACCOUNT')
      }
      await this.retireSelected()
      await this.commit(this.manifest(id))
      this.selected = id
      this.bind(account)
    })
  }

  /** Retire and forget one local account without selecting a replacement.
   * @param id - account to forget locally.
   * @param expectedEpoch - optional committed selection epoch; native commands supply it.
   * @returns after SDK/auth work drains and local deletion completes, without issuer revocation.
   */
  signOut(id: CodexAccountId, expectedEpoch?: number): Promise<void> {
    return this.enqueue(async () => {
      this.assertOwner()
      this.guard(expectedEpoch)
      const account = this.accounts.get(id)
      if (account === undefined) return
      account.tombstone++
      const selected = this.selected === id
      if (selected) await this.retireSelected()
      await this.drainAccount(account)
      const manifest = this.manifest(selected ? null : this.selected)
      await this.commit({ ...manifest, accounts: manifest.accounts.filter(view => view.opaqueId !== id) })
      this.accounts.delete(id)
      if (selected) this.selected = null
      await this.options.records.deleteRecord(account.key)
    })
  }

  /** Cancel sign-in and forget managed accounts without modifying legacy grants.
   * @param expectedEpoch - optional committed selection epoch; native commands supply it.
   * @returns after SDK/auth drainage, local deletion and staging cleanup, without issuer revocation.
   */
  signOutAll(expectedEpoch?: number): Promise<void> {
    this.assertOwner()
    this.guard(expectedEpoch)
    if (this.clearing !== undefined) return this.clearing
    let cancellation: Promise<void> | undefined
    const transition = this.enqueue(async () => {
      this.assertOwner()
      this.guard(expectedEpoch)
      // Abort only after the queued epoch guard; join login after releasing the transition.
      cancellation = this.cancelLogin()
      const accounts = [...this.accounts.values()]
      for (const account of accounts) account.tombstone++
      await this.retireSelected()
      await Promise.all(accounts.map(account => this.drainAccount(account)))
      await this.commit({ accounts: [], selected: null, epoch: this.epoch })
      this.accounts.clear()
      this.selected = null
      const deletions = await Promise.allSettled(accounts.map(account => this.options.records.deleteRecord(account.key)))
      const failures = deletions.filter(result => result.status === 'rejected').map((result): unknown => result.reason)
      if (failures.length > 0) throw new AggregateError(failures, 'Codex account grant deletion failed')
    })
    const done = (async () => {
      try { await transition }
      finally { await cancellation }
    })()
    this.clearing = done
    void done.finally(() => { if (this.clearing === done) this.clearing = undefined }).catch(() => {
      // The initiating caller owns deletion errors.
    })
    return done
  }

  /**
   * Private same-process observer capability; never a Remote service method.
   * @param force - refresh under the same account-key lock after unauthorized rejection.
   * @returns bearer material for the exact selected account epoch.
   */
  observerTokenExport(force = false): Promise<CodexObserverToken> {
    const binding = this.captureBinding()
    const account = this.accounts.get(binding.opaqueId)
    if (account === undefined) throw new LlmError('Selected Codex account is absent', 'UNKNOWN_CODEX_ACCOUNT')
    return this.track(account, (async () => {
      const result = await codexObserverToken(this.options.provider, binding.auth, binding.retireSignal, force)
      binding.assertCurrent()
      return result
    })())
  }

  /** Refresh the selected epoch after an observer's unauthorized rejection.
   * @returns a freshly rotated token for that same selected epoch.
   */
  forcedRefresh(): Promise<CodexObserverToken> { return this.observerTokenExport(true) }

  /** Stop admission and drain login, selection, SDK and auth work without deleting grants.
   * @returns after login, transition, SDK and underlying auth operations settle.
   */
  dispose(): Promise<void> {
    if (this.disposal !== undefined) return this.disposal
    this.disposed = true
    const retirement = this.retireSelected()
    this.disposal = Promise.allSettled([retirement, this.cancelLogin(), this.transition]).then(async (results) => {
      await Promise.all([...this.accounts.values()].map(account => this.drainAccount(account)))
      const failures = results.filter(result => result.status === 'rejected').map((result): unknown => result.reason)
      if (failures.length > 0) throw new AggregateError(failures, 'Codex account owner disposal failed')
    })
    return this.disposal
  }
}
