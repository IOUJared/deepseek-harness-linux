/** Actual managed plugin/service/vault through profile Loader composition; synthetic external OAuth only. */
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { inspect } from 'node:util'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context, type Fiber } from '@deepseek-ai/cordis'
import Loader, { type ModuleLoaderV2 } from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import LlmRuntime, { type StreamChunk } from '@deepseek-ai/dsh-llm'
import LocalCredentials from '@deepseek-ai/dsh-credentials-local'
import Authorization from '@deepseek-ai/dsh-authorization'
import { credentialKey } from '@deepseek-ai/dsh-credentials'
import * as LlmPiAi from '../src/index.ts'
import * as Catalog from '../src/catalog.ts'
import { PiAiAdapter } from '../src/adapter.ts'
import { resolveProfiles } from '../src/config.ts'
import { memoryAuth } from './auth-double.ts'
import { AssistantMessageEventStream } from '@earendil-works/pi-ai/utils/event-stream'
import type { AssistantMessage } from '@earendil-works/pi-ai'
import { openCodexAccountVault } from '../src/codex-account-vault.ts'
import { profileComposition } from '../../../settings/settings/tests/profile-composition.ts'
import { deferred, interaction, oauthFixture, publicGrant } from './codex-account-fixture.ts'

let home: string | undefined
const contexts = new Set<Context>()
afterEach(async () => {
  for (const ctx of contexts) await ctx.fiber.dispose()
  contexts.clear()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  if (home !== undefined) await rm(home, { recursive: true, force: true })
  home = undefined
})

async function boot(directory: string, providerProfile: object = { transport: 'sse', models: [{ id: 'gpt-6.1-sol' }] },
  extra: readonly { name: string; plugin: object }[] = []) {
  if (home === undefined) home = await mkdtemp(join(tmpdir(), 'dsh-codex-managed-'))
  const configPath = join(home, 'cordis.yml')
  await writeFile(configPath, [
    '- id: llm', '  name: test-llm',
    '- id: credentials', '  name: test-credentials', '  config:',
    `    path: ${JSON.stringify(join(home, '.credentials.yaml'))}`, '    watch: false',
    '- id: authorization', '  name: test-authorization',
    '- id: pi', '  name: test-pi', '  config:', '    nativeCodexAccounts: true',
    `    nativeCodexAccountVault: ${JSON.stringify(directory)}`,
    `    providers: ${JSON.stringify({ 'openai-codex': providerProfile })}`,
    ...extra.flatMap(row => [`- id: ${row.name}`, `  name: ${row.name}`]), '',
  ].join('\n'))
  const ctx = new Context()
  contexts.add(ctx)
  ctx.baseUrl = pathToFileURL(home).href + '/'
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  const modules = new Map<string, unknown>([['test-llm', LlmRuntime], ['test-pi', LlmPiAi],
    ['test-credentials', LocalCredentials], ['test-authorization', Authorization],
    ...extra.map(row => [row.name, row.plugin] as const)])
  const internal: ModuleLoaderV2 = {
    version: 'v2', loadCache: new Map(),
    import: name => Promise.resolve(modules.get(name)),
    register(): never { throw new Error('unexpected module hook') },
    getOrCreateModuleJob(): never { throw new Error('unexpected module job') },
    resolveSync(): never { throw new Error('unexpected module resolver') },
    load(): never { throw new Error('unexpected module load') },
  }
  ctx.loader.internal = internal
  await profileComposition(ctx, home, configPath)
  const entry = [...ctx.loader.entries()].find(row => row.options.id === 'pi')
  if (entry?.fiber === undefined) throw new Error('missing managed adapter fiber')
  await entry.fiber.await()
  return { ctx, fiber: entry.fiber }
}

async function directory() {
  home = await mkdtemp(join(tmpdir(), 'dsh-codex-managed-'))
  return join(home, 'vault')
}

function syntheticOAuth() {
  const fixture = oauthFixture()
  const original = Catalog.catalogProvider
  vi.spyOn(Catalog, 'catalogProvider').mockImplementation(id => id === 'openai-codex' ? fixture.provider : original(id))
  return fixture
}

async function collect(stream: AsyncIterable<StreamChunk>) {
  const chunks: StreamChunk[] = []
  for await (const chunk of stream) chunks.push(chunk)
  return chunks
}

function jwtGrant(id: string) {
  const payload = Buffer.from(JSON.stringify({ 'https://api.openai.com/auth': { chatgpt_account_id: `PUBLIC-issuer-${id}` } })).toString('base64url')
  return { ...publicGrant(id), access: `eyJhbGciOiJub25lIn0.${payload}.PUBLIC-signature` }
}

