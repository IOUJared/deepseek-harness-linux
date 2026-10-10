/** Owned SDK caches survive requests and retire with the last adapter/plugin owner. */
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader, { type ModuleLoaderV2 } from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import LlmRuntime, { type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { brandString, type Branded } from '@deepseek-ai/dsh-brand'
import { registerSessionResourceCleanup } from '@earendil-works/pi-ai'
import { AssistantMessageEventStream } from '@earendil-works/pi-ai/utils/event-stream'
import type { AssistantMessage, SimpleStreamOptions } from '@earendil-works/pi-ai'
import * as LlmPiAi from '../src/index.ts'
import { PiAiAdapter } from '../src/adapter.ts'
import { resolveProfiles } from '../src/config.ts'
import { profileComposition } from '../../../settings/settings/tests/profile-composition.ts'
import { memoryAuth } from './auth-double.ts'

const sdkStream = vi.hoisted(() => vi.fn())
vi.mock('@earendil-works/pi-ai/api/openai-completions.lazy', () => ({
  openAICompletionsApi: () => ({ stream: sdkStream, streamSimple: sdkStream }),
}))

const providers = {
  'owned-gateway': {
    api: 'openai-completions' as const,
    baseURL: 'http://127.0.0.1:9/v1',
    models: [{ id: 'owned-model', contextWindow: 8192, maxTokens: 1024 }],
  },
}
const sessionId = brandString<Branded<'SessionId'>>
const adapters = new Set<PiAiAdapter>()
const timers = new Map<string, ReturnType<typeof setTimeout>>()
let cleanups: (string | undefined)[]
let unregister: () => void
let context: Context | undefined
let root: string | undefined

function response(): AssistantMessageEventStream {
  const message: AssistantMessage = {
    role: 'assistant', content: [{ type: 'text', text: 'owned response' }],
    api: 'openai-completions', provider: 'owned-gateway', model: 'owned-model',
    usage: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 3,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: 'stop', timestamp: 0,
  }
  const events = new AssistantMessageEventStream()
  events.push({ type: 'text_start', contentIndex: 0, partial: message })
  events.push({ type: 'text_delta', contentIndex: 0, delta: 'owned response', partial: message })
  events.push({ type: 'text_end', contentIndex: 0, content: 'owned response', partial: message })
  events.push({ type: 'done', reason: 'stop', message })
  return events
}

function hold(id: string): void {
  if (!timers.has(id)) timers.set(id, setTimeout(() => {}, 300_000))
}

beforeEach(() => {
  cleanups = []
  unregister = registerSessionResourceCleanup((id) => {
    cleanups.push(id)
    if (id === undefined) throw new Error('global cleanup must never be called')
    clearTimeout(timers.get(id))
    timers.delete(id)
  })
  sdkStream.mockImplementation((_model, _request, options: SimpleStreamOptions) => {
    if (options.sessionId) hold(options.sessionId)
    return response()
  })
})

afterEach(async () => {
  try {
    await context?.fiber.dispose()
    await Promise.all([...adapters].map(instance => instance.dispose()))
  } finally {
    context = undefined
    adapters.clear()
    unregister()
    for (const timer of timers.values()) clearTimeout(timer)
    timers.clear()
    sdkStream.mockReset()
    if (root !== undefined) await rm(root, { recursive: true, force: true })
    root = undefined
  }
})

function adapter(resolveApiKey = () => Promise.resolve(undefined)): PiAiAdapter {
  const profiles = resolveProfiles(providers)
  const instance = new PiAiAdapter({ profiles: () => profiles, resolveApiKey, auth: memoryAuth() })
  adapters.add(instance)
  return instance
}

function request(id?: string): GenerateOptions {
  return { provider: 'owned-gateway', model: 'owned-model', messages: [],
    ...id === undefined ? {} : { sessionId: sessionId(id) } }
}

async function collect(stream: AsyncIterable<StreamChunk>): Promise<StreamChunk[]> {
  const chunks: StreamChunk[] = []
  for await (const chunk of stream) chunks.push(chunk)
  return chunks
}

function delayedSdk(yieldFirst = false): { started: Promise<void>; aborted: Promise<void>; settle: () => void } {
  let started!: () => void
  let aborted!: () => void
  let settle!: () => void
  const startedTask = new Promise<void>((resolve) => { started = resolve })
  const abortedTask = new Promise<void>((resolve) => { aborted = resolve })
  const settlement = new Promise<void>((resolve) => { settle = resolve })
  sdkStream.mockImplementation((_model, _request, options: SimpleStreamOptions) => {
    if (options.sessionId === undefined || options.signal === undefined) throw new Error('missing SDK lifecycle options')
    const id = options.sessionId
    const events = new AssistantMessageEventStream()
    options.signal.addEventListener('abort', aborted, { once: true })
    if (yieldFirst) {
      void response().result().then((partial) => {
        events.push({ type: 'text_start', contentIndex: 0, partial })
      })
    }
    void settlement.then(async () => {
      // Provider finalization can create the cache expiry timer after abort.
      hold(id)
      const message = await response().result()
      events.push({ type: 'error', reason: 'aborted', error: { ...message, stopReason: 'aborted' } })
    })
    started()
    return events
  })
  return { started: startedTask, aborted: abortedTask, settle }
}

describe('pi-ai adapter session resource ownership', () => {
  it('claims each ID once, keeps reuse across requests, and cleans only matched IDs', async () => {
    const instance = adapter()
    hold('foreign')
    await collect(instance.stream(request('first')))
    await collect(instance.stream(request('first')))
    await collect(instance.stream(request('second')))
    expect(cleanups).toEqual([])
    expect([...timers.keys()]).toEqual(['foreign', 'first', 'second'])
    await instance.dispose()
    await instance.dispose()
    expect(cleanups).toEqual(['first', 'second'])
    expect([...timers.keys()]).toEqual(['foreign'])
  })

  it('never uses global cleanup for omitted or empty session IDs', async () => {
    const instance = adapter()
    hold('foreign')
    await collect(instance.stream(request()))
    await collect(instance.stream(request('')))
    await instance.dispose()
    expect(cleanups).toEqual([])
    expect([...timers.keys()]).toEqual(['foreign'])
  })

  it('retains a shared ID until its last distinct adapter owner disposes', async () => {
    const first = adapter()
    const second = adapter()
    await collect(first.stream(request('shared')))
    await collect(first.stream(request('shared')))
    await collect(second.stream(request('shared')))
    await first.dispose()
    expect(cleanups).toEqual([])
    expect(timers.has('shared')).toBe(true)
    await collect(second.stream(request('shared')))
    await second.dispose()
    expect(cleanups).toEqual(['shared'])
    expect(timers.size).toBe(0)
  })

  it('owns the ID before SDK startup can fail and still retires its resources', async () => {
    sdkStream.mockImplementation((_model, _request, options: SimpleStreamOptions) => {
      hold(options.sessionId!)
      throw new Error('SDK startup failure')
    })
    const instance = adapter()
    const chunks = await collect(instance.stream(request('setup-failure')))
    expect(chunks.at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'error' } })
    await instance.dispose()
    expect(cleanups).toEqual(['setup-failure'])
    expect(timers.size).toBe(0)
  })

  it('tries every ID, aggregates cleanup failures and retires ownership despite errors', async () => {
    const instance = adapter()
    await collect(instance.stream(request('bad')))
    await collect(instance.stream(request('good')))
    const failure = new Error('cleanup failure')
    const stopFailing = registerSessionResourceCleanup((id) => { if (id === 'bad') throw failure })
    const afterFailure = vi.fn()
    const stopObserving = registerSessionResourceCleanup(afterFailure)
    try {
      const disposing = instance.dispose()
      expect(instance.dispose()).toBe(disposing)
      await expect(disposing).rejects.toMatchObject({
        errors: [expect.objectContaining({ errors: [failure] })],
      })
      adapters.delete(instance)
      expect(cleanups).toEqual(['bad', 'good'])
      expect(afterFailure.mock.calls).toEqual([['bad'], ['good']])
      expect(timers.size).toBe(0)
      await expect(instance.dispose()).rejects.toBeInstanceOf(AggregateError)
      expect(cleanups).toEqual(['bad', 'good'])
    } finally {
      stopFailing()
      stopObserving()
    }
    const next = adapter()
    await collect(next.stream(request('bad')))
    await next.dispose()
    expect(cleanups).toEqual(['bad', 'good', 'bad'])
  })

  it('aborts active SDK work and cleans timers created during its delayed settlement', async () => {
    const sdk = delayedSdk()
    const instance = adapter()
    const pending = collect(instance.stream(request('active')))
    const outcome = pending.catch(() => undefined)
    await sdk.started
    const disposing = instance.dispose()
    try {
      await sdk.aborted
      expect(cleanups).toEqual([])
      await expect(collect(instance.stream(request('after-dispose')))).rejects.toMatchObject({ code: 'ADAPTER_DISPOSED' })
    } finally {
      sdk.settle()
    }
    await disposing
    await outcome
    expect(cleanups).toEqual(['active'])
    expect(timers.size).toBe(0)
  })

  it('waits for delayed SDK finalization when its consumer is suspended at a yield', async () => {
    const sdk = delayedSdk(true)
    const instance = adapter()
    const iterator = instance.stream(request('yield-delayed'))[Symbol.asyncIterator]()
    expect((await iterator.next()).done).toBe(false)
    let completed = false
    const disposing = instance.dispose().then(() => { completed = true })
    try {
      await sdk.aborted
      await Promise.resolve()
      expect(completed).toBe(false)
      expect(cleanups).toEqual([])
    } finally {
      sdk.settle()
    }
    await disposing
    expect(await iterator.next()).toEqual({ value: undefined, done: true })
    expect(cleanups).toEqual(['yield-delayed'])
    expect(timers.size).toBe(0)
  })

  it('keeps early-return ownership until the SDK producer reaches its terminal result', async () => {
    const sdk = delayedSdk(true)
    const instance = adapter()
    const iterator = instance.stream(request('early-return'))[Symbol.asyncIterator]()
    expect((await iterator.next()).done).toBe(false)
    const returning = iterator.return?.()
    try {
      await sdk.aborted
      expect(cleanups).toEqual([])
    } finally {
      sdk.settle()
    }
    await returning
    expect(timers.has('early-return')).toBe(true)
    await instance.dispose()
    expect(cleanups).toEqual(['early-return'])
    expect(timers.size).toBe(0)
  })

  it('returns a yield-suspended iterator without waiting for its consumer to resume', async () => {
    const instance = adapter()
    const iterator = instance.stream(request('suspended'))[Symbol.asyncIterator]()
    expect((await iterator.next()).done).toBe(false)
    await instance.dispose()
    expect(await iterator.next()).toEqual({ value: undefined, done: true })
    expect(cleanups).toEqual(['suspended'])
    expect(timers.size).toBe(0)
  })

  it('denies direct, deferred and prepared stream admission after disposal', async () => {
    const instance = adapter()
    const deferred = instance.stream(request('deferred'))
    const prepared = await instance.prepareCall('owned-gateway', 'owned-model')
    await instance.dispose()
    for (const stream of [instance.stream(request('direct')), deferred, prepared.stream(request('prepared'))]) {
      await expect(collect(stream)).rejects.toMatchObject({ code: 'ADAPTER_DISPOSED' })
    }
    expect(sdkStream).not.toHaveBeenCalled()
    expect(cleanups).toEqual([])
  })

  it('denies SDK dispatch when disposal races credential resolution', async () => {
    let resolve!: (key: undefined) => void
    const key = new Promise<undefined>((done) => { resolve = done })
    const instance = adapter(() => key)
    const pending = collect(instance.stream(request('pending')))
    await instance.dispose()
    resolve(undefined)
    await expect(pending).rejects.toMatchObject({ code: 'ADAPTER_DISPOSED' })
    expect(sdkStream).not.toHaveBeenCalled()
    expect(cleanups).toEqual([])
  })
})

