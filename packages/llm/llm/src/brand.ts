/**
 * dsh-llm's owned branded ids: tool-call correlation and provider request
 * diagnostics.
 *
 * The `Branded<B>` primitive and stateless constructor live in
 * `@deepseek-ai/dsh-brand` so every owner of a cross-boundary id can brand it
 * without depending on dsh-llm; see that package's README for the
 * nominal-typing policy.
 *
 * @module @deepseek-ai/dsh-llm/brand
 */

import { brandString, type Branded } from '@deepseek-ai/dsh-brand'

/** Stable identity carried by one message across inbox, log, and model-request boundaries. */
export type MessageId = Branded<'MessageId'>

/**
 * Brand a message identifier.
 * @param id - the opaque message identifier.
 * @returns the same string with the message-id brand.
 */
export function MessageId(id: string): MessageId {
  return brandString<MessageId>(id)
}

/**
 * Correlates a model-issued tool call with its result. Provider-issued for
 * real adapters; synthesized by mocks/assembler fallbacks.
 */
export type ToolCallId = Branded<'ToolCallId'>

/**
 * Brand a string as a {@link ToolCallId}.
 * @param id - the provider-issued or synthesized call id.
 * @returns the same string with the tool-call-id brand.
 */
export function ToolCallId(id: string): ToolCallId {
  return brandString<ToolCallId>(id)
}

/** Provider-issued request identifier retained for diagnostics across package boundaries. */
export type ProviderRequestId = Branded<'ProviderRequestId'>

/**
 * Brand a provider-issued request identifier.
 * @param id - the opaque provider-issued string.
 * @returns the same string, branded; no validation is performed.
 */
export function ProviderRequestId(id: string): ProviderRequestId {
  return brandString<ProviderRequestId>(id)
}

/** Identity of one model streaming attempt, unique within one Agent lifecycle. */
export type LlmAttemptId = Branded<'LlmAttemptId'>

/**
 * Brand one loop-owned streaming attempt identifier.
 * @param id - the opaque Agent-lifecycle-local identifier.
 * @returns the same string with the attempt-id brand.
 */
export function LlmAttemptId(id: string): LlmAttemptId {
  return brandString<LlmAttemptId>(id)
}

/** Adapter-owned identifier for one model's selectable reasoning effort. */
export type ReasoningEffortId = Branded<'ReasoningEffortId'>

/**
 * Brand an adapter-owned reasoning-effort identifier.
 * @param id - the opaque identifier exposed by one model capability.
 * @returns the same string, branded; no validation is performed.
 */
export function ReasoningEffortId(id: string): ReasoningEffortId {
  return brandString<ReasoningEffortId>(id)
}

/** Service tier accepted only by exact models advertising the value. */
export type ServiceTier = ('default' | 'priority') & Branded<'ServiceTier'>

/**
 * Brand an admitted service tier without changing its protocol value.
 * @param value - finite service tier validated by the caller's parser.
 * @returns the branded service tier.
 */
export function ServiceTier(value: 'default' | 'priority'): ServiceTier {
  return brandString<ServiceTier>(value)
}

/** Output detail accepted only by exact models advertising the value. */
export type TextVerbosity = ('low' | 'medium' | 'high') & Branded<'TextVerbosity'>

/**
 * Brand an admitted text verbosity without changing its protocol value.
 * @param value - finite verbosity validated by the caller's parser.
 * @returns the branded text verbosity.
 */
export function TextVerbosity(value: 'low' | 'medium' | 'high'): TextVerbosity {
  return brandString<TextVerbosity>(value)
}
