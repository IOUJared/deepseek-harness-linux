/** Account staging, retirement, refresh and token projection with public fakes only. */
import { describe, expect, it, vi } from 'vitest'
import { credentialKey } from '@deepseek-ai/dsh-credentials'
import { CodexAccountOwner } from '../src/codex-account-owner.ts'
import type { PiAiAccountBinding } from '../src/account-binding.ts'
import type { CredentialRecord } from '@deepseek-ai/dsh-credentials'

function grantPayload(record: CredentialRecord | undefined): unknown {
  return record?.kind === 'grant' ? record.payload : undefined
}
import { codexBoundStore } from '../src/codex-grant.ts'
import { memoryAuth } from './auth-double.ts'
import { deferred, interaction, oauthFixture, publicGrant, recordFixture } from './codex-account-fixture.ts'

function fixture() {
  const records = recordFixture()
  const oauth = oauthFixture()
  const commitManifest = vi.fn(async () => {})
  const retireBinding = vi.fn<(binding: PiAiAccountBinding) => Promise<void>>(async () => {})
  const assertExclusive = vi.fn(() => {})
  const legacyKey = credentialKey('llm-pi-ai', 'openai-codex')
  records.values.set(legacyKey, { kind: 'grant', payload: publicGrant('legacy') })
  const ownership = new AbortController()
  const options = { records, auth: memoryAuth(), provider: oauth.provider, ownershipSignal: ownership.signal,
    legacyPresent: () => Promise.resolve(records.values.has(legacyKey)),
    assertExclusive, commitManifest, retireBinding }
  const owner = new CodexAccountOwner(options)
  return { owner, records, oauth, legacyKey, commitManifest, retireBinding, assertExclusive, ownership,
    restart: () => new CodexAccountOwner(options) }
}

async function add(owner: CodexAccountOwner, label = 'PUBLIC account') {
  return (await owner.beginLogin({ label, interaction })).account
}

