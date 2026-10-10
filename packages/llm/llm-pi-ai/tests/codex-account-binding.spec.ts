/** Prepared-account races through the real Loader/profile composition; no provider or network I/O. */
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader, { type ModuleLoaderV2 } from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import LlmRuntime, { type StreamChunk } from '@deepseek-ai/dsh-llm'
import { brandString, type Branded } from '@deepseek-ai/dsh-brand'
import { AssistantMessageEventStream } from '@earendil-works/pi-ai/utils/event-stream'
import type { AssistantMessage, SimpleStreamOptions } from '@earendil-works/pi-ai'
import { registerSessionResourceCleanup } from '@earendil-works/pi-ai'
import * as LlmPiAi from '../src/index.ts'
import { PiAiAdapter } from '../src/adapter.ts'
import { CodexAccountOwner } from '../src/codex-account-owner.ts'
import { resolveProfiles } from '../src/config.ts'
import { profileComposition } from '../../../settings/settings/tests/profile-composition.ts'
import { memoryAuth } from './auth-double.ts'
import { deferred, interaction, oauthFixture, publicGrant, recordFixture } from './codex-account-fixture.ts'

let context: Context | undefined
let root: string | undefined
const cleanups: (() => void)[] = []

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  for (const cleanup of cleanups.splice(0)) cleanup()
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

function message(): AssistantMessage {
  return { role: 'assistant', content: [{ type: 'text', text: 'PUBLIC response' }],
    api: 'openai-codex-responses', provider: 'openai-codex', model: 'gpt-6.1-sol',
    usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: 'stop', timestamp: 0 }
}

async function collect(stream: AsyncIterable<StreamChunk>) {
  const chunks: StreamChunk[] = []
  for await (const chunk of stream) chunks.push(chunk)
  return chunks
}

async function composition(injected: object, nativeFlag = false) {
  root = await mkdtemp(join(tmpdir(), 'dsh-codex-foundation-'))
  const configPath = join(root, 'cordis.yml')
  await writeFile(configPath, [
    '- id: llm', '  name: test-llm-service',
    '- id: llm-pi-ai', '  name: test-pi-adapter',
    ...(nativeFlag ? ['  config:', '    nativeCodexAccounts: true'] : []), '',
  ].join('\n'))
  const ctx = new Context()
  context = ctx
  ctx.baseUrl = pathToFileURL(root).href + '/'
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  const modules = new Map<string, unknown>([['test-llm-service', LlmRuntime], ['test-pi-adapter', injected]])
  const internal: ModuleLoaderV2 = {
    version: 'v2', loadCache: new Map(),
    import: specifier => Promise.resolve(modules.get(specifier)),
    register(): never { throw new Error('unexpected module hook') },
    getOrCreateModuleJob(): never { throw new Error('unexpected module job') },
    resolveSync(): never { throw new Error('unexpected resolver') },
    load(): never { throw new Error('unexpected module load') },
  }
  ctx.loader.internal = internal
  await profileComposition(ctx, root, configPath)
  return ctx
}

async function fixture() {
  const records = recordFixture()
  const oauth = oauthFixture()
  const profiles = resolveProfiles({ 'openai-codex': { models: [{ id: 'gpt-6.1-sol' }] } })
  const profile = profiles.get('openai-codex')
  if (profile === undefined) throw new Error('missing configured profile')
  const sdkCalls: SimpleStreamOptions[] = []
  const sdk = vi.fn((_model, _context, options: SimpleStreamOptions) => {
    sdkCalls.push(options)
    const events = new AssistantMessageEventStream()
    events.push({ type: 'done', reason: 'stop', message: message() })
    return events
  })
  if (profile.piProvider === undefined) throw new Error('missing configured Codex provider')
  profile.piProvider = { ...profile.piProvider, auth: oauth.provider.auth, streamSimple: sdk }
  const credentialGate = { task: Promise.resolve(undefined) }
  let adapter!: PiAiAdapter
  const owner = new CodexAccountOwner({ records, auth: memoryAuth(), provider: oauth.provider,
    legacyPresent: () => Promise.resolve(false), assertExclusive: () => {}, commitManifest: async () => {},
    retireBinding: binding => adapter.retireAccountBinding(binding) })
  const { account: first } = await owner.beginLogin({ label: 'PUBLIC first', interaction })
  oauth.login.mockResolvedValue(publicGrant('second'))
  const { account: second } = await owner.beginLogin({ label: 'PUBLIC second', interaction })
  await owner.select(first.opaqueId)
  const ctx = await composition({ name: 'test-codex-foundation', inject: ['llm'], apply(ctx: Context) {
    adapter = new PiAiAdapter({ profiles: () => profiles, auth: memoryAuth(),
      resolveApiKey: () => credentialGate.task, accountBinding: () => owner.captureBinding() })
    ctx.llm.registerAdapter(['openai-codex'], adapter)
    ctx.effect(() => async () => { await owner.dispose(); await adapter.dispose() })
  } })
  const request = { provider: 'openai-codex', model: 'gpt-6.1-sol', messages: [],
    sessionId: brandString<Branded<'SessionId'>>('PUBLIC-session') }
  return { ctx, owner, adapter, first, second, request, sdk, sdkCalls, credentialGate }
}

