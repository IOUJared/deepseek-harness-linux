/**
 * Generic pi-ai-backed implementation of the Harness LLM seam.
 *
 * Each resolution produces one **immutable** snapshot — the profiles plus a
 * `Models` collection holding the `Provider` each route built — and an
 * operation captures a whole snapshot before its first `await`. A
 * configuration change builds a *new* collection rather than mutating the one
 * in use, because `Models.streamSimple()` is lazy: it resolves the provider
 * when the stream is first consumed, which is after the credential await, so a
 * mutated collection would let a request that started under one configuration
 * finish under another — or fail with a provider that no longer exists. This is
 * what makes the seam's per-step call freeze (`llm.prepareCall()`) hold all the
 * way down: switching models mid-reply takes effect on the next step, never
 * inside the one in flight.
 *
 * A route naming a credential reference still resolves it through the harness
 * seam and passes it as the request's `apiKey` option, which pi-ai treats as
 * the highest-priority auth override — that is what keeps the fail-loud
 * reference semantics. Everything that override does not cover reaches pi-ai
 * through the collection's own auth: the credential store holds the records a
 * login wrote and a refresh rotates, and the auth context answers the ambient
 * questions a provider asks while resolving. Both are stable across snapshots,
 * so a configuration change rebuilds the collection without forgetting who is
 * signed in.
 *
 * @module dsh-llm-pi-ai/adapter
 */

