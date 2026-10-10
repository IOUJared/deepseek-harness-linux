/** Real POSIX ownership and durable PUBLIC grant transactions; no sign-in or network. */
import { randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { once } from 'node:events'
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'
import { brandString } from '@deepseek-ai/dsh-brand'
import { credentialKey } from '@deepseek-ai/dsh-credentials'
import type { CredentialRecord } from '@deepseek-ai/dsh-credentials'
import type { CodexAccountId } from '../src/account-binding.ts'
import type { CodexModelAccount } from '../src/codex-accounts.ts'
import { openCodexAccountVault } from '../src/codex-account-vault.ts'
import type { CodexAccountVault } from '../src/codex-account-vault.ts'
import { deferred, publicGrant } from './codex-account-fixture.ts'

const roots: string[] = []
const vaults: CodexAccountVault[] = []
afterEach(async () => {
  await Promise.all(vaults.splice(0).map(vault => vault.dispose()))
  await Promise.all(roots.splice(0).map(directory => rm(directory, { recursive: true, force: true })))
})
async function directory(): Promise<string> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'dsh-public-codex-vault-')))
  roots.push(root)
  return root
}
async function acquire(root = ''): Promise<{ root: string; vault: CodexAccountVault }> {
  root ||= await directory()
  const vault = await openCodexAccountVault(root)
  vaults.push(vault)
  return { root, vault }
}
function account(label = 'PUBLIC account'): CodexModelAccount {
  return { opaqueId: brandString<CodexAccountId>(`account-${randomUUID()}`), label, email: null, plan: null }
}
const key = (value: CodexModelAccount) => credentialKey('llm-pi-ai-codex-accounts', value.opaqueId)
const record = (id = 'first'): CredentialRecord => ({ kind: 'grant', payload: publicGrant(id) })
async function stage(vault: CodexAccountVault, value: CodexModelAccount, id = 'first'): Promise<void> {
  await vault.records.modifyRecord(key(value), async () => record(id))
}
async function document(root: string): Promise<{ records: unknown[]; manifest: unknown }> {
  return JSON.parse(await readFile(join(root, 'accounts.v1.json'), 'utf8')) as { records: unknown[]; manifest: unknown }
}

