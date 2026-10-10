/** Exact documented OpenAI controls and their pi-ai streamSimple payload bridge. */

import type { Api, Model, SimpleStreamOptions } from '@earendil-works/pi-ai'
import { LlmError, ServiceTier, TextVerbosity } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, LlmResolvedModelInfo } from '@deepseek-ai/dsh-llm'

// Model support is explicit, not inferred from display names or GPT prefixes.
// Official sources and account/processing-tier restrictions live in README.md.
const DOCUMENTED_MODELS = new Set([
  'gpt-5.5',
  'gpt-5.6-sol',
  'gpt-5.6-terra',
  'gpt-5.6-luna',
  'gpt-6-astra',
  'gpt-6-sol',
  'gpt-6.1-sol',
  'gpt-6-luna',
])
// Still API-supported, but retired for Codex with ChatGPT sign-in.
const API_ONLY_MODELS = new Set(['gpt-5.2', 'gpt-5.4'])
const CODEX_ENDPOINTS = new Set([
  'https://chatgpt.com/backend-api',
  'https://chatgpt.com/backend-api/codex',
  'https://chatgpt.com/backend-api/codex/responses',
])

/** An exact supported protocol, official effective endpoint, and documented model. */
function supportsControls(model: Model<Api>): boolean {
  const endpoint = model.baseUrl.replace(/\/+$/, '')
  if (model.api === 'openai-responses' && endpoint === 'https://api.openai.com/v1') {
    return DOCUMENTED_MODELS.has(model.id) || API_ONLY_MODELS.has(model.id)
  }
  return model.api === 'openai-codex-responses' && CODEX_ENDPOINTS.has(endpoint) && DOCUMENTED_MODELS.has(model.id)
}

/**
 * Describe request support without querying an account or changing SDK defaults.
 * @param model - configured exact model and its effective protocol/endpoint.
 * @returns detached selectable controls, or no controls for unverified routes.
 */
export function requestControlInfo(model: Model<Api>): Pick<LlmResolvedModelInfo, 'serviceTier' | 'textVerbosity'> {
  if (!supportsControls(model)) return {}
  return {
    serviceTier: {
      tiers: [
        { id: ServiceTier('default'), name: 'Standard', description: 'Request standard processing rather than the project service-tier default.' },
        { id: ServiceTier('priority'), name: 'Fast · premium', description: 'Request faster processing with higher charges or subscription usage; account availability varies and the provider may use Standard.' },
      ],
    },
    textVerbosity: {
      levels: [
        { id: TextVerbosity('low'), name: 'Low' },
        { id: TextVerbosity('medium'), name: 'Medium' },
        { id: TextVerbosity('high'), name: 'High' },
      ],
      // pi-ai's Codex payload builder already sends low when the control is absent.
      ...model.api === 'openai-codex-responses' ? { defaultLevel: TextVerbosity('low') } : {},
    },
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/**
 * Validate before credentials/I/O and capture only explicit request controls.
 * pi-ai's simple options omit named serviceTier/textVerbosity; onPayload survives
 * both Responses providers and runs before HTTP or WebSocket serialization.
 * @param model - exact model captured with the adapter's profile snapshot.
 * @param options - explicit per-request controls; omission preserves SDK behavior.
 * @returns no hook for omitted controls, otherwise a bounded payload replacement.
 */
export function requestControlOptions(
  model: Model<Api>,
  options: Pick<GenerateOptions, 'serviceTier' | 'textVerbosity'>,
): Pick<SimpleStreamOptions, 'onPayload'> {
  const { serviceTier, textVerbosity } = options
  const info = requestControlInfo(model)
  if (serviceTier !== undefined && !info.serviceTier?.tiers.some(tier => tier.id === serviceTier)) {
    throw new LlmError(`pi-ai model "${model.id}" does not support service tier "${serviceTier}"`, 'UNSUPPORTED_SERVICE_TIER')
  }
  if (textVerbosity !== undefined && !info.textVerbosity?.levels.some(level => level.id === textVerbosity)) {
    throw new LlmError(`pi-ai model "${model.id}" does not support text verbosity "${textVerbosity}"`, 'UNSUPPORTED_TEXT_VERBOSITY')
  }
  if (serviceTier === undefined && textVerbosity === undefined) return {}
  return {
    onPayload(payload) {
      if (!isRecord(payload) || textVerbosity !== undefined && payload.text !== undefined && !isRecord(payload.text)) {
        throw new LlmError('pi-ai Responses payload cannot carry the admitted request controls', 'INVALID_PROVIDER_PAYLOAD')
      }
      return {
        ...payload,
        ...serviceTier === undefined ? {} : { service_tier: serviceTier },
        ...textVerbosity === undefined ? {} : { text: { ...isRecord(payload.text) ? payload.text : {}, verbosity: textVerbosity } },
      }
    },
  }
}
