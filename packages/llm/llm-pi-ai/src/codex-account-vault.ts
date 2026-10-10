/** Private crash-durable Codex grant storage with one lifetime POSIX flock owner. */
import { randomUUID } from 'node:crypto'
import { constants, fstatSync, lstatSync } from 'node:fs'
import type { Stats } from 'node:fs'
import { inspect } from 'node:util'
import { lstat, mkdir, open, readdir, realpath, rename, unlink } from 'node:fs/promises'
import type { FileHandle } from 'node:fs/promises'
import { dirname, isAbsolute, join, normalize } from 'node:path'
import { tryLockExclusive } from '@deepseek-ai/node-addon-system/flock'
import { brandString } from '@deepseek-ai/dsh-brand'
import { credentialKey, credentialKeyId, credentialKeyScope } from '@deepseek-ai/dsh-credentials'
import type { CredentialKey, CredentialRecord } from '@deepseek-ai/dsh-credentials'
import { LlmError } from '@deepseek-ai/dsh-llm'
import type { CodexAccountId } from './account-binding.ts'
import type { CodexAccountManifest } from './codex-account-owner.ts'
import type { CodexModelAccount } from './codex-accounts.ts'
import type { CodexRecordStore } from './codex-grant.ts'

const SCOPE = 'llm-pi-ai-codex-accounts'
const ACCOUNT_ID = /^account-[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/
const MAX_BYTES = 16 * 1024 * 1024
const MAX_ACCOUNTS = 128
const MAX_RECORDS = 256
const FILE = 'accounts.v1.json'
const LOCK = 'owner.lock'

/** Versioned private file; SDK OAuth payload members remain opaque JSON. */
export interface CodexAccountVaultDocument {
  readonly version: 1
  readonly manifest: CodexAccountManifest
  readonly records: readonly { readonly key: CredentialKey; readonly record: CredentialRecord }[]
}

const failure = (code: string): LlmError => new LlmError('Codex account vault is unavailable', code)
const object = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)
const exact = (value: Record<string, unknown>, names: readonly string[]): boolean =>
  Object.keys(value).length === names.length && names.every(name => Object.hasOwn(value, name))
const validLabel = (value: unknown): value is string => typeof value === 'string' && Buffer.byteLength(value) <= 512
  && value.trim().length > 0 && Array.from(value).length <= 128 && !/[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}]/u.test(value)

function accountId(value: unknown): CodexAccountId {
  if (typeof value !== 'string' || !ACCOUNT_ID.test(value)) throw failure('INVALID_CODEX_VAULT')
  return brandString<CodexAccountId>(value)
}

function parseManifest(value: unknown): CodexAccountManifest {
  if (!object(value) || !exact(value, ['accounts', 'selected', 'epoch']) || !Array.isArray(value.accounts)
    || value.accounts.length > MAX_ACCOUNTS || !Number.isSafeInteger(value.epoch) || typeof value.epoch !== 'number'
    || value.epoch < 0 || value.epoch >= Number.MAX_SAFE_INTEGER) throw failure('INVALID_CODEX_VAULT')
  const ids = new Set<CodexAccountId>()
  const accounts: CodexModelAccount[] = value.accounts.map((entry: unknown) => {
    if (!object(entry) || !exact(entry, ['opaqueId', 'label', 'email', 'plan']) || !validLabel(entry.label)
      || entry.email !== null || entry.plan !== null) throw failure('INVALID_CODEX_VAULT')
    const opaqueId = accountId(entry.opaqueId)
    if (ids.has(opaqueId)) throw failure('INVALID_CODEX_VAULT')
    ids.add(opaqueId)
    return { opaqueId, label: entry.label, email: null, plan: null }
  })
  const selected = value.selected === null ? null : accountId(value.selected)
  if (selected !== null && !ids.has(selected)) throw failure('INVALID_CODEX_VAULT')
  return { accounts, selected, epoch: value.epoch }
}

