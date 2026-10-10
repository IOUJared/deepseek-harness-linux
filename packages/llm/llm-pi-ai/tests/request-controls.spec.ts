/** Explicit controls reach real pi-ai serializers; all external I/O is intercepted. */

import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Api, Model } from '@earendil-works/pi-ai'
import { LlmError, ServiceTier, TextVerbosity } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import { PiAiAdapter } from '../src/adapter.ts'
import { resolveProfiles } from '../src/config.ts'
import { requestControlInfo, requestControlOptions } from '../src/request-controls.ts'
import { memoryAuth } from './auth-double.ts'
import { providerRequest } from './provider-request-fixture.ts'

function model(overrides: Partial<Model<Api>> = {}): Model<Api> {
  return {
    id: 'gpt-6.1-sol', name: 'PUBLIC fixture', provider: 'PUBLIC-alias',
    api: 'openai-responses', baseUrl: 'https://api.openai.com/v1',
    reasoning: false, input: ['text'], contextWindow: 8192, maxTokens: 1024,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    ...overrides,
  }
}

function codexToken(): string {
  const payload = Buffer.from(JSON.stringify({ 'https://api.openai.com/auth': { chatgpt_account_id: 'PUBLIC-account' } })).toString('base64url')
  return `PUBLIC.${payload}.PUBLIC`
}

async function drain(adapter: PiAiAdapter, options: GenerateOptions): Promise<StreamChunk[]> {
  const chunks: StreamChunk[] = []
  for await (const chunk of adapter.stream(options)) chunks.push(chunk)
  return chunks
}

/** Intercept any SDK fetch, including unexpected URLs; never fall through to a network. */
function captureRequests(): { requests: { url: string; body: unknown; headers: Headers }[]; fetch: ReturnType<typeof vi.fn> } {
  const requests: { url: string; body: unknown; headers: Headers }[] = []
  const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    requests.push(await providerRequest(input, init))
    return new Response(JSON.stringify({ error: { message: 'PUBLIC intercepted request' } }), {
      status: 401, headers: { 'content-type': 'application/json' },
    })
  })
  vi.stubGlobal('fetch', fetch)
  return { requests, fetch }
}

afterEach(() => { vi.unstubAllGlobals() })