describe.skipIf(!['linux', 'darwin'].includes(process.platform))('private Codex account vault', () => {
  it('owns one stable lock inode, refuses live contenders and releases only on dispose', async () => {
    const { root, vault } = await acquire()
    const inode = (await stat(join(root, 'owner.lock'))).ino
    await expect(openCodexAccountVault(root)).rejects.toThrow('Codex account vault is unavailable')
    vault.assertExclusive()
    await vault.dispose()
    expect((await stat(join(root, 'owner.lock'))).ino).toBe(inode)
    const next = await acquire(root)
    expect(next.vault.manifest()).toEqual({ accounts: [], selected: null, epoch: 0 })
    expect((await stat(join(root, 'owner.lock'))).ino).toBe(inode)
  })

  it('excludes an independent process and permits takeover only after that process exits', async () => {
    const root = await directory()
    const addon = pathToFileURL(createRequire(import.meta.url).resolve('@deepseek-ai/node-addon-system/flock')).href
    const script = `import {open,constants} from 'node:fs/promises';
import {tryLockExclusive} from ${JSON.stringify(addon)};
const file=await open(process.argv[1],constants.O_RDWR|constants.O_CREAT|constants.O_NOFOLLOW,0o600);
await tryLockExclusive(file.fd); process.stdout.write('READY\\n'); process.stdin.resume();`
    const child = spawn(process.execPath, ['--input-type=module', '-e', script, join(root, 'owner.lock')], {
      stdio: ['pipe', 'pipe', 'pipe'], env: { PATH: '/usr/bin:/bin' },
    })
    const exited = once(child, 'exit')
    try {
      const ready = await Promise.race([once(child.stdout, 'data'), exited.then(() => { throw new Error('PUBLIC lock fixture exited') })])
      expect(String(ready[0])).toBe('READY\n')
      await expect(openCodexAccountVault(root)).rejects.toThrow()
      child.kill('SIGKILL')
      await exited
      expect((await acquire(root)).vault.manifest().selected).toBeNull()
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
      await exited
      child.stdin.destroy()
      child.stdout.destroy()
      child.stderr.destroy()
    }
  })

  it('commits public metadata and opaque SDK extras, restores exact selection without adoption', async () => {
    const { root, vault } = await acquire()
    const first = account()
    await stage(vault, first)
    await vault.commitManifest({ accounts: [first], selected: first.opaqueId, epoch: 7 })
    const captured = vault.manifest()
    expect(captured).toEqual({ accounts: [first], selected: first.opaqueId, epoch: 7 })
    expect(JSON.stringify(captured)).not.toContain('PUBLIC-access')
    expect((await stat(join(root, 'accounts.v1.json'))).mode & 0o777).toBe(0o600)
    expect((await stat(root)).mode & 0o777).toBe(0o700)
    const stored = await vault.records.readRecord(key(first))
    expect(stored).toMatchObject({ kind: 'grant', payload: { extra: { untouched: ['PUBLIC-extra', null] } } })
    await vault.dispose()
    const reopened = (await acquire(root)).vault
    expect(reopened.manifest()).toEqual(captured)
    expect(await reopened.records.readRecord(key(first))).toEqual(stored)
  })

  it('forgets grant and manifest atomically while preserving another active staging Add', async () => {
    const { root, vault } = await acquire()
    const first = account('PUBLIC first')
    const pending = account('PUBLIC staged')
    await stage(vault, first)
    await vault.commitManifest({ accounts: [first], selected: first.opaqueId, epoch: 1 })
    await stage(vault, pending, 'pending')
    await vault.commitManifest({ accounts: [], selected: null, epoch: 2 })
    expect(await vault.records.readRecord(key(first))).toBeUndefined()
    expect(await vault.records.readRecord(key(pending))).toBeDefined()
    const saved = await readFile(join(root, 'accounts.v1.json'), 'utf8')
    expect(saved).not.toContain('PUBLIC-access-first')
    expect(saved).toContain('PUBLIC-access-pending')
    await vault.records.deleteRecord(key(first))
    await vault.dispose()
    const reopened = (await acquire(root)).vault
    expect(await reopened.records.readRecord(key(first))).toBeUndefined()
    expect(await reopened.records.readRecord(key(pending))).toBeUndefined()
    expect((await document(root)).records).toEqual([])
  })

  it('serializes refresh against selection commits and preserves undefined mutation as unchanged', async () => {
    const { vault } = await acquire()
    const first = account()
    await stage(vault, first)
    await vault.commitManifest({ accounts: [first], selected: first.opaqueId, epoch: 1 })
    const entered = deferred<undefined>()
    const release = deferred<undefined>()
    const refresh = vault.records.modifyRecord(key(first), async () => {
      entered.resolve(undefined)
      await release.promise
      return record('rotated')
    })
    await entered.promise
    const removal = vault.commitManifest({ accounts: [], selected: null, epoch: 2 })
    expect(vault.manifest().selected).toBe(first.opaqueId)
    release.resolve(undefined)
    await refresh
    await removal
    expect(await vault.records.modifyRecord(key(first), async () => undefined)).toBeUndefined()
    expect(await vault.records.readRecord(key(first))).toBeUndefined()
  })

  it('rejects missing referenced grants, stale epochs and deleting still-committed accounts', async () => {
    const { vault } = await acquire()
    const first = account()
    await expect(vault.commitManifest({ accounts: [first], selected: first.opaqueId, epoch: 1 })).rejects.toMatchObject({ code: 'INVALID_CODEX_VAULT' })
    await stage(vault, first)
    await vault.commitManifest({ accounts: [first], selected: first.opaqueId, epoch: 3 })
    await expect(vault.records.deleteRecord(key(first))).rejects.toMatchObject({ code: 'CODEX_ACCOUNT_STILL_COMMITTED' })
    await expect(vault.commitManifest({ accounts: [first], selected: first.opaqueId, epoch: 2 })).rejects.toMatchObject({ code: 'STALE_CODEX_ACCOUNT_EPOCH' })
    expect(vault.manifest().selected).toBe(first.opaqueId)
  })

  it('drains a held refresh before closing its lifetime lock and rejects late write after shutdown', async () => {
    const { root, vault } = await acquire()
    const first = account()
    const entered = deferred<undefined>()
    const release = deferred<undefined>()
    const mutation = vault.records.modifyRecord(key(first), async () => {
      entered.resolve(undefined)
      await release.promise
      return record()
    }).catch((error: unknown) => error)
    await entered.promise
    let disposed = false
    const disposal = vault.dispose().then(() => { disposed = true })
    await expect(openCodexAccountVault(root)).rejects.toThrow()
    expect(disposed).toBe(false)
    release.resolve(undefined)
    expect(await mutation).toMatchObject({ code: 'CODEX_VAULT_CLOSED' })
    await disposal
    expect(disposed).toBe(true)
    expect((await acquire(root)).vault.manifest().accounts).toEqual([])
  })

  it('fails closed when the stable lock inode is replaced', async () => {
    const { root, vault } = await acquire()
    await unlink(join(root, 'owner.lock'))
    await writeFile(join(root, 'owner.lock'), '', { mode: 0o600, flag: 'wx' })
    expect(() => { vault.assertExclusive() }).toThrow(expect.objectContaining({ code: 'CODEX_VAULT_OWNERSHIP_LOST' }))
    expect(() => vault.manifest()).toThrow()
  })

  it('poisons admission after an indeterminate disk failure instead of retrying a mutation', async () => {
    const { root, vault } = await acquire()
    await mkdir(join(root, 'accounts.v1.json'), { mode: 0o700 })
    await expect(stage(vault, account())).rejects.toMatchObject({ code: 'CODEX_VAULT_COMMIT_INDETERMINATE' })
    expect(() => vault.manifest()).toThrow(expect.objectContaining({ code: 'CODEX_VAULT_CLOSED' }))
  })

  it('removes only private crash-temp files and redacts grant-bearing object diagnostics', async () => {
    const root = await directory()
    const temp = join(root, `.accounts-${randomUUID()}.tmp`)
    const retained = join(root, 'unrelated.txt')
    await writeFile(temp, 'PUBLIC-old-private-grant', { mode: 0o600 })
    await writeFile(retained, 'PUBLIC-unrelated', { mode: 0o600 })
    const { vault } = await acquire(root)
    await expect(stat(temp)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await readFile(retained, 'utf8')).toBe('PUBLIC-unrelated')
    await stage(vault, account())
    expect(JSON.stringify(vault)).toBe('"CodexAccountVault([REDACTED])"')
  })

  it('refuses symlink aliases and insecure directories/files', async () => {
    const root = await directory()
    const alias = join(root, 'alias')
    await symlink(root, alias)
    await expect(openCodexAccountVault(alias)).rejects.toThrow()
    await chmod(root, 0o755)
    await expect(openCodexAccountVault(root)).rejects.toThrow()
    await chmod(root, 0o700)
    await writeFile(join(root, 'owner.lock'), '', { mode: 0o600 })
    await chmod(join(root, 'owner.lock'), 0o644)
    await expect(openCodexAccountVault(root)).rejects.toThrow()
  })

  it.each([
    '{',
    JSON.stringify({ version: 2, manifest: { accounts: [], selected: null, epoch: 0 }, records: [] }),
    JSON.stringify({ version: 1, manifest: { accounts: [], selected: 'account-not-an-id', epoch: 0 }, records: [] }),
  ])('rejects corrupt/foreign persisted state without rewriting it', async (value) => {
    const root = await directory()
    const file = join(root, 'accounts.v1.json')
    await writeFile(file, value, { mode: 0o600 })
    await expect(openCodexAccountVault(root)).rejects.toThrow()
    expect(await readFile(file, 'utf8')).toBe(value)
  })
})