describe('Codex account owner foundation', () => {
  it('adds fresh immutable keys, preserves opaque grants and leaves legacy and selection untouched', async () => {
    const { owner, records, oauth, legacyKey } = fixture()
    const original = publicGrant('first')
    oauth.login.mockResolvedValue(original)
    const first = await add(owner, 'PUBLIC first')
    const second = await add(owner, 'PUBLIC second')
    expect(first.opaqueId).toMatch(/^account-[a-f0-9-]+$/)
    expect(second.opaqueId).not.toBe(first.opaqueId)
    expect(records.values.size).toBe(3)
    expect(records.values.get(legacyKey)).toMatchObject({ kind: 'grant', payload: { access: 'PUBLIC-access-legacy' } })
    const managed = [...records.values].filter(([key]) => key !== legacyKey)
    expect(managed.map(([, record]) => grantPayload(record))).toEqual([original, original])
    expect((await owner.describe())).toEqual({ accounts: [first, second], selected: null, epoch: 0, legacy: 'unadopted' })
    expect(first).toMatchObject({ email: null, plan: null })
    expect(() => owner.captureBinding()).toThrow(expect.objectContaining({ code: 'NO_CODEX_ACCOUNT' }))
    await owner.signOutAll()
    expect([...records.values.keys()]).toEqual([legacyKey])
  })

  it('aborts and retires an epoch before drain, publishes selection only after terminal drain', async () => {
    const { owner, retireBinding, commitManifest } = fixture()
    const first = await add(owner)
    const second = await add(owner)
    await owner.select(first.opaqueId)
    const bound = owner.captureBinding()
    const gate = deferred<undefined>()
    retireBinding.mockImplementation(async (binding) => {
      expect(binding.retireSignal.aborted).toBe(true)
      expect(() => { binding.assertCurrent() }).toThrow(expect.objectContaining({ code: 'STALE_CODEX_ACCOUNT' }))
      await gate.promise
    })
    const commits = commitManifest.mock.calls.length
    const selection = owner.select(second.opaqueId)
    await vi.waitFor(() => { expect(bound.retireSignal.aborted).toBe(true) })
    expect(commitManifest.mock.calls).toHaveLength(commits)
    expect((await owner.describe()).selected).toBe(first.opaqueId)
    expect(() => owner.captureBinding()).toThrow(expect.objectContaining({ code: 'NO_CODEX_ACCOUNT' }))
    gate.resolve(undefined)
    await selection
    expect((await owner.describe()).selected).toBe(second.opaqueId)
    expect(owner.captureBinding().epoch).toBeGreaterThan(bound.epoch)
  })

  it('does not revive a deleted grant when a forced refresh settles late', async () => {
    const { owner, records, oauth, legacyKey } = fixture()
    const first = await add(owner)
    await owner.select(first.opaqueId)
    const entered = deferred<undefined>()
    const gate = deferred<ReturnType<typeof publicGrant>>()
    oauth.refresh.mockImplementation(async () => { entered.resolve(undefined); return gate.promise })
    const refresh = owner.observerTokenExport(true).catch((error: unknown) => error)
    await entered.promise
    const logout = owner.signOut(first.opaqueId)
    await vi.waitFor(() => { expect(() => owner.captureBinding()).toThrow() })
    gate.resolve(publicGrant('late'))
    expect(await refresh).toBeDefined()
    await logout
    expect([...records.values.keys()]).toEqual([legacyKey])
    expect((await owner.describe()).selected).toBeNull()
  })

  it('gets selected auth through public getAuth and force-refreshes an unexpired rejected token', async () => {
    const { owner, oauth } = fixture()
    const first = await add(owner)
    await owner.select(first.opaqueId)
    const token = await owner.observerTokenExport()
    expect(token).toEqual({ token: 'PUBLIC-access-first', chatgptAccountId: 'PUBLIC-issuer-first' })
    expect(oauth.refresh).not.toHaveBeenCalled()
    const fresh = await owner.observerTokenExport(true)
    expect(fresh.token).toBe('PUBLIC-access-first-refreshed')
    expect(oauth.refresh).toHaveBeenCalledTimes(1)
    expect(JSON.stringify(await owner.describe())).not.toContain('PUBLIC-access')
    expect(JSON.stringify(await owner.describe())).not.toContain('PUBLIC-issuer')
  })

  it('checks exclusive ownership after a network refresh and refuses to commit after lease loss', async () => {
    const { owner, oauth, assertExclusive, records, legacyKey } = fixture()
    const account = await add(owner)
    await owner.select(account.opaqueId)
    const entered = deferred<undefined>()
    const gate = deferred<ReturnType<typeof publicGrant>>()
    oauth.refresh.mockImplementation(async () => { entered.resolve(undefined); return gate.promise })
    const refresh = owner.observerTokenExport(true)
    const outcome = refresh.catch((error: unknown) => error)
    await entered.promise
    assertExclusive.mockImplementation(() => { throw new Error('PUBLIC exclusive vault lease lost') })
    gate.resolve(publicGrant('late'))
    expect(await outcome).toMatchObject({ message: 'PUBLIC exclusive vault lease lost' })
    const managed = [...records.values].find(([key]) => key !== legacyKey)?.[1]
    expect(grantPayload(managed)).toMatchObject({ access: 'PUBLIC-access-first' })
  })

  it('cancels Add without replacing selected account and waits for late OAuth terminal cleanup', async () => {
    const { owner, oauth, records, legacyKey } = fixture()
    const first = await add(owner)
    await owner.select(first.opaqueId)
    const entered = deferred<undefined>()
    const gate = deferred<ReturnType<typeof publicGrant>>()
    oauth.login.mockImplementation(async () => { entered.resolve(undefined); return gate.promise })
    const login = add(owner).catch((error: unknown) => error)
    await entered.promise
    let cancelled = false
    const cancellation = owner.cancelLogin().then(() => { cancelled = true })
    await Promise.resolve(undefined)
    expect(cancelled).toBe(false)
    gate.resolve(publicGrant('cancelled'))
    await cancellation
    expect(await login).toBeDefined()
    expect(records.values.size).toBe(2)
    expect(records.values.has(legacyKey)).toBe(true)
    expect((await owner.describe()).selected).toBe(first.opaqueId)
    expect(owner.captureBinding().opaqueId).toBe(first.opaqueId)
  })

  it('cleans a staging grant when metadata commit fails and keeps the old selection', async () => {
    const { owner, records, commitManifest } = fixture()
    const first = await add(owner)
    await owner.select(first.opaqueId)
    commitManifest.mockRejectedValueOnce(new Error('PUBLIC manifest write failed'))
    await expect(add(owner)).rejects.toThrow('PUBLIC manifest write failed')
    expect(records.values.size).toBe(2)
    expect((await owner.describe()).accounts).toEqual([first])
    expect(owner.captureBinding().opaqueId).toBe(first.opaqueId)
  })

  it('fails closed after a selection commit failure and never falls back to the previous account', async () => {
    const { owner, commitManifest } = fixture()
    const first = await add(owner)
    const second = await add(owner)
    await owner.select(first.opaqueId)
    commitManifest.mockRejectedValueOnce(new Error('PUBLIC commit failed'))
    await expect(owner.select(second.opaqueId)).rejects.toThrow('PUBLIC commit failed')
    expect(() => owner.captureBinding()).toThrow(expect.objectContaining({ code: 'NO_CODEX_ACCOUNT' }))
    await owner.select(second.opaqueId)
    expect(owner.captureBinding().opaqueId).toBe(second.opaqueId)
  })

  it('rejects malformed persisted SDK fields without JWT inspection or grant rewriting', async () => {
    const records = recordFixture()
    const key = credentialKey('llm-pi-ai-codex-accounts', 'account-public')
    const payload = { ...publicGrant('malformed'), accountId: null }
    records.values.set(key, { kind: 'grant', payload })
    const store = codexBoundStore(records, key, () => {})
    await expect(store.read('openai-codex')).rejects.toMatchObject({ code: 'INVALID_CODEX_GRANT' })
    expect(grantPayload(records.values.get(key))).toBe(payload)
    await expect(store.read('openai')).rejects.toMatchObject({ code: 'ACCOUNT_PROVIDER_MISMATCH' })
  })

  it('rejects issuer identity changes during refresh without replacing the stored grant', async () => {
    const { owner, oauth } = fixture()
    const first = await add(owner)
    await owner.select(first.opaqueId)
    oauth.refresh.mockResolvedValue(publicGrant('different-issuer'))
    await expect(owner.forcedRefresh()).rejects.toMatchObject({ code: 'CODEX_ACCOUNT_CHANGED' })
    expect((await owner.observerTokenExport()).chatgptAccountId).toBe('PUBLIC-issuer-first')
  })

  it('closes Add admission while sign-out-all waits for cancelled OAuth and then removes all managed grants', async () => {
    const { owner, records, oauth, legacyKey } = fixture()
    const first = await add(owner)
    await owner.select(first.opaqueId)
    const entered = deferred<undefined>()
    const gate = deferred<ReturnType<typeof publicGrant>>()
    oauth.login.mockImplementation(async () => { entered.resolve(undefined); return gate.promise })
    const login = add(owner).catch((error: unknown) => error)
    await entered.promise
    const clearing = owner.signOutAll()
    expect(owner.signOutAll()).toBe(clearing)
    expect(() => owner.beginLogin({ label: 'PUBLIC prohibited', interaction })).toThrow(
      expect.objectContaining({ code: 'CODEX_LOGIN_IN_PROGRESS' }))
    gate.resolve(publicGrant('late-cancelled'))
    await clearing
    await login
    expect([...records.values.keys()]).toEqual([legacyKey])
    expect((await owner.describe()).accounts).toEqual([])
  })

  it('restores committed accounts and epoch without login or legacy adoption', async () => {
    const { owner, restart, oauth } = fixture()
    const account = await add(owner)
    await owner.select(account.opaqueId)
    const { legacy: _legacy, ...manifest } = await owner.describe()
    await owner.dispose()
    const restored = restart()
    await restored.restore(manifest)
    expect(await restored.describe()).toMatchObject(manifest)
    expect(restored.captureBinding()).toMatchObject({ opaqueId: account.opaqueId, epoch: manifest.epoch })
    expect(oauth.login).toHaveBeenCalledTimes(1)
    await expect(restored.restore(manifest)).rejects.toMatchObject({ code: 'ACCOUNT_OWNER_INITIALIZED' })
    await restored.dispose()
  })

  it('fails restored missing grants without choosing legacy or another account', async () => {
    const { owner, restart, records } = fixture()
    const account = await add(owner)
    await owner.select(account.opaqueId)
    const { legacy: _legacy, ...manifest } = await owner.describe()
    records.values.delete(credentialKey('llm-pi-ai-codex-accounts', account.opaqueId))
    const restored = restart()
    await expect(restored.restore(manifest)).rejects.toMatchObject({ code: 'INVALID_CODEX_GRANT' })
    expect(() => restored.captureBinding()).toThrow(expect.objectContaining({ code: 'NO_CODEX_ACCOUNT' }))
  })

  it('freezes Add commit epoch rather than a later selection read', async () => {
    const { owner } = fixture()
    const A = await owner.beginLogin({ label: 'PUBLIC A', interaction })
    const B = await owner.beginLogin({ label: 'PUBLIC B', interaction })
    expect(B.epoch).toBe(A.epoch)
    await owner.select(A.account.opaqueId, A.epoch)
    expect(B.epoch).toBe(0)
    expect(Object.isFrozen(B)).toBe(true)
    await expect(owner.select(B.account.opaqueId, B.epoch)).rejects.toMatchObject({ code: 'CODEX_EPOCH_CONFLICT' })
  })

  it('checks expected epoch inside queued selection and local deletion', async () => {
    const { owner } = fixture()
    const A = await add(owner)
    const B = await add(owner)
    await owner.select(A.opaqueId, 0)
    const epoch = (await owner.describe()).epoch
    const switching = owner.select(B.opaqueId, epoch)
    const stale = owner.signOut(B.opaqueId, epoch)
    await switching
    await expect(stale).rejects.toMatchObject({ code: 'CODEX_EPOCH_CONFLICT' })
    expect(owner.captureBinding().opaqueId).toBe(B.opaqueId)
  })

  it('retires captured bindings and active login synchronously on vault ownership signal', async () => {
    const { owner, ownership, oauth } = fixture()
    const A = await add(owner)
    await owner.select(A.opaqueId)
    const binding = owner.captureBinding()
    const entered = deferred<undefined>()
    const terminal = deferred<ReturnType<typeof publicGrant>>()
    oauth.login.mockImplementation(async () => { entered.resolve(undefined); return terminal.promise })
    const login = owner.beginLogin({ label: 'PUBLIC pending', interaction }).catch((error: unknown) => error)
    await entered.promise
    ownership.abort('PUBLIC vault lease lost')
    expect(binding.retireSignal.aborted).toBe(true)
    expect(oauth.login.mock.calls.at(-1)?.[0].signal?.aborted).toBe(true)
    expect(() => owner.captureBinding()).toThrow(expect.objectContaining({ code: 'STALE_CODEX_ACCOUNT' }))
    terminal.resolve(publicGrant('late'))
    await login
    await owner.dispose()
  })

  it('rejects stale Add before OAuth and again at durable commit without changing selection', async () => {
    const { owner, oauth, records } = fixture()
    const A = await add(owner)
    const B = await add(owner)
    await owner.select(A.opaqueId)
    const epoch = (await owner.describe()).epoch
    expect(() => owner.beginLogin({ label: 'PUBLIC stale', interaction, expectedEpoch: 0 })).toThrow(
      expect.objectContaining({ code: 'CODEX_EPOCH_CONFLICT' }))
    const entered = deferred<undefined>()
    const terminal = deferred<ReturnType<typeof publicGrant>>()
    oauth.login.mockImplementation(async () => { entered.resolve(undefined); return terminal.promise })
    const login = owner.beginLogin({ label: 'PUBLIC late', interaction, expectedEpoch: epoch })
    const outcome = login.catch((error: unknown) => error)
    await entered.promise
    await owner.select(B.opaqueId, epoch)
    terminal.resolve(publicGrant('late'))
    expect(await outcome).toMatchObject({ code: 'CODEX_EPOCH_CONFLICT' })
    expect((await owner.describe()).accounts).toEqual([A, B])
    expect(owner.captureBinding().opaqueId).toBe(B.opaqueId)
    expect(records.values.size).toBe(3)
  })

  it('does not cancel active OAuth when a queued sign-out-all epoch guard becomes stale', async () => {
    const { owner, oauth, retireBinding } = fixture()
    const A = await add(owner)
    const B = await add(owner)
    await owner.select(A.opaqueId)
    const epoch = (await owner.describe()).epoch
    const entered = deferred<undefined>()
    const terminal = deferred<ReturnType<typeof publicGrant>>()
    oauth.login.mockImplementation(async () => { entered.resolve(undefined); return terminal.promise })
    const login = owner.beginLogin({ label: 'PUBLIC still permitted', interaction })
    await entered.promise
    const drained = deferred<undefined>()
    retireBinding.mockImplementationOnce(async () => drained.promise)
    const switching = owner.select(B.opaqueId, epoch)
    const clearing = owner.signOutAll(epoch).catch((error: unknown) => error)
    drained.resolve(undefined)
    await switching
    expect(await clearing).toMatchObject({ code: 'CODEX_EPOCH_CONFLICT' })
    expect(oauth.login.mock.calls.at(-1)?.[0].signal?.aborted).toBe(false)
    terminal.resolve(publicGrant('permitted'))
    await login
    expect(owner.captureBinding().opaqueId).toBe(B.opaqueId)
    expect((await owner.describe()).accounts).toHaveLength(3)
  })

  it('joins cancelled Add queued behind sign-out-all only after releasing its transition', async () => {
    const { owner, oauth, retireBinding, records } = fixture()
    const A = await add(owner)
    const B = await add(owner)
    await owner.select(A.opaqueId)
    const entered = deferred<undefined>()
    const terminal = deferred<ReturnType<typeof publicGrant>>()
    oauth.login.mockImplementation(async () => { entered.resolve(undefined); return terminal.promise })
    const login = owner.beginLogin({ label: 'PUBLIC queued Add', interaction }).catch((error: unknown) => error)
    await entered.promise
    const drained = deferred<undefined>()
    retireBinding.mockImplementationOnce(async () => drained.promise)
    const switching = owner.select(B.opaqueId)
    const clearing = owner.signOutAll()
    terminal.resolve(publicGrant('queued'))
    await vi.waitFor(() => { expect(records.values.size).toBe(4) })
    drained.resolve(undefined)
    await switching
    await clearing
    await login
    expect((await owner.describe()).accounts).toEqual([])
    expect(records.values.size).toBe(1)
  })

  it('holds disposal until private observer refresh and underlying record mutation finish', async () => {
    const { owner, oauth } = fixture()
    const account = await add(owner)
    await owner.select(account.opaqueId)
    const entered = deferred<undefined>()
    const terminal = deferred<ReturnType<typeof publicGrant>>()
    oauth.refresh.mockImplementation(async () => { entered.resolve(undefined); return terminal.promise })
    const token = owner.forcedRefresh().catch((error: unknown) => error)
    await entered.promise
    let disposed = false
    const disposal = owner.dispose().then(() => { disposed = true })
    await Promise.resolve(undefined)
    expect(disposed).toBe(false)
    terminal.resolve(publicGrant('first'))
    await disposal
    expect(await token).toBeDefined()
  })

  it.each(['', '   ', 'x'.repeat(129), 'PUBLIC\u202eaccount', 'PUBLIC\naccount'])('refuses unsafe account label %j', label => {
    const { owner, oauth } = fixture()
    expect(() => owner.beginLogin({ label, interaction })).toThrow(expect.objectContaining({ code: 'INVALID_CODEX_LABEL' }))
    expect(oauth.login).not.toHaveBeenCalled()
  })

  it('disposes without deleting stored grants and closes captured bindings', async () => {
    const { owner, records, retireBinding } = fixture()
    const first = await add(owner)
    await owner.select(first.opaqueId)
    const binding = owner.captureBinding()
    const disposing = owner.dispose()
    expect(owner.dispose()).toBe(disposing)
    await disposing
    expect(binding.retireSignal.aborted).toBe(true)
    expect(retireBinding).toHaveBeenCalledWith(binding)
    expect(records.values.size).toBe(2)
    expect(() => owner.captureBinding()).toThrow(expect.objectContaining({ code: 'ACCOUNT_OWNER_DISPOSED' }))
  })
})