import { cleanupSessionResources } from '@earendil-works/pi-ai'
import type {
  Api,
  AssistantMessageEventStream,
  AuthContext,
  CredentialStore,
  Model,
  Models,
  ModelThinkingLevel,
  MutableModels,
  SimpleStreamOptions,
  ThinkingLevel,
} from '@earendil-works/pi-ai'
import {
  attributionHeaders,
  contentHasImage,
  LlmAdapter,
  LlmError,
  ReasoningEffortId,
} from '@deepseek-ai/dsh-llm'
import type {
  GenerateOptions,
  ImageAttachmentAccess,
  LlmModelInfo,
  LlmProviderInfo,
  LlmResolvedModelInfo,
  PreparedAdapterCall,
  ReasoningEffortId as ReasoningEffortIdType,
  ResolvedRetryPolicy,
  StreamChunk,
} from '@deepseek-ai/dsh-llm'
import type { AttachmentStore, ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import { idleWatchdog, timeoutOf } from '@deepseek-ai/dsh-timeout'
import { assertManagedCodexProfile, type ResolvedPiAiProviderProfile } from './config.ts'
import { toPiContext } from './context.ts'
import { createModels, getSupportedThinkingLevels } from './models.ts'
import { requestControlInfo, requestControlOptions } from './request-controls.ts'
import { toStreamChunks } from './stream.ts'
import type { PiAiAccountBinding } from './account-binding.ts'

// pi-ai caches by session ID across collections and adapter instances.
const sessionOwners = new Map<string, { count: number }>()

/** One resolution's frozen view: the profiles and the collection built from them. */
interface PiAiSnapshot {
  /** The resolved profiles this collection was built from, used as its identity. */
  profiles: ReadonlyMap<string, ResolvedPiAiProviderProfile>
  /** Providers for exactly those profiles; never mutated once published. */
  models: Models
  /** Managed Codex identity frozen with this collection; absent preserves legacy auth. */
  accountBinding?: PiAiAccountBinding
}

/** Constructor options for {@link PiAiAdapter}: the two resolution hooks the plugin owns. */
export interface PiAiAdapterOptions {
  /** Current validated profiles by provider route; called once per operation. */
  profiles: () => ReadonlyMap<string, ResolvedPiAiProviderProfile>
  /**
   * Resolve the credential for one already-resolved profile; called once per
   * stream call and frozen for that call. `undefined` defers to the route's own
   * pi-ai auth, which for an installed catalog route is its provider-native
   * ambient discovery; the plugin allows that only for a profile naming no
   * credential at all, because a named reference that misses throws `LlmError`
   * `MISSING_CREDENTIAL` rather than falling back.
   */
  resolveApiKey: (provider: string, profile: ResolvedPiAiProviderProfile) => Promise<string | undefined>
  /**
   * How every collection this adapter builds resolves auth the request-level
   * `apiKey` override does not cover. Required rather than optional: a
   * collection built without them gets pi-ai's in-memory default store, which
   * is empty at every boot and discarded on every configuration change, so a
   * route whose only method is a login would report itself unconfigured on
   * every request no matter how often the human signed in.
   */
  auth: PiAiAuthInjection
  /** Explicit account-owner integration only; omission keeps the fixed legacy store. */
  accountBinding?: () => PiAiAccountBinding
  /** Resolve the optional durable attachment service at request time. */
  resolveAttachments?: () => AttachmentStore | undefined
  /** Bridge one attachment reference into the current model-tool execution world. */
  resolveImageAccess?: (attachments: AttachmentStore, ref: ImageAttachmentRef) => ImageAttachmentAccess | undefined
  /**
   * Observe one assistant history message degrading to provider-neutral
   * conversion because its stored replay state is unusable by this build.
   */
  onReplayDegrade?: (detail: { provider: string; model: string; reason: string }) => void
}

/** The two auth injectables a pi-ai collection is built with. */
export interface PiAiAuthInjection {
  /** Durable storage for credentials pi-ai itself writes: logins, and the refreshes it runs under its own lock. */
  credentials: CredentialStore
  /** Ambient lookups a provider performs while resolving its own auth. */
  authContext: AuthContext
}

/** Copy profile stream knobs into pi-ai's common option vocabulary. */
function profileOptions(
  profile: ResolvedPiAiProviderProfile,
  reasoning: ModelThinkingLevel | undefined,
  apiKey: string | undefined,
): SimpleStreamOptions {
  const enabledReasoning: ThinkingLevel | undefined = reasoning === 'off' ? undefined : reasoning
  return {
    ...apiKey === undefined ? {} : { apiKey },
    ...enabledReasoning === undefined ? {} : { reasoning: enabledReasoning },
    ...profile.thinkingBudgets === undefined ? {} : { thinkingBudgets: profile.thinkingBudgets },
    ...profile.cacheRetention === undefined ? {} : { cacheRetention: profile.cacheRetention },
    ...profile.transport === undefined ? {} : { transport: profile.transport },
    ...profile.timeoutMs === undefined ? {} : { timeoutMs: profile.timeoutMs },
    ...profile.websocketConnectTimeoutMs === undefined ? {} : { websocketConnectTimeoutMs: profile.websocketConnectTimeoutMs },
    // The agent recovery layer owns visible attempts; one adapter call is one SDK attempt.
    maxRetries: 0,
  }
}

/**
 * The profile default this exact model can actually take, for DESCRIBING it.
 * A configured level the model does not support yields none rather than
 * throwing: `resolveModel` builds the model catalog, and a catalog that fails
 * takes its whole provider out of every picker — so one mis-set profile field
 * would hide every model on the route, including the ones that support the
 * level. The request path still refuses, which is where a bad configuration
 * belongs: describing what a model can do must not fail because a deployment
 * asked it for something it cannot.
 * @param model - the resolved model descriptor.
 * @param effort - the profile's configured level, if any.
 * @returns the level when this model supports it, otherwise undefined.
 */
function describableReasoningLevel(
  model: Model<Api>,
  effort: ReasoningEffortIdType | ModelThinkingLevel | undefined,
): ModelThinkingLevel | undefined {
  if (effort === undefined) return undefined
  return getSupportedThinkingLevels(model).some(level => level === effort)
    ? effort as ModelThinkingLevel
    : undefined
}

/** Validate an explicit Harness/profile effort without invoking pi-ai's clamp. */
function resolveReasoningLevel(
  model: Model<Api>,
  effort: ReasoningEffortIdType | ModelThinkingLevel | undefined,
): ModelThinkingLevel | undefined {
  if (effort === undefined) return undefined
  const supported = getSupportedThinkingLevels(model)
  if (supported.some(level => level === effort)) return effort as ModelThinkingLevel
  throw new LlmError(
    `pi-ai provider "${model.provider}" model "${model.id}" does not support reasoning effort "${effort}"`,
    'UNSUPPORTED_REASONING_EFFORT',
  )
}

/**
 * Selectable reasoning efforts for one model, or nothing at all.
 *
 * A model that carries no reasoning metadata — every hand-declared one, and
 * every catalog model pi-ai marks as non-reasoning — is reported by pi-ai as
 * supporting the single level `off`. Passing that through would offer a control
 * that cannot do what it says: `off` is translated to *omitting* the reasoning
 * option, which for such a model is byte-for-byte the same request as naming no
 * effort — so a provider whose own default is to think would keep thinking with
 * `off` selected. Omitting `reasoning` entirely is the seam's way of saying the
 * capability is unavailable, which leaves the surface offering only the
 * provider's default.
 * @param model - the resolved model descriptor.
 * @param defaultLevel - the profile's configured effort, already validated.
 * @returns the `reasoning` field, or an empty object when none can be offered.
 */
function reasoningInfo(
  model: Model<Api>,
  defaultLevel: ModelThinkingLevel | undefined,
): Pick<LlmResolvedModelInfo, 'reasoning'> | Record<string, never> {
  if (!model.reasoning) return {}
  const levels = getSupportedThinkingLevels(model)
  return {
    reasoning: {
      efforts: levels.map(level => ({
        id: ReasoningEffortId(level),
        name: `${level.charAt(0).toUpperCase()}${level.slice(1)}`,
      })),
      ...defaultLevel === undefined ? {} : { defaultEffort: ReasoningEffortId(defaultLevel) },
    },
  }
}

/** Merge deployment headers while removing case-insensitive attribution collisions. */
function requestHeaders(headers: Readonly<Record<string, string>> | undefined): Record<string, string> {
  const attribution = attributionHeaders()
  const reserved = new Set(Object.keys(attribution).map(name => name.toLowerCase()))
  return {
    ...Object.fromEntries(Object.entries(headers ?? {}).filter(([name]) => !reserved.has(name.toLowerCase()))),
    ...attribution,
  }
}

/**
 * pi-ai-backed multi-provider adapter. Each operation reads the current
 * profiles, so a configuration change reaches the next request without a
 * restart; model descriptors come from the collection those profiles built.
 */
export class PiAiAdapter extends LlmAdapter {
  private snapshot: PiAiSnapshot | undefined
  private readonly sessionIds = new Map<string, { count: number }>()
  private readonly accountSessions = new Map<string, PiAiAccountBinding>()
  private readonly retiredBindings = new WeakMap<PiAiAccountBinding, Promise<void>>()
  private disposed = false
  private disposal: Promise<void> | undefined
  private readonly activeStreams = new Set<{
    consumer: AbortController
    iterator: AsyncGenerator<StreamChunk>
    terminal: Promise<unknown>
    accountBinding?: PiAiAccountBinding
  }>()

  constructor(private readonly config: PiAiAdapterOptions) {
    super()
  }

  /**
   * Close stream admission, abort SDK-admitted requests and await their terminal
   * results and iterator closure, then retire owned session resources. Shared IDs remain until their last adapter owner
   * disposes. Every unshared ID is attempted even if draining or cleanup fails.
   * SDK cleanup initiates socket close without awaiting ACK.
   * @returns the shared disposal task, rejecting with aggregated failures.
   */
  dispose(): Promise<void> {
    this.disposed = true
    return this.disposal ??= this.retireResources()
  }

  /**
   * Drain one synchronously retired account epoch without disposing other routes.
   * @param binding - exact immutable epoch; its retirement signal must already be aborted.
   * @returns after SDK terminal leases and isolated session caches retire.
   */
  retireAccountBinding(binding: PiAiAccountBinding): Promise<void> {
    if (!binding.retireSignal.aborted) {
      return Promise.reject(new LlmError('Retire the account epoch before drainage', 'ACCOUNT_NOT_RETIRED'))
    }
    const previous = this.retiredBindings.get(binding)
    if (previous !== undefined) return previous
    const task = this.drainResources(binding)
    this.retiredBindings.set(binding, task)
    return task
  }

  private retireResources(): Promise<void> {
    return this.drainResources()
  }

  private async drainResources(binding?: PiAiAccountBinding): Promise<void> {
    const active = [...this.activeStreams].filter(stream => binding === undefined || stream.accountBinding === binding)
    for (const { consumer } of active) consumer.abort('pi-ai SDK owner retired')
    const drained = await Promise.allSettled(active.flatMap(({ iterator, terminal }) => [iterator.return(undefined), terminal]))
    const errors: unknown[] = []
    for (const result of drained) {
      if (result.status === 'rejected') errors.push(result.reason)
    }
    for (const [sessionId, owners] of this.sessionIds) {
      if (binding !== undefined && this.accountSessions.get(sessionId) !== binding) continue
      this.sessionIds.delete(sessionId)
      this.accountSessions.delete(sessionId)
      if (--owners.count > 0) continue
      sessionOwners.delete(sessionId)
      try {
        cleanupSessionResources(sessionId)
      } catch (error) {
        errors.push(error)
      }
    }
    if (errors.length > 0) throw new AggregateError(errors, 'Failed to dispose pi-ai adapter session resources')
  }

  private assertStreamAdmission(): void {
    if (this.disposed) throw new LlmError('pi-ai adapter is disposed', 'ADAPTER_DISPOSED')
  }

  private ownSession(sessionId: string | undefined, accountBinding?: PiAiAccountBinding): void {
    this.assertStreamAdmission()
    accountBinding?.assertCurrent()
    // Codex treats an empty ID like an omitted ID, including for global cleanup.
    if (sessionId === undefined || sessionId.length === 0 || this.sessionIds.has(sessionId)) return
    const owners = sessionOwners.get(sessionId) ?? { count: 0 }
    owners.count++
    sessionOwners.set(sessionId, owners)
    this.sessionIds.set(sessionId, owners)
    if (accountBinding !== undefined) this.accountSessions.set(sessionId, accountBinding)
  }

  /**
   * The snapshot for the current profiles. Resolution memoizes its result, so
   * an unchanged configuration is recognized by identity; a changed one gets a
   * brand-new collection, leaving any snapshot an operation already captured
   * untouched for as long as that operation holds it.
   */
  private current(provider: string, generation = false): PiAiSnapshot {
    const profiles = this.config.profiles()
    if (provider === 'openai-codex' && this.config.accountBinding !== undefined) {
      const profile = profiles.get(provider)
      if (profile !== undefined) assertManagedCodexProfile(profile)
    }
    const accountBinding = generation && provider === 'openai-codex' ? this.config.accountBinding?.() : undefined
    if (this.snapshot?.profiles === profiles && this.snapshot.accountBinding === accountBinding) return this.snapshot
    const models: MutableModels = createModels(accountBinding?.auth ?? this.config.auth)
    for (const profile of profiles.values()) {
      if (profile.piProvider !== undefined) models.setProvider(profile.piProvider)
    }
    this.snapshot = { profiles, models, ...accountBinding === undefined ? {} : { accountBinding } }
    return this.snapshot
  }

  /** The profile for one route within one snapshot, or the not-owned failure. */
  private profileOf(snapshot: PiAiSnapshot, provider: string): ResolvedPiAiProviderProfile {
    const profile = snapshot.profiles.get(provider)
    if (profile === undefined) {
      throw new LlmError(`pi-ai adapter does not own provider "${provider}"`, 'NO_ADAPTER')
    }
    return profile
  }

  /** The configured descriptor for one exact route/model pair within one snapshot. */
  private modelOf(snapshot: PiAiSnapshot, provider: string, model: string): Model<Api> {
    const profile = this.profileOf(snapshot, provider)
    const failure = profile.modelErrors.get(model)
      ?? (profile.piProvider === undefined ? profile.catalogError : undefined)
    if (failure !== undefined) throw new LlmError(failure, 'INVALID_CONFIG')
    const resolved = snapshot.models.getModel(provider, model)
    if (resolved === undefined) {
      throw new LlmError(`pi-ai provider "${provider}" has no configured model "${model}"`, 'UNKNOWN_MODEL')
    }
    return resolved
  }

  override providerInfo(provider: string): LlmProviderInfo {
    // The configured name, not the route key: `displayName` exists so a
    // deployment can label a route, and a label only the configuration surface
    // reads would leave every selector showing the raw key.
    return { id: provider, name: this.current(provider).profiles.get(provider)?.displayName ?? provider }
  }

  override providerRetryPolicy(provider: string): ResolvedRetryPolicy | undefined {
    return this.current(provider).profiles.get(provider)?.retryPolicy
  }

  override listModels(provider: string): Promise<readonly LlmModelInfo[]> {
    return Promise.resolve().then(() => {
      const snapshot = this.current(provider)
      this.profileOf(snapshot, provider)
      return snapshot.models.getModels(provider).map(model => ({
        provider,
        id: model.id,
        name: model.name,
        inputModalities: [...model.input],
      }))
    })
  }

  override resolveModel(
    provider: string,
    model: string,
    _signal?: AbortSignal,
  ): Promise<LlmResolvedModelInfo> {
    return Promise.resolve().then(() => {
      const snapshot = this.current(provider)
      return this.modelInfo(snapshot, provider, model)
    })
  }

  private modelInfo(snapshot: PiAiSnapshot, provider: string, model: string): LlmResolvedModelInfo {
    const profile = this.profileOf(snapshot, provider)
    const resolvedModel = this.modelOf(snapshot, provider, model)
    const defaultLevel = describableReasoningLevel(resolvedModel, profile.reasoning)
    // Only a cap the deployment configured is a request default; the
    // catalog's `maxTokens` sizes the model and stops there.
    const configuredMaxTokens = profile.configuredMaxTokens.get(model)
    return {
      provider,
      id: model,
      name: resolvedModel.name,
      inputModalities: [...resolvedModel.input],
      context: { contextWindow: resolvedModel.contextWindow },
      ...configuredMaxTokens === undefined ? {} : { defaultMaxTokens: configuredMaxTokens },
      ...reasoningInfo(resolvedModel, defaultLevel),
      ...requestControlInfo(resolvedModel),
    }
  }

  override prepareCall(provider: string, model: string, _signal?: AbortSignal): Promise<PreparedAdapterCall> {
    const snapshot = this.current(provider, true)
    return Promise.resolve({
      model: this.modelInfo(snapshot, provider, model),
      stream: options => this.streamWithSnapshot(options, snapshot),
    })
  }

  stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    return this.streamWithSnapshot(options, this.current(options.provider, true))
  }

  private streamWithSnapshot(options: GenerateOptions, snapshot: PiAiSnapshot): AsyncIterable<StreamChunk> {
    const consumer = new AbortController()
    const iterator = this.iterateWithSnapshot(options, snapshot, consumer, (events) => {
      const active = {
        consumer, iterator, terminal: events.result(),
        ...options.provider === 'openai-codex' && snapshot.accountBinding !== undefined
          ? { accountBinding: snapshot.accountBinding } : {},
      }
      this.activeStreams.add(active)
      return () => { this.activeStreams.delete(active) }
    })
    return iterator
  }

  private async * iterateWithSnapshot(
    options: GenerateOptions,
    snapshot: PiAiSnapshot,
    consumer: AbortController,
    admit: (events: AssistantMessageEventStream) => () => void,
  ): AsyncGenerator<StreamChunk> {
    this.assertStreamAdmission()
    const accountBinding = options.provider === 'openai-codex' ? snapshot.accountBinding : undefined
    accountBinding?.assertCurrent()
    if (options.stop !== undefined) {
      throw new LlmError('llm-pi-ai does not support GenerateOptions.stop', 'UNSUPPORTED_OPTION')
    }
    // One capture per stream call, taken before any await: the profile, the
    // model descriptor, and the collection all come from the same immutable
    // snapshot, and the credential freezes with them. A configuration change
    // mid-request builds a separate snapshot, so this request finishes under
    // the one it started with and the next call picks up the new one.
    const profile = this.profileOf(snapshot, options.provider)
    const model = this.modelOf(snapshot, options.provider, options.model)
    const reasoning = resolveReasoningLevel(
      model,
      options.reasoningEffort ?? profile.reasoning,
    )
    const controls = requestControlOptions(model, options)
    if (accountBinding !== undefined && profile.apiKeyEnv !== undefined) {
      throw new LlmError('Managed Codex accounts cannot use an apiKeyEnv override', 'ACCOUNT_AUTH_OVERRIDE')
    }
    const apiKey = await this.config.resolveApiKey(options.provider, profile)
    accountBinding?.assertCurrent()
    if (accountBinding !== undefined && apiKey !== undefined) {
      throw new LlmError('Managed Codex accounts cannot use a request credential override', 'ACCOUNT_AUTH_OVERRIDE')
    }

    const signals = [consumer.signal]
    if (options.signal !== undefined) signals.push(options.signal)
    if (accountBinding !== undefined) signals.push(accountBinding.retireSignal)
    const upstream = AbortSignal.any(signals)
    const streamIdleTimeoutMs = profile.streamIdleTimeoutMs
    using watchdog = idleWatchdog(upstream, streamIdleTimeoutMs, 'LLM_STREAM_IDLE_TIMEOUT')
    let retireStream: (() => void) | undefined
    let sdkTerminal: Promise<unknown> | undefined

    try {
      const containsImage = options.messages.some(message => contentHasImage(message.content))
      if (containsImage && !model.input.includes('image')) {
        throw new LlmError(`pi-ai model "${model.id}" does not support image input`, 'UNSUPPORTED_CONTENT')
      }
      const attachments = containsImage ? this.config.resolveAttachments?.() : undefined
      if (containsImage && attachments === undefined) {
        throw new LlmError('pi-ai image input requires the durable attachment service', 'UNSUPPORTED_CONTENT')
      }
      const onReplayDegrade = (reason: string): void => {
        this.config.onReplayDegrade?.({ provider: options.provider, model: options.model, reason })
      }
      const context = attachments === undefined
        ? toPiContext(options, undefined, onReplayDegrade)
        : await toPiContext({ ...options, signal: watchdog.signal }, {
          attachments,
          resolveImageAccess: ref => this.config.resolveImageAccess?.(attachments, ref),
          maxRequestImageBytes: profile.maxRequestImageBytes,
          requestImagePolicy: {
            maxPixels: profile.requestImagePixelBudget,
            maxBytes: profile.requestImageMaxBytes,
          },
        }, onReplayDegrade)
      const sessionId = options.sessionId === undefined ? undefined
        : accountBinding === undefined || String(options.sessionId).length === 0 ? String(options.sessionId)
          : `${accountBinding.opaqueId}:${accountBinding.epoch}:${String(options.sessionId)}`
      this.ownSession(sessionId, accountBinding)
      const events = snapshot.models.streamSimple(model, context, {
        ...profileOptions(profile, reasoning, apiKey),
        ...controls,
        ...options.temperature === undefined ? {} : { temperature: options.temperature },
        ...options.maxTokens === undefined ? {} : { maxTokens: options.maxTokens },
        ...sessionId === undefined ? {} : { sessionId },
        signal: watchdog.signal,
        // Profile headers are deployment-owned; attribution names are
        // Harness-owned and therefore win collisions.
        headers: requestHeaders(profile.headers),
      })
      sdkTerminal = events.result()
      retireStream = admit(events)
      const iterator = toStreamChunks(events, model.contextWindow, options.signal, model.id)[Symbol.asyncIterator]()
      let exhausted = false
      try {
        while (true) {
          const result = await watchdog.next(iterator)
          const timeout = timeoutOf(watchdog.signal, 'LLM_STREAM_IDLE_TIMEOUT')
          if (timeout !== undefined) throw timeout
          if (result.done) {
            exhausted = true
            return
          }
          yield result.value
        }
      } finally {
        if (!exhausted) {
          consumer.abort('pi-ai stream consumer stopped')
          try {
            await iterator.return(undefined)
          } catch (_abortedSdkTeardown) {
            // The stable signal already owns SDK termination; return-time abort cannot add an outcome.
          }
        }
      }
    } catch (error: unknown) {
      if (timeoutOf(watchdog.signal, 'LLM_STREAM_IDLE_TIMEOUT') !== undefined) {
        throw new LlmError(`pi-ai stream idle timeout after ${streamIdleTimeoutMs}ms`, 'TIMEOUT', { cause: error })
      }
      if (options.signal?.aborted) {
        throw new LlmError('pi-ai request aborted by caller', 'ABORTED', { cause: error })
      }
      throw error
    } finally {
      consumer.abort('pi-ai stream consumer stopped')
      try {
        // EventStream.return() stops iteration, not the SDK background producer.
        await sdkTerminal
      } finally {
        retireStream?.()
      }
    }
  }
}