describe('Codex account binding foundation in real Loader composition', () => {
  it('rejects old prepared consumption and admits only the explicitly selected fixed store', async () => {
    const { owner, adapter, first, second, request, sdkCalls } = await fixture()
    const prepared = await adapter.prepareCall(request.provider, request.model)
    await owner.select(second.opaqueId)
    await expect(collect(prepared.stream(request))).rejects.toMatchObject({ code: 'STALE_CODEX_ACCOUNT' })
    expect(sdkCalls).toHaveLength(0)
    await collect(adapter.stream(request))
    expect(sdkCalls[0]).toMatchObject({ apiKey: 'PUBLIC-access-second',
      sessionId: `${second.opaqueId}:${owner.captureBinding().epoch}:PUBLIC-session` })
    expect(sdkCalls[0]?.sessionId).not.toContain(first.opaqueId)
  })

  it('denies pre-SDK dispatch when selection races an awaited credential', async () => {
    const { owner, adapter, second, request, credentialGate, sdk } = await fixture()
    const gate = deferred<undefined>()
    credentialGate.task = gate.promise
    const pending = collect(adapter.stream(request))
    const outcome = pending.catch((error: unknown) => error)
    await owner.select(second.opaqueId)
    gate.resolve(undefined)
    expect(await outcome).toMatchObject({ code: 'STALE_CODEX_ACCOUNT' })
    expect(sdk).not.toHaveBeenCalled()
  })

  it('aborts and waits for yielded SDK terminal leases before selecting, preserving later request admission', async () => {
    const { owner, adapter, first, second, request, sdk } = await fixture()
    const gate = deferred<undefined>()
    const aborted = deferred<undefined>()
    const retired: (string | undefined)[] = []
    cleanups.push(registerSessionResourceCleanup(id => retired.push(id)))
    sdk.mockImplementationOnce((_model, _context, options) => {
      const events = new AssistantMessageEventStream()
      options.signal?.addEventListener('abort', () => { aborted.resolve(undefined) }, { once: true })
      events.push({ type: 'text_start', contentIndex: 0, partial: message() })
      void gate.promise.then(() => { events.push({ type: 'error', reason: 'aborted', error: { ...message(), stopReason: 'aborted' } }) })
      return events
    })
    const binding = owner.captureBinding()
    const iterator = adapter.stream(request)[Symbol.asyncIterator]()
    expect((await iterator.next()).done).toBe(false)
    let selected = false
    const selecting = owner.select(second.opaqueId).then(() => { selected = true })
    try {
      await aborted.promise
      expect(selected).toBe(false)
      expect(retired).toEqual([])
      expect((await owner.describe()).selected).toBe(first.opaqueId)
    } finally {
      gate.resolve(undefined)
    }
    await selecting
    expect(retired).toEqual([`${first.opaqueId}:${binding.epoch}:PUBLIC-session`])
    expect(await iterator.next()).toEqual({ value: undefined, done: true })
    await collect(adapter.stream(request))
    const selectedEpoch = owner.captureBinding().epoch
    await context?.fiber.dispose()
    expect(retired).toContain(`${second.opaqueId}:${selectedEpoch}:PUBLIC-session`)
  })

  it('refuses explicit native activation through actual Loader config', async () => {
    const ctx = await composition(LlmPiAi, true)
    const entry = [...ctx.loader.entries()].find(row => row.options.id === 'llm-pi-ai')
    if (entry?.fiber === undefined) throw new Error('missing pi Loader fiber')
    await expect(entry.fiber.await()).rejects.toMatchObject({ code: 'CODEX_ACCOUNT_OWNER_UNAVAILABLE' })
    expect(ctx.get('codexAccounts')).toBeUndefined()
    expect(ctx.llm.listProviders()).toEqual([])
  })

  it('leaves the shipped plugin legacy-bound with no account service', async () => {
    const ctx = await composition(LlmPiAi)
    expect(ctx.get('codexAccounts')).toBeUndefined()
    expect(ctx.llm.listProviders()).toEqual([])
    const entry = [...ctx.loader.entries()].find(row => row.options.id === 'llm-pi-ai')
    expect(entry?.fiber).toBeDefined()
    await expect(ctx.plugin(LlmPiAi, { nativeCodexAccounts: true })).rejects.toMatchObject({ code: 'CODEX_ACCOUNT_OWNER_UNAVAILABLE' })
    expect(ctx.get('codexAccounts')).toBeUndefined()
  })
})