function parseRecord(value: unknown): CredentialRecord {
  if (!object(value) || !exact(value, ['kind', 'payload']) || value.kind !== 'grant' || !object(value.payload)) throw failure('INVALID_CODEX_VAULT')
  const payload = value.payload
  if (payload.type !== 'oauth' || typeof payload.access !== 'string' || payload.access.length === 0
    || typeof payload.refresh !== 'string' || payload.refresh.length === 0 || typeof payload.accountId !== 'string'
    || payload.accountId.length === 0 || typeof payload.expires !== 'number' || !Number.isFinite(payload.expires)) throw failure('INVALID_CODEX_VAULT')
  return { kind: 'grant', payload }
}

function keyFor(id: CodexAccountId): CredentialKey { return credentialKey(SCOPE, id) }
function validateKey(key: CredentialKey): void {
  if (credentialKeyScope(key) !== SCOPE) throw failure('INVALID_CODEX_VAULT_KEY')
  accountId(credentialKeyId(key))
}

function parseDocument(value: unknown): CodexAccountVaultDocument {
  if (!object(value) || !exact(value, ['version', 'manifest', 'records']) || value.version !== 1
    || !Array.isArray(value.records) || value.records.length > MAX_RECORDS) throw failure('INVALID_CODEX_VAULT')
  const manifest = parseManifest(value.manifest)
  const keys = new Set<CredentialKey>()
  const records = value.records.map((entry: unknown) => {
    if (!object(entry) || !exact(entry, ['key', 'record']) || typeof entry.key !== 'string') throw failure('INVALID_CODEX_VAULT')
    const prefix = `${SCOPE}/`
    if (!entry.key.startsWith(prefix)) throw failure('INVALID_CODEX_VAULT')
    const key = keyFor(accountId(entry.key.slice(prefix.length)))
    if (keys.has(key)) throw failure('INVALID_CODEX_VAULT')
    keys.add(key)
    return { key, record: parseRecord(entry.record) }
  })
  if (manifest.accounts.some(account => !keys.has(keyFor(account.opaqueId)))) throw failure('INVALID_CODEX_VAULT')
  return { version: 1, manifest, records }
}

function identity(stat: Stats): string { return `${stat.dev}:${stat.ino}` }
function privateFile(stat: Stats, directory = false): void {
  if ((directory ? !stat.isDirectory() : !stat.isFile()) || (stat.mode & 0o077) !== 0
    || (process.getuid !== undefined && stat.uid !== process.getuid()) || (!directory && stat.nlink !== 1)) throw failure('INSECURE_CODEX_VAULT')
}

async function readDocument(directory: string): Promise<CodexAccountVaultDocument> {
  let file: FileHandle
  try { file = await open(join(directory, FILE), constants.O_RDONLY | constants.O_NOFOLLOW) }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { version: 1, manifest: { accounts: [], selected: null, epoch: 0 }, records: [] }
    throw failure('INVALID_CODEX_VAULT')
  }
  try {
    privateFile(fstatSync(file.fd))
    const chunks: Buffer[] = []
    let bytes = 0
    for (;;) {
      const buffer = Buffer.alloc(Math.min(64 * 1024, MAX_BYTES - bytes + 1))
      const { bytesRead } = await file.read(buffer, 0, buffer.length, null)
      if (bytesRead === 0) break
      bytes += bytesRead
      if (bytes > MAX_BYTES) throw failure('CODEX_VAULT_TOO_LARGE')
      chunks.push(buffer.subarray(0, bytesRead))
    }
    try { return parseDocument(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)))) }
    catch (error) {
      if (error instanceof LlmError) throw error
      throw failure('INVALID_CODEX_VAULT')
    }
  } finally { await file.close() }
}

/** Lifetime owner; release only after account, SDK, observer and refresh operations drain. */
export class CodexAccountVault {
  private queued: Promise<void> = Promise.resolve()
  private closing = false
  private poisoned = false
  private disposal: Promise<void> | undefined
  private document: CodexAccountVaultDocument
  private readonly rootIdentity: string
  private readonly lockIdentity: string
  private readonly ownership = new AbortController()

  /** Aborted synchronously when ownership is lost, a commit is uncertain or shutdown starts. */
  get ownershipSignal(): AbortSignal { return this.ownership.signal }