describe.skipIf(process.platform === 'win32')('managed Codex production Loader composition', () => {
  it('mounts empty account catalog but denies generation without touching legacy credentials or network', async () => {
    const vault = await directory()
    const fetch = vi.fn(async () => { throw new Error('unexpected network') })
    vi.stubGlobal('fetch', fetch)
    const { ctx, fiber } = await boot(vault)
    const service = ctx.get('codexAccounts')
    expect(service).toBeDefined()
    await expect(service?.describe()).resolves.toEqual({ accounts: [], selected: null, epoch: 0, legacy: 'absent' })
    expect(ctx.llm.listProviders()).toEqual([expect.objectContaining({ id: 'openai-codex' })])
    expect(await ctx.llm.listModels('openai-codex')).toEqual([expect.objectContaining({ id: 'gpt-6.1-sol' })])
    await expect(ctx.llm.prepareCall({ provider: 'openai-codex', model: 'gpt-6.1-sol' })).rejects.toMatchObject({ code: 'NO_CODEX_ACCOUNT' })
    expect(ctx.authorization.describe(credentialKey('llm-pi-ai', 'openai-codex'))).toBeUndefined()
    expect(fetch).not.toHaveBeenCalled()
    await fiber.dispose()
    expect(ctx.get('codexAccounts')).toBeUndefined()
    expect(ctx.llm.listProviders()).toEqual([])
    const reopened = await openCodexAccountVault(vault)
    await reopened.dispose()
  })

  it('adds/selects, captures official SDK authorization and restores without login; stale commands and calls cannot redirect', async () => {
    const vault = await directory()
    const oauth = syntheticOAuth()
    oauth.login.mockResolvedValueOnce(jwtGrant('A')).mockResolvedValueOnce(jwtGrant('B'))
    const captured: { url: string; headers: Headers; body: string }[] = []
    vi.stubGlobal('fetch', vi.fn(async (url: string, options: RequestInit) => {
      captured.push({ url: String(url), headers: new Headers(options.headers), body: String(options.body) })
      return new Response('{"error":{"message":"PUBLIC synthetic denied"}}', { status: 401, headers: { 'content-type': 'application/json' } })
    }))
    const { ctx, fiber } = await boot(vault)
    const service = ctx.get('codexAccounts')
    if (service === undefined) throw new Error('missing managed service')
    const { account: A, epoch: addedEpoch } = await service.beginLogin({ label: 'PUBLIC A', interaction })
    const { account: B } = await service.beginLogin({ label: 'PUBLIC B', interaction })
    await service.select(A.opaqueId, addedEpoch)
    const prepared = await ctx.llm.prepareCall({ provider: 'openai-codex', model: 'gpt-6.1-sol' })
    const stateA = await service.describe()
    await service.select(B.opaqueId, stateA.epoch)
    await expect(service.signOut(B.opaqueId, stateA.epoch)).rejects.toMatchObject({ code: 'CODEX_EPOCH_CONFLICT' })
    const retired = await collect(prepared.stream({ ...prepared.config, messages: [] }))
    expect(retired.at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'error' } })
    expect(captured).toEqual([])
    await collect(ctx.llm.stream({ provider: 'openai-codex', model: 'gpt-6.1-sol', messages: [] }))
    expect(captured).toHaveLength(1)
    expect(captured[0]?.url).toBe('https://chatgpt.com/backend-api/codex/responses')
    expect(captured[0]?.headers.get('authorization')).toBe(`Bearer ${jwtGrant('B').access}`)
    expect(captured[0]?.headers.get('chatgpt-account-id')).toBe('PUBLIC-issuer-B')
    expect(JSON.stringify(await service.describe()) + inspect(service) + JSON.stringify(service)).not.toContain('PUBLIC-issuer')
    const before = await service.describe()
    await fiber.dispose()
    const restored = await boot(vault)
    const accounts = restored.ctx.get('codexAccounts')
    if (accounts === undefined) throw new Error('missing restored service')
    expect(await accounts.describe()).toEqual(before)
    expect(oauth.login).toHaveBeenCalledTimes(2)
    await accounts.signOutAll(before.epoch)
    expect(await accounts.describe()).toMatchObject({ accounts: [], selected: null })
    expect(await restored.ctx.llm.listModels('openai-codex')).toHaveLength(1)
    await expect(restored.ctx.llm.prepareCall({ provider: 'openai-codex', model: 'gpt-6.1-sol' })).rejects.toMatchObject({ code: 'NO_CODEX_ACCOUNT' })
  })

  it('keeps the selected root owner through volatile profile reconciliation and refuses unsafe updates before persistence', async () => {
    const vault = await directory()
    const oauth = syntheticOAuth()
    const { ctx } = await boot(vault)
    const service = ctx.get('codexAccounts')
    if (service === undefined) throw new Error('missing managed service')
    const added = await service.beginLogin({ label: 'PUBLIC stable', interaction })
    await service.select(added.account.opaqueId, added.epoch)
    const before = await service.describe()
    const descriptor = ctx.settings.describe().find(row => row.ns === 'pi')
    if (descriptor === undefined) throw new Error('missing provider settings')
    await ctx.settings.mutate('pi', [{ op: 'set', path: ['providers', 'openai-codex', 'displayName'], value: 'PUBLIC renamed' }], descriptor.revision)
    expect(await ctx.get('codexAccounts')?.describe()).toEqual(before)
    expect(ctx.llm.listProviders()).toEqual([{ id: 'openai-codex', name: 'PUBLIC renamed' }])
    const next = ctx.settings.describe().find(row => row.ns === 'pi')
    if (next === undefined) throw new Error('missing reconciled provider settings')
    await expect(ctx.settings.mutate('pi', [{ op: 'set', path: ['providers', 'openai-codex', 'baseURL'], value: 'https://untrusted.example/' }], next.revision))
      .rejects.toMatchObject({ code: 'ACCOUNT_ROUTE_OVERRIDE' })
    expect(await ctx.get('codexAccounts')?.describe()).toEqual(before)
    expect(oauth.login).toHaveBeenCalledTimes(1)
  })

  it('shares one root owner across genuinely fresh HMR modules and keeps its lease until the last adapter reaches SDK terminal', async () => {
    const vault = await directory()
    const oauth = syntheticOAuth()
    const aSpecifier = '../src/codex-account-service.ts?owner-hmr=A'
    const bSpecifier = '../src/codex-account-service.ts?owner-hmr=B'
    const A: typeof import('../src/codex-account-service.ts') = await import(aSpecifier)
    const B: typeof import('../src/codex-account-service.ts') = await import(bSpecifier)
    expect(A.acquireCodexAccountOwner).not.toBe(B.acquireCodexAccountOwner)
    const consumers = new Map<string, { adapter: PiAiAdapter; fiber: Fiber }>()
    const profiles = resolveProfiles({ 'openai-codex': { transport: 'sse', models: [{ id: 'gpt-6.1-sol' }] } })
    const consumer = (name: string, module: typeof A) => ({
      name,
      async apply(ctx: Context) {
        const auth = memoryAuth()
        const attachment = await module.acquireCodexAccountOwner(ctx, vault, auth)
        ctx.effect(() => () => attachment.release())
        const adapter = new PiAiAdapter({ profiles: () => profiles, auth,
          resolveApiKey: async () => undefined, accountBinding: () => attachment.captureBinding() })
        attachment.attach(adapter)
        consumers.set(name, { adapter, fiber: ctx.fiber })
      },
    })
    const { ctx, fiber } = await boot(vault, undefined, [
      { name: 'fresh-A', plugin: consumer('fresh-A', A) },
      { name: 'fresh-B', plugin: consumer('fresh-B', B) },
    ])
    const service = ctx.get('codexAccounts')
    const first = consumers.get('fresh-A')
    const last = consumers.get('fresh-B')
    if (service === undefined || first === undefined || last === undefined) throw new Error('missing fresh-module consumers')
    const added = await service.beginLogin({ label: 'PUBLIC shared HMR', interaction })
    await service.select(added.account.opaqueId, added.epoch)
    const selected = await service.describe()
    const independentRoot = new Context()
    contexts.add(independentRoot)
    await expect(B.acquireCodexAccountOwner(independentRoot, vault, memoryAuth())).rejects
      .toMatchObject({ code: 'CODEX_VAULT_ACQUISITION_FAILED' })
    const independent = await B.acquireCodexAccountOwner(independentRoot, `${vault}-independent`, memoryAuth())
    expect(await independentRoot.get('codexAccounts')?.describe()).toMatchObject({ accounts: [], selected: null, epoch: 0 })
    expect(() => independent.captureBinding()).toThrow(expect.objectContaining({ code: 'NO_CODEX_ACCOUNT' }))
    await independent.release()
    await independentRoot.fiber.dispose()
    expect(Object.getOwnPropertySymbols(independentRoot)).not.toContain(Symbol.for('dsh.llm-pi-ai.codex-owner-registry.v1'))
    await fiber.dispose()
    await first.fiber.dispose()
    expect(await ctx.get('codexAccounts')?.describe()).toEqual(selected)
    await expect(openCodexAccountVault(vault)).rejects.toMatchObject({ code: 'CODEX_VAULT_ACQUISITION_FAILED' })
    const terminal = deferred<undefined>()
    const aborted = deferred<undefined>()
    const response: AssistantMessage = { role: 'assistant', content: [{ type: 'text', text: 'PUBLIC response' }],
      api: 'openai-codex-responses', provider: 'openai-codex', model: 'gpt-6.1-sol', stopReason: 'stop', timestamp: 0,
      usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } }
    vi.spyOn(oauth.provider, 'streamSimple').mockImplementation((_model, _context, options) => {
      const events = new AssistantMessageEventStream()
      options?.signal?.addEventListener('abort', () => aborted.resolve(undefined), { once: true })
      events.push({ type: 'text_start', contentIndex: 0, partial: response })
      void terminal.promise.then(() => events.push({ type: 'error', reason: 'aborted', error: { ...response, stopReason: 'aborted' } }))
      return events
    })
    const stream = last.adapter.stream({ provider: 'openai-codex', model: 'gpt-6.1-sol', messages: [] })[Symbol.asyncIterator]()
    expect((await stream.next()).done).toBe(false)
    let released = false
    const releasing = last.fiber.dispose().then(() => { released = true })
    try {
      await aborted.promise
      expect(released).toBe(false)
      expect(await ctx.get('codexAccounts')?.describe()).toEqual(selected)
      await expect(openCodexAccountVault(vault)).rejects.toMatchObject({ code: 'CODEX_VAULT_ACQUISITION_FAILED' })
    } finally {
      terminal.resolve(undefined)
      await releasing
    }
    expect(ctx.get('codexAccounts')).toBeUndefined()
    const reopened = await openCodexAccountVault(vault)
    expect(reopened.manifest()).toMatchObject({ selected: selected.selected, epoch: selected.epoch })
    await reopened.dispose()
    // The same root registry can be reused after last release, even through another fresh copy.
    const next = await A.acquireCodexAccountOwner(ctx, vault, memoryAuth())
    expect(next.captureBinding()).toMatchObject({ opaqueId: selected.selected, epoch: selected.epoch })
    await next.release()
    expect(ctx.get('codexAccounts')).toBeUndefined()
  })

  it('cancels late Add without changing selected grant and drains before disposing the root service', async () => {
    const vault = await directory()
    const oauth = syntheticOAuth()
    const { ctx, fiber } = await boot(vault)
    const service = ctx.get('codexAccounts')
    if (service === undefined) throw new Error('missing managed service')
    const { account: A } = await service.beginLogin({ label: 'PUBLIC selected', interaction })
    await service.select(A.opaqueId)
    const before = await service.describe()
    const entered = deferred<undefined>()
    const gate = deferred<ReturnType<typeof publicGrant>>()
    oauth.login.mockImplementation(async () => { entered.resolve(undefined); return gate.promise })
    const login = service.beginLogin({ label: 'PUBLIC cancelled', interaction }).catch((error: unknown) => error)
    await entered.promise
    let disposed = false
    const disposal = fiber.dispose().then(() => { disposed = true })
    await vi.waitFor(() => { expect(oauth.login.mock.calls.at(-1)?.[0].signal?.aborted).toBe(true) })
    expect(disposed).toBe(false)
    gate.resolve(publicGrant('late'))
    await disposal
    await login
    expect(ctx.get('codexAccounts')).toBeUndefined()
    const next = await boot(vault)
    expect(await next.ctx.get('codexAccounts')?.describe()).toEqual(before)
  })

  it.each([
    { apiKeyEnv: 'OPENAI_API_KEY' },
    { baseURL: 'https://untrusted.example/backend-api' },
    { api: 'openai-responses' },
  ])('refuses managed profile overrides before vault or grant admission: %j', async (profile) => {
    const vault = await directory()
    await expect(boot(vault, profile)).rejects.toMatchObject({ code: expect.stringMatching(/^ACCOUNT_(AUTH|ROUTE)_OVERRIDE$/) })
    for (const ctx of contexts) expect(ctx.get('codexAccounts')).toBeUndefined()
    const independent = await openCodexAccountVault(vault)
    expect(independent.manifest()).toMatchObject({ accounts: [] })
    await independent.dispose()
  })
})
