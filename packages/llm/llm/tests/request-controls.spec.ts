/** Exact-model controls remain explicit across prepared and standalone dispatch. */
import { Context } from '@deepseek-ai/cordis'
import { expect, it, onTestFinished } from 'vitest'
import LlmRuntime, { LlmAdapter, ServiceTier, TextVerbosity } from '../src/index.ts'
import type { GenerateOptions, LlmResolvedModelInfo, StreamChunk } from '../src/index.ts'

function metadata(): Pick<LlmResolvedModelInfo, 'serviceTier' | 'textVerbosity'> {
  return {
    serviceTier: { tiers: [{ id: ServiceTier('default'), name: 'Standard' }, { id: ServiceTier('priority'), name: 'Fast' }], defaultTier: ServiceTier('default') },
    textVerbosity: { levels: [{ id: TextVerbosity('low'), name: 'Low' }, { id: TextVerbosity('high'), name: 'High' }], defaultLevel: TextVerbosity('low') },
  }
}

class ControlsAdapter extends LlmAdapter {
  requests: GenerateOptions[] = []
  capability = metadata()

  override async resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return { provider, id: model, name: model, ...(model === 'supported' ? this.capability : {}) }
  }

  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

async function harness() {
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  await ctx.plugin(LlmRuntime)
  const adapter = new ControlsAdapter()
  ctx.llm.registerAdapter(['fixture'], adapter)
  return { ctx, adapter }
}

async function collect<T>(stream: AsyncIterable<T>): Promise<T[]> {
  const chunks: T[] = []
  for await (const chunk of stream) chunks.push(chunk)
  return chunks
}

const ROUTE = { provider: 'fixture', model: 'supported' }
const CONTROLS = { serviceTier: ServiceTier('priority'), textVerbosity: TextVerbosity('high') }

it('exposes independent capabilities without reasoning and detaches their choices', async () => {
  const { ctx, adapter } = await harness()
  const info = await ctx.llm.resolveModelInfo(ROUTE.provider, ROUTE.model)
  expect(info).toMatchObject(metadata())
  adapter.capability.serviceTier!.tiers[0]!.name = 'changed'
  expect(info.serviceTier!.tiers[0]!.name).toBe('Standard')
})

it('never materializes informational defaults for omitted controls', async () => {
  const { ctx, adapter } = await harness()
  expect(await ctx.llm.resolveCallConfig(ROUTE)).toEqual(ROUTE)
  const prepared = await ctx.llm.prepareCall(ROUTE)
  expect(prepared.config).toEqual(ROUTE)
  expect(prepared.adapterDefaults).toEqual({})
  await collect(prepared.stream({ ...prepared.config, messages: [] }))
  expect(adapter.requests[0]).not.toHaveProperty('serviceTier')
  expect(adapter.requests[0]).not.toHaveProperty('textVerbosity')
})

it('retains explicit controls through both prepared and standalone streams', async () => {
  const { ctx, adapter } = await harness()
  const selected = { ...ROUTE, ...CONTROLS }
  const prepared = await ctx.llm.prepareCall(selected)
  expect(prepared.config).toEqual(selected)
  await collect(prepared.stream({ ...selected, messages: [] }))
  await collect(ctx.llm.stream({ ...selected, messages: [] }))
  expect(adapter.requests).toHaveLength(2)
  for (const request of adapter.requests) expect(request).toMatchObject(CONTROLS)
})

it.each([
  { model: 'unsupported', serviceTier: ServiceTier('priority') },
  { model: 'unsupported', textVerbosity: TextVerbosity('high') },
  { model: 'supported', textVerbosity: TextVerbosity('medium') },
])('rejects an unadvertised explicit choice before dispatch: %j', async (choice) => {
  const { ctx, adapter } = await harness()
  const config = { ...ROUTE, ...choice }
  await expect(ctx.llm.resolveCallConfig(config)).rejects.toMatchObject({ code: 'UNSUPPORTED_OPTION' })
  await expect(ctx.llm.prepareCall(config)).rejects.toMatchObject({ code: 'UNSUPPORTED_OPTION' })
  expect(await collect(ctx.llm.stream({ ...config, messages: [] }))).toMatchObject([
    { type: 'finish', reason: { kind: 'error', failure: { code: 'UNSUPPORTED_OPTION' } } },
  ])
  expect(adapter.requests).toEqual([])
})

it('checks both explicit controls before a prepared call can dispatch', async () => {
  const { ctx, adapter } = await harness()
  const selected = { ...ROUTE, ...CONTROLS }
  const prepared = await ctx.llm.prepareCall(selected)
  expect(() => prepared.stream({ ...selected, serviceTier: ServiceTier('default'), messages: [] })).toThrow('config changed')
  expect(() => prepared.stream({ ...selected, textVerbosity: TextVerbosity('low'), messages: [] })).toThrow('config changed')
  expect(adapter.requests).toEqual([])
  await collect(prepared.stream({ ...selected, messages: [] }))
  expect(adapter.requests).toHaveLength(1)
})

it.each(['empty', 'duplicate', 'unknown-default'] as const)('rejects invalid exact-model option metadata: %s', async (kind) => {
  const { ctx, adapter } = await harness()
  adapter.capability.serviceTier = {
    tiers: kind === 'empty' ? [] : kind === 'duplicate'
      ? [{ id: ServiceTier('priority'), name: 'Fast' }, { id: ServiceTier('priority'), name: 'Again' }]
      : [{ id: ServiceTier('priority'), name: 'Fast' }],
    defaultTier: ServiceTier('default'),
  }
  await expect(ctx.llm.resolveModelInfo(ROUTE.provider, ROUTE.model)).rejects.toMatchObject({ code: 'INVALID_MODEL_OPTION' })
  expect(adapter.requests).toEqual([])
})