  /** @returns redacted diagnostics without private grants or paths. */
  [inspect.custom](): string { return 'CodexAccountVault([REDACTED])' }

  /** Serialize only the redacted vault marker.
   * @returns redacted JSON without private grants or paths.
   */
  toJSON(): string { return 'CodexAccountVault([REDACTED])' }

  /** Managed-only record operations; mutation callbacks hold the queue across refresh. */
  readonly records: CodexRecordStore = {
    readRecord: key => this.enqueue(() => {
      validateKey(key)
      const record = this.document.records.find(entry => entry.key === key)?.record
      return Promise.resolve(record === undefined ? undefined : structuredClone(record))
    }),
    modifyRecord: (key, mutate) => this.enqueue(async () => {
      validateKey(key)
      const previous = this.document.records.find(entry => entry.key === key)?.record
      const next = await mutate(previous === undefined ? undefined : structuredClone(previous))
      this.assertExclusive()
      if (next === undefined) return previous === undefined ? undefined : structuredClone(previous)
      const record = parseRecord(JSON.parse(JSON.stringify(next)))
      await this.commit({ ...this.document, records: [...this.document.records.filter(entry => entry.key !== key), { key, record }] })
      return structuredClone(record)
    }),
    deleteRecord: key => this.enqueue(async () => {
      validateKey(key)
      if (this.document.manifest.accounts.some(account => keyFor(account.opaqueId) === key)) throw failure('CODEX_ACCOUNT_STILL_COMMITTED')
      if (!this.document.records.some(entry => entry.key === key)) return
      await this.commit({ ...this.document, records: this.document.records.filter(entry => entry.key !== key) })
    }),
  }

  constructor(private readonly directory: string, private readonly root: FileHandle, private readonly lock: FileHandle,
    document: CodexAccountVaultDocument) {
    this.document = document
    this.rootIdentity = identity(fstatSync(root.fd))
    this.lockIdentity = identity(fstatSync(lock.fd))
  }

  /** Deny admission after lease replacement, shutdown or an indeterminate disk commit. */
  assertExclusive(): void {
    if (this.closing || this.poisoned) throw failure('CODEX_VAULT_CLOSED')
    try {
      const root = lstatSync(this.directory)
      const lock = lstatSync(join(this.directory, LOCK))
      privateFile(root, true)
      privateFile(lock)
      if (identity(root) !== this.rootIdentity || identity(lock) !== this.lockIdentity
        || identity(fstatSync(this.lock.fd)) !== this.lockIdentity) throw failure('CODEX_VAULT_OWNERSHIP_LOST')
    } catch (error) {
      this.poisoned = true
      this.ownership.abort('Codex vault ownership lost')
      if (error instanceof LlmError) throw error
      throw failure('CODEX_VAULT_OWNERSHIP_LOST')
    }
  }

