/** Immutable provider-owned identity captured by SDK collections and prepared calls. */
import type { Branded } from '@deepseek-ai/dsh-brand'
import type { PiAiAuthInjection } from './adapter.ts'

/** Random local identity; never an issuer account id or token-derived value. */
export type CodexAccountId = Branded<'CodexAccountId'>

/** One selected account epoch; retirement permanently closes admission. */
export interface PiAiAccountBinding {
  /** Local account identity, also used to isolate SDK session caches. */
  readonly opaqueId: CodexAccountId
  /** Monotonic selected-account generation. */
  readonly epoch: number
  /** Fixed account store plus the ordinary ambient context. */
  readonly auth: PiAiAuthInjection
  /** Aborted synchronously before switching or deleting this account. */
  readonly retireSignal: AbortSignal
  /** Reject retired, deleted, or no-longer-selected epochs. */
  assertCurrent(): void
}