describe('pi-ai exact request-control capability', () => {
  it.each(['gpt-5.5', 'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna', 'gpt-6-astra', 'gpt-6-sol', 'gpt-6.1-sol', 'gpt-6-luna'])(
    'describes documented %s at the exact official endpoint without choosing a tier', (id) => {
      const info = requestControlInfo(model({ id }))
      expect(info.serviceTier?.tiers.map(tier => tier.id)).toEqual(['default', 'priority'])
      expect(info.serviceTier?.defaultTier).toBeUndefined()
      expect(info.textVerbosity?.levels.map(level => level.id)).toEqual(['low', 'medium', 'high'])
      expect(info.textVerbosity?.defaultLevel).toBeUndefined()
      expect(info.serviceTier?.tiers[1]?.description).toContain('higher charges or subscription usage')
    },
  )

  it.each(['gpt-5.2', 'gpt-5.4'])('retains API controls for %s without advertising retired Codex support', (id) => {
    expect(requestControlInfo(model({ id })).serviceTier?.tiers.map(tier => tier.id)).toEqual(['default', 'priority'])
    expect(requestControlInfo(model({ id })).textVerbosity?.levels.map(level => level.id)).toEqual(['low', 'medium', 'high'])
    expect(requestControlInfo(model({ id, api: 'openai-codex-responses', baseUrl: 'https://chatgpt.com/backend-api' }))).toEqual({})
  })

  it.each([
    { id: 'gpt-future-unknown', name: 'GPT-6.1 Sol' },
    { id: 'gpt-5.3-codex-spark' },
    { api: 'openai-completions' },
    { api: 'azure-openai-responses' },
    { baseUrl: 'https://gateway.example/v1' },
    { baseUrl: 'https://api.openai.com.evil.example/v1' },
    { baseUrl: 'https://api.openai.com/v1/other' },
    { api: 'openai-codex-responses', baseUrl: 'https://api.openai.com/v1' },
  ])('does not infer support for an unverified model or transport: %j', (overrides) => {
    expect(requestControlInfo(model(overrides))).toEqual({})
  })

  it('advertises Codex existing low default without materializing an omitted knob', () => {
    const descriptor = model({ api: 'openai-codex-responses', baseUrl: 'https://chatgpt.com/backend-api/' })
    expect(requestControlInfo(descriptor).textVerbosity?.defaultLevel).toBe('low')
    expect(requestControlOptions(descriptor, {})).toEqual({})
  })

  it('replaces only explicit fields, preserves text format/sampling, and freezes caller controls', async () => {
    const descriptor = model()
    const options = { serviceTier: ServiceTier('default'), textVerbosity: TextVerbosity('low') }
    const hook = requestControlOptions(descriptor, options).onPayload
    options.serviceTier = ServiceTier('priority')
    options.textVerbosity = TextVerbosity('high')
    const payload = { model: descriptor.id, text: { format: { type: 'json_object' }, verbosity: 'medium' }, top_p: 0.8 }
    expect(await hook?.(payload, descriptor)).toEqual({
      ...payload, service_tier: 'default', text: { format: { type: 'json_object' }, verbosity: 'low' },
    })
    expect(payload.text.verbosity).toBe('medium')
    const tierOnly = requestControlOptions(descriptor, { serviceTier: ServiceTier('priority') }).onPayload
    expect(await tierOnly?.(payload, descriptor)).toEqual({ ...payload, service_tier: 'priority' })
  })

  it.each([null, [], 'PUBLIC invalid payload', { text: 'PUBLIC invalid text options' }])(
    'refuses an incompatible SDK payload rather than dropping explicit detail: %j', async (payload) => {
      const descriptor = model()
      const hook = requestControlOptions(descriptor, { textVerbosity: TextVerbosity('high') }).onPayload
      expect(() => hook?.(payload, descriptor)).toThrow(LlmError)
    },
  )
})