  /** Read the committed account roster under current exclusive ownership.
   * @returns a detached committed public manifest, never SDK grants.
   */
  manifest(): CodexAccountManifest { this.assertExclusive(); return structuredClone(this.document.manifest) }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    this.assertExclusive()
    const next = this.queued.then(async () => { this.assertExclusive(); return operation() })
    this.queued = next.then(() => {}, (_error: unknown) => { /* The initiating caller receives its failure. */ })
    return next
  }

  /** Remove forgotten committed grants in the same durable commit; retain active staging grants.
   * @param manifest - next account roster and explicit selection.
   * @returns after file and containing directory fsync.
   */
  commitManifest(manifest: CodexAccountManifest): Promise<void> {
    return this.enqueue(async () => {
      const next = parseManifest(manifest)
      if (next.epoch < this.document.manifest.epoch) throw failure('STALE_CODEX_ACCOUNT_EPOCH')
      const retained = new Set(next.accounts.map(account => account.opaqueId))
      const removed = new Set(this.document.manifest.accounts
        .filter(account => !retained.has(account.opaqueId)).map(account => keyFor(account.opaqueId)))
      await this.commit({ version: 1, manifest: next, records: this.document.records.filter(entry => !removed.has(entry.key)) })
    })
  }

  private async commit(candidate: CodexAccountVaultDocument): Promise<void> {
    const next = parseDocument(candidate)
    const bytes = JSON.stringify(next) + '\n'
    if (Buffer.byteLength(bytes) > MAX_BYTES) throw failure('CODEX_VAULT_TOO_LARGE')
    this.assertExclusive()
    const temp = join(this.directory, `.accounts-${randomUUID()}.tmp`)
    let file: FileHandle | undefined
    let renamed = false
    let created = false
    try {
      file = await open(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
      created = true
      await file.writeFile(bytes, 'utf8')
      await file.sync()
      await file.close()
      file = undefined
      this.assertExclusive()
      await rename(temp, join(this.directory, FILE))
      renamed = true
      await this.root.sync()
      this.assertExclusive()
      this.document = next
    } catch (_error) {
      this.poisoned = true
      this.ownership.abort('Codex vault commit indeterminate')
      throw failure('CODEX_VAULT_COMMIT_INDETERMINATE')
    } finally {
      await file?.close()
      if (created && !renamed) await unlink(temp).catch((error: unknown) => {
        // Failed exclusive creation owns no temp; cleanup never removes another inode.
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw failure('CODEX_VAULT_CLEANUP_FAILED')
      })
    }
  }

  /** Close admission and release exclusive ownership after queued storage settles.
   * @returns after queued storage operations settle and the stable lock descriptor closes.
   */
  dispose(): Promise<void> {
    if (this.disposal !== undefined) return this.disposal
    this.closing = true
    this.ownership.abort('Codex vault closing')
    this.disposal = this.queued.then(async () => {
      try { await this.lock.close() } finally { await this.root.close() }
    })
    return this.disposal
  }

  /** Drop uncommitted crash staging before any account or login is admitted.
   * @returns after orphan removal is durable.
   */
  async recoverStaging(): Promise<void> {
    const keys = new Set(this.document.manifest.accounts.map(account => keyFor(account.opaqueId)))
    const records = this.document.records.filter(entry => keys.has(entry.key))
    if (records.length !== this.document.records.length) await this.commit({ ...this.document, records })
    for (const name of await readdir(this.directory)) {
      if (!/^\.accounts-[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}\.tmp$/.test(name)) continue
      this.assertExclusive()
      const path = join(this.directory, name)
      privateFile(await lstat(path))
      await unlink(path)
    }
    await this.root.sync()
  }
}

/** Acquire an inert, private managed-account vault; no OAuth, observer or provider I/O.
 * @param directory - canonical absolute private directory; aliases and unsafe permissions are refused.
 * @returns the exclusive owner with validated state and crash staging removed.
 */
export async function openCodexAccountVault(directory: string): Promise<CodexAccountVault> {
  if (!isAbsolute(directory) || normalize(directory) !== directory || directory.length > 4096
    || /[\x00-\x1f\x7f]/.test(directory) || !['linux', 'darwin'].includes(process.platform)) throw failure('INVALID_CODEX_VAULT_PATH')
  await mkdir(directory, { recursive: true, mode: 0o700 })
  if (await realpath(directory) !== directory) throw failure('INVALID_CODEX_VAULT_PATH')
  const parent = await open(dirname(directory), constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
  try { await parent.sync() } finally { await parent.close() }
  const root = await open(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
  let lock: FileHandle | undefined
  try {
    privateFile(fstatSync(root.fd), true)
    lock = await open(join(directory, LOCK), constants.O_RDWR | constants.O_CREAT | constants.O_NOFOLLOW, 0o600)
    privateFile(fstatSync(lock.fd))
    await tryLockExclusive(lock.fd)
    await root.sync()
    const vault = new CodexAccountVault(directory, root, lock, await readDocument(directory))
    vault.assertExclusive()
    await vault.recoverStaging()
    return vault
  } catch (_error) {
    try { await lock?.close() } finally { await root.close() }
    throw failure('CODEX_VAULT_ACQUISITION_FAILED')
  }
}