it('releases a timer-backed SDK session when the real Loader profile plugin unloads', async () => {
  root = await mkdtemp(join(tmpdir(), 'dsh-pi-owned-profile-'))
  const configPath = join(root, 'cordis.yml')
  await writeFile(configPath, [
    '- id: llm', "  name: 'test-llm-service'",
    '- id: llm-pi-ai', "  name: '@deepseek-ai/dsh-llm-pi-ai'", '  config:',
    '    providers:', '      owned-gateway:', '        api: openai-completions',
    '        baseURL: http://127.0.0.1:9/v1', '        models:', '          - id: owned-model', '',
  ].join('\n'))
  const ctx = new Context()
  context = ctx
  ctx.baseUrl = pathToFileURL(root).href + '/'
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  const modules = new Map<string, unknown>([
    ['test-llm-service', LlmRuntime], ['@deepseek-ai/dsh-llm-pi-ai', LlmPiAi],
  ])
  const internal: ModuleLoaderV2 = {
    version: 'v2', loadCache: new Map(),
    import: (specifier) => {
      if (!modules.has(specifier)) throw new Error(`unexpected Loader import: ${specifier}`)
      return Promise.resolve(modules.get(specifier))
    },
    register(): never { throw new Error('unexpected module hook registration') },
    getOrCreateModuleJob(): never { throw new Error('unexpected module job creation') },
    resolveSync(): never { throw new Error('unexpected synchronous module resolution') },
    load(): never { throw new Error('unexpected module load') },
  }
  ctx.loader.internal = internal
  await profileComposition(ctx, root, configPath)
  hold('foreign-profile')
  const chunks = await collect(ctx.llm.stream(request('profile-owned')))
  expect(chunks).toContainEqual({ type: 'text-delta', index: 0, text: 'owned response' })
  expect(chunks.at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'stop' } })
  expect(timers.has('profile-owned')).toBe(true)
  const entry = [...ctx.loader.entries()].find(row => row.options.id === 'llm-pi-ai')
  if (entry?.fiber === undefined) throw new Error('pi-ai Loader fiber missing')
  const sdk = delayedSdk()
  const active = collect(ctx.llm.stream(request('profile-active'))).catch(() => undefined)
  await sdk.started
  const unloading = entry.fiber.dispose()
  try {
    await sdk.aborted
    expect(cleanups).toEqual([])
  } finally {
    sdk.settle()
  }
  await unloading
  await active
  expect(ctx.llm.listProviders()).toEqual([])
  expect(cleanups).toEqual(['profile-owned', 'profile-active'])
  expect([...timers.keys()]).toEqual(['foreign-profile'])
})