describe('pi-ai provider control payloads and direct-path admission', () => {
  it('forwards GPT-5.2 Fast and detail through the pinned stock API descriptor', async () => {
    const capture = captureRequests()
    const profiles = resolveProfiles({ openai: { apiKeyEnv: 'PUBLIC_KEY', transport: 'sse' } })
    const adapter = new PiAiAdapter({ profiles: () => profiles, auth: memoryAuth(), resolveApiKey: () => Promise.resolve('PUBLIC-key') })
    try {
      const chunks = await drain(adapter, { provider: 'openai', model: 'gpt-5.2', messages: [], serviceTier: ServiceTier('priority'), textVerbosity: TextVerbosity('high') })
      expect(chunks.at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'error' } })
      expect(capture.requests[0]).toMatchObject({ url: 'https://api.openai.com/v1/responses', body: { model: 'gpt-5.2', service_tier: 'priority', text: { verbosity: 'high' } } })
      expect(capture.requests).toHaveLength(1)
    } finally { await adapter.dispose() }
  })
  it.each(['openai', 'openai-codex'])(
    'forwards all explicit levels, Standard/Fast and omission through real %s serializers', async (provider) => {
      const capture = captureRequests()
      const profiles = resolveProfiles({ [provider]: {
        apiKeyEnv: 'PUBLIC_KEY', transport: 'sse', headers: { 'X-Public-Fixture': 'kept' },
        ...(provider === 'openai' ? { api: 'openai-responses' } : {}),
        models: [{ id: 'gpt-6.1-sol' }],
      } })
      const adapter = new PiAiAdapter({ profiles: () => profiles, auth: memoryAuth(), resolveApiKey: () => Promise.resolve(provider === 'openai' ? 'PUBLIC-key' : codexToken()) })
      try {
        const info = await adapter.resolveModel(provider, 'gpt-6.1-sol')
        expect(info.serviceTier?.tiers.map(tier => tier.id)).toEqual(['default', 'priority'])
        for (const textVerbosity of [TextVerbosity('low'), TextVerbosity('medium'), TextVerbosity('high')]) {
          const chunks = await drain(adapter, { provider, model: 'gpt-6.1-sol', messages: [], serviceTier: ServiceTier('priority'), textVerbosity })
          expect(chunks.at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'error' } })
          expect(capture.requests.at(-1)?.body, JSON.stringify(chunks.at(-1))).toMatchObject({ model: 'gpt-6.1-sol', service_tier: 'priority', text: { verbosity: textVerbosity } })
        }
        await drain(adapter, { provider, model: 'gpt-6.1-sol', messages: [], serviceTier: ServiceTier('default') })
        expect(capture.requests.at(-1)?.body).toMatchObject({ service_tier: 'default' })
        await drain(adapter, { provider, model: 'gpt-6.1-sol', messages: [] })
        expect(capture.requests.at(-1)?.body).not.toHaveProperty('service_tier')
        if (provider === 'openai-codex') expect(capture.requests.at(-1)?.body).toMatchObject({ text: { verbosity: 'low' } })
        else expect(capture.requests.at(-1)?.body).not.toHaveProperty('text')
        expect(capture.requests).toHaveLength(5)
        expect(capture.requests[0]?.url).toBe(provider === 'openai' ? 'https://api.openai.com/v1/responses' : 'https://chatgpt.com/backend-api/codex/responses')
        expect(capture.requests[0]?.headers.get('x-public-fixture')).toBe('kept')
      } finally { await adapter.dispose() }
    },
  )

  it.each([{ serviceTier: ServiceTier('priority') }, { textVerbosity: TextVerbosity('high') }])(
    'refuses explicit unsupported controls before credential resolution or SDK fetch: %j', async (controls) => {
      const capture = captureRequests()
      const resolveApiKey = vi.fn(() => Promise.resolve('PUBLIC-key'))
      const profiles = resolveProfiles({ openai: { api: 'openai-responses', baseURL: 'https://gateway.example/v1', models: [{ id: 'gpt-6.1-sol' }] } })
      const adapter = new PiAiAdapter({ profiles: () => profiles, auth: memoryAuth(), resolveApiKey })
      try {
        await expect(drain(adapter, { provider: 'openai', model: 'gpt-6.1-sol', messages: [], ...controls })).rejects.toMatchObject({ code: 'serviceTier' in controls ? 'UNSUPPORTED_SERVICE_TIER' : 'UNSUPPORTED_TEXT_VERBOSITY' })
        expect(resolveApiKey).not.toHaveBeenCalled()
        expect(capture.fetch).not.toHaveBeenCalled()
      } finally { await adapter.dispose() }
    },
  )

  it('keeps prepared endpoint capabilities and captured control values during credential/config changes', async () => {
    const capture = captureRequests()
    let profiles = resolveProfiles({ openai: { api: 'openai-responses', models: [{ id: 'gpt-6.1-sol' }] } })
    let release: ((key: string) => void) | undefined
    const resolveApiKey = vi.fn(() => new Promise<string>((resolve) => { release = resolve }))
    const adapter = new PiAiAdapter({ profiles: () => profiles, auth: memoryAuth(), resolveApiKey })
    try {
      const prepared = await adapter.prepareCall('openai', 'gpt-6.1-sol')
      profiles = resolveProfiles({ openai: { api: 'openai-responses', baseURL: 'https://gateway.example/v1', models: [{ id: 'gpt-6.1-sol' }] } })
      const options: GenerateOptions = { provider: 'openai', model: 'gpt-6.1-sol', messages: [], serviceTier: ServiceTier('default'), textVerbosity: TextVerbosity('low') }
      const running = prepared.stream(options)[Symbol.asyncIterator]().next()
      expect(resolveApiKey).toHaveBeenCalledOnce()
      options.serviceTier = ServiceTier('priority')
      options.textVerbosity = TextVerbosity('high')
      release?.('PUBLIC-key')
      await running
      expect(capture.requests[0]).toMatchObject({ url: 'https://api.openai.com/v1/responses', body: { service_tier: 'default', text: { verbosity: 'low' } } })
    } finally { await adapter.dispose() }
  })
})
