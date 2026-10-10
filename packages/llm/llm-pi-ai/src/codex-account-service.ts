/** Root-scoped, refcounted managed-account lifecycle for adapter Loader fibers. */
import type { Context, Fiber } from '@deepseek-ai/cordis'
import { LlmError } from '@deepseek-ai/dsh-llm'
import { catalogProvider } from './catalog.ts'
import { recordKeyFor } from './auth.ts'
import { CodexAccounts, type CodexAccountLogin } from './codex-accounts.ts'
import type { CodexAccountId, PiAiAccountBinding } from './account-binding.ts'
import { CodexAccountOwner } from './codex-account-owner.ts'
import { openCodexAccountVault } from './codex-account-vault.ts'
import type { PiAiAdapter, PiAiAuthInjection } from './adapter.ts'

class ManagedCodexAccounts extends CodexAccounts {
  constructor(ctx: Context, private readonly owner: CodexAccountOwner) { super(ctx) }
  toJSON(): string { return 'CodexAccounts([REDACTED])' }
  [Symbol.for('nodejs.util.inspect.custom')](): string { return this.toJSON() }
  describe() { return this.owner.describe() }
  beginLogin(request: CodexAccountLogin) { return this.owner.beginLogin(request) }
  cancelLogin() { return this.owner.cancelLogin() }
  select(id: CodexAccountId, expectedEpoch?: number) { return this.owner.select(id, expectedEpoch) }
  signOut(id: CodexAccountId, expectedEpoch?: number) { return this.owner.signOut(id, expectedEpoch) }
  signOutAll(expectedEpoch?: number) { return this.owner.signOutAll(expectedEpoch) }
}

interface SharedOwner {
  readonly owner: CodexAccountOwner
  readonly adapters: Set<PiAiAdapter>
  readonly fiber: Fiber
  shutdown(): Promise<void>
}
interface OwnerEntry {
  readonly directory: string
  readonly task: Promise<SharedOwner>
  users: number
  closing?: Promise<void>
}
// The symbol survives module replacement; its value belongs only to this application root.
const OWNER_REGISTRY = Symbol.for('dsh.llm-pi-ai.codex-owner-registry.v1')
interface RootOwnerRegistry {
  readonly version: 1
  entry: OwnerEntry | undefined
  disposed: boolean
  toJSON(): string
}

function rootRegistry(root: Context): RootOwnerRegistry {
  // Private same-process metadata is shared by compatible HMR copies, never parsed from user input.
  const existing: RootOwnerRegistry | undefined = Reflect.get(root, OWNER_REGISTRY)
  if (existing !== undefined) {
    if (existing.version !== 1 || existing.disposed) throw new LlmError('Codex owner registry is unavailable', 'CODEX_OWNER_REGISTRY_CLOSED')
    return existing
  }
  const registry: RootOwnerRegistry = { version: 1, entry: undefined, disposed: false,
    toJSON: () => 'CodexOwnerRegistry([REDACTED])',
    [Symbol.for('nodejs.util.inspect.custom')]: () => 'CodexOwnerRegistry([REDACTED])',
  }
  root.effect(function* () {
    Object.defineProperty(root, OWNER_REGISTRY, { value: registry, configurable: true })
    yield async () => {
      registry.disposed = true
      try {
        const shared = await registry.entry?.task
        await shared?.fiber.dispose()
      } finally {
        registry.entry = undefined
        Reflect.deleteProperty(root, OWNER_REGISTRY)
      }
    }
  })
  return registry
}

/** Private adapter attachment; no credential capability is added to the public service. */
export interface CodexAccountAttachment {
  /** @returns the immutable selected epoch, rejecting absent or retired selection. */
  captureBinding(): PiAiAccountBinding
  /** @param adapter - the single adapter whose terminal work this attachment owns. */
  attach(adapter: PiAiAdapter): void
  /** @returns after adapter drainage and, for the last attachment, root-owner/vault release. */
  release(): Promise<void>
}

async function createOwner(root: Context, directory: string, auth: PiAiAuthInjection): Promise<SharedOwner> {
  if (root.get('codexAccounts') !== undefined) {
    throw new LlmError('A Codex account service already owns this application', 'DUPLICATE_CODEX_OWNER')
  }
  const provider = catalogProvider('openai-codex')
  if (provider?.auth.oauth === undefined) throw new LlmError('Codex OAuth is unavailable', 'CODEX_OAUTH_UNAVAILABLE')
  const vault = await openCodexAccountVault(directory)
  const adapters = new Set<PiAiAdapter>()
  const owner = new CodexAccountOwner({
    records: vault.records,
    legacyPresent: async () => (await root.get('credentials')?.describeRecord(recordKeyFor('openai-codex')))?.configured === true,
    auth, provider,
    assertExclusive: () => vault.assertExclusive(),
    ownershipSignal: vault.ownershipSignal,
    commitManifest: manifest => vault.commitManifest(manifest),
    retireBinding: async (binding) => {
      const results = await Promise.allSettled([...adapters].map(adapter => adapter.retireAccountBinding(binding)))
      const failures = results.filter(result => result.status === 'rejected').map((result): unknown => result.reason)
      if (failures.length > 0) throw new AggregateError(failures, 'Codex adapter retirement failed')
    },
  })
  let shutdown: Promise<void> | undefined
  const drain = (): Promise<void> => shutdown ??= (async () => {
    const results = await Promise.allSettled([owner.dispose(), ...[...adapters].map(adapter => adapter.dispose())])
    const failures = results.filter(result => result.status === 'rejected').map((result): unknown => result.reason)
    try { await vault.dispose() } catch (error) { failures.push(error) }
    if (failures.length > 0) throw new AggregateError(failures, 'Codex account service disposal failed')
  })()
  try {
    await owner.restore(vault.manifest())
    const fiber = (await root.plugin(ManagedCodexAccounts, owner)).ctx.fiber
    fiber.ctx.effect(() => drain)
    return { owner, adapters, fiber, shutdown: drain }
  } catch (error) {
    await drain()
    throw error
  }
}

/**
 * Acquire one root owner without sharing a vault across independent applications.
 * @param ctx - adapter context; account service is mounted at its application root.
 * @param directory - exact canonical private vault directory.
 * @param auth - legacy authentication for other providers only.
 * @returns a refcounted attachment whose release must follow adapter drainage.
 */
export async function acquireCodexAccountOwner(
  ctx: Context, directory: string, auth: PiAiAuthInjection,
): Promise<CodexAccountAttachment> {
  const root = ctx.root
  const registry = rootRegistry(root)
  let entry = registry.entry
  if (entry?.closing !== undefined) {
    await entry.closing
    return acquireCodexAccountOwner(ctx, directory, auth)
  }
  if (entry !== undefined && entry.directory !== directory) {
    throw new LlmError('One application cannot own different Codex vaults', 'CODEX_VAULT_CONFLICT')
  }
  if (entry === undefined) {
    entry = { directory, task: createOwner(root, directory, auth), users: 0 }
    registry.entry = entry
  }
  const current = entry
  current.users++
  let shared: SharedOwner
  try { shared = await current.task }
  catch (error) {
    if (--current.users === 0 && registry.entry === current) registry.entry = undefined
    throw error
  }
  let attached: PiAiAdapter | undefined
  let released: Promise<void> | undefined
  return {
    captureBinding: () => shared.owner.captureBinding(),
    attach(adapter) {
      if (attached !== undefined || released !== undefined) throw new LlmError('Codex adapter attachment already used', 'CODEX_ATTACHMENT_USED')
      attached = adapter
      shared.adapters.add(adapter)
    },
    release() {
      return released ??= (async () => {
        try { await attached?.dispose() }
        finally {
          if (attached !== undefined) shared.adapters.delete(attached)
          if (--current.users === 0) {
            current.closing = shared.fiber.dispose()
            try { await current.closing }
            finally { if (registry.entry === current) registry.entry = undefined }
          }
        }
      })()
    },
  }
}
