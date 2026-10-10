/** Immutable JSON snapshots and bounded storage owned by forwarded-event generations. */
import { Deque } from '@deepseek-ai/dsh-deque'
import { RemoteError, isRemoteJsonValue } from '@deepseek-ai/dsh-typert-protocol'
import { projectRemoteEventRequest, REMOTE_EVENT_STREAM_ENDPOINT } from './stream-protocol.ts'
import type { TypertRemoteEventBuffer, TypertRemoteEventContext, TypertRemoteEventDispatch, TypertRemoteEventFrame, TypertRemoteEventInvocation } from './types.ts'

/** Validated count and UTF-8 JSON byte limits for one independently owned buffer. */
export interface EventBufferLimits {
  readonly items: number
  readonly bytes: number
}

/** Immutable serialized data; process-local completion capabilities are counted separately as items. */
export interface EncodedEvent<T> {
  readonly text: string
  readonly bytes: number
  readonly metadata: T
}

/**
 * Validate an event name before serializing queued metadata.
 * @param frame - Source event metadata.
 */
export function assertRemoteEventName(frame: { readonly event: unknown }): void {
  if (typeof frame.event !== 'string' || frame.event.length === 0) {
    throw new TypeError('typert gateway: Remote event name must be a nonempty string')
  }
}

/**
 * Validate lossless notification JSON before any snapshot can normalize it.
 * @param frame - Notification accepted from a source.
 */
export function assertRemoteEventFrame(frame: TypertRemoteEventFrame): void {
  assertRemoteEventName(frame)
  if (!Array.isArray(frame.args) || !isRemoteJsonValue(frame.args)) {
    throw new TypeError(`typert gateway: Remote event ${JSON.stringify(frame.event)} arguments are not lossless JSON data`)
  }
}

/**
 * Capture one validated JSON payload once before fanout.
 * @param value - Complete JSON metadata and application data.
 * @param metadata - Process-local capabilities, excluded from JSON byte accounting.
 * @returns immutable text and its UTF-8 byte count with the supplied capabilities.
 */
export function encodeEvent<T>(value: object, metadata: T): EncodedEvent<T> {
  const text = JSON.stringify(value)
  return { text, bytes: Buffer.byteLength(text, 'utf8'), metadata }
}

/** Bounded FIFO with constant-time admission and release accounting. */
export class EventBuffer<T> {
  private readonly entries = new Deque<EncodedEvent<T>>()
  private bytes = 0
  constructor(private readonly limits: EventBufferLimits) {}
  /** Whether the item limit prevents another admission. */
  get full(): boolean { return this.entries.size >= this.limits.items }
  /**
   * Admit a snapshot without exceeding either limit.
   * @param entry - Immutable JSON text and capabilities.
   * @returns whether admission succeeded; false retains nothing.
   */
  push(entry: EncodedEvent<T>): boolean {
    if (this.full || entry.bytes > this.limits.bytes - this.bytes) return false
    this.entries.pushBack(entry)
    this.bytes += entry.bytes
    return true
  }
  /**
   * Release the oldest snapshot and its byte reservation.
   * @returns the oldest snapshot, or undefined when empty.
   */
  pop(): EncodedEvent<T> | undefined {
    const entry = this.entries.popFront()
    if (entry !== undefined) this.bytes -= entry.bytes
    return entry
  }
}

/**
 * Explicit generation failure without exposing a rejected payload.
 * @param field - Owner whose buffer exceeded its configured limit.
 * @returns the stable forwarded-event overflow failure.
 */
export function eventBufferOverflow(field: 'source' | 'client' | 'pending'): RemoteError<'gateway/event-overflow'> {
  return new RemoteError('gateway/event-overflow', 'Forwarded Remote event buffer exceeded its limit', {
    endpoint: REMOTE_EVENT_STREAM_ENDPOINT, field,
  })
}

function rejectInvocation(invocation: Pick<TypertRemoteEventInvocation, 'reject'> | undefined, reason: unknown): void {
  try { invocation?.reject(reason) }
  catch (_error) { /* A completion callback must not prevent buffer draining or listener disposal. */ }
}

type InvocationMetadata = {
  readonly context: TypertRemoteEventContext
  readonly signal: AbortSignal | undefined
  readonly resolve: TypertRemoteEventInvocation['resolve']
  readonly reject: TypertRemoteEventInvocation['reject']
}

/** Source backlog: JSON is detached at admission; Agent, Context and signal remain live capabilities. */
export class RemoteEventSourceBuffer implements TypertRemoteEventBuffer {
  private readonly buffer: EventBuffer<InvocationMetadata | undefined>
  private waiter: (() => void) | undefined
  private cleanup: (() => void) | undefined
  private readerAttached = false
  private closed: { readonly reason: unknown; readonly failed: boolean } | undefined
  private readonly abort = (): void => { this.end(this.signal.reason, false) }

  constructor(private readonly signal: AbortSignal, limits: EventBufferLimits) {
    this.buffer = new EventBuffer(limits)
    signal.addEventListener('abort', this.abort, { once: true })
    if (signal.aborted) this.abort()
  }

  /**
   * @param frame Dispatch to snapshot, queue or reject under this source's limits.
   * @returns True when consumed or rejected; false after normal source closure.
   */
  push(frame: TypertRemoteEventDispatch): boolean {
    if (this.closed !== undefined) {
      if (this.closed.failed && 'context' in frame) {
        rejectInvocation(frame, this.closed.reason)
        return true
      }
      return false
    }
    if (this.buffer.full) {
      this.overflow(frame)
      return true
    }
    let entry: EncodedEvent<InvocationMetadata | undefined>
    if ('context' in frame) {
      try {
        assertRemoteEventName(frame)
        const context = { value: frame.context.value, subject: frame.context.subject, agentId: frame.context.agentId }
        const projected = projectRemoteEventRequest(frame.request, context.subject)
        entry = encodeEvent({ event: frame.event, agentId: context.agentId, request: projected.request }, {
          context, signal: projected.signal, resolve: frame.resolve, reject: frame.reject,
        })
      } catch (error) {
        rejectInvocation(frame, error)
        return true
      }
    } else {
      assertRemoteEventFrame(frame)
      entry = encodeEvent({ event: frame.event, args: frame.args }, undefined)
    }
    if (!this.buffer.push(entry)) this.overflow(frame)
    else this.waiter?.()
    return true
  }

  iterate(cleanup: () => void): AsyncIterable<TypertRemoteEventDispatch> {
    if (this.readerAttached) throw new Error('typert gateway: Remote event source buffer already has a reader')
    this.readerAttached = true
    this.cleanup = cleanup
    if (this.closed !== undefined) this.releaseListeners()
    return this.read()
  }

  private overflow(frame: TypertRemoteEventDispatch): void {
    const error = eventBufferOverflow('source')
    this.end(error, true)
    if ('context' in frame) rejectInvocation(frame, error)
  }

  private end(reason: unknown, failed: boolean): void {
    if (this.closed !== undefined) return
    this.closed = { reason, failed }
    this.signal.removeEventListener('abort', this.abort)
    let entry
    while ((entry = this.buffer.pop()) !== undefined) rejectInvocation(entry.metadata, reason)
    this.releaseListeners()
    this.waiter?.()
  }

  private releaseListeners(): void {
    const cleanup = this.cleanup
    this.cleanup = undefined
    try { cleanup?.() }
    catch (error) {
      // Keep teardown synchronous; report a cleanup failure through the source reader.
      if (!this.closed?.failed) this.closed = { reason: error, failed: true }
    }
  }

  private async *read(): AsyncGenerator<TypertRemoteEventDispatch> {
    try {
      while (this.closed === undefined) {
        const entry = this.buffer.pop()
        if (entry === undefined) {
          await new Promise<void>((resolve) => { this.waiter = resolve })
          this.waiter = undefined
          continue
        }
        // These bytes were produced by our JSON encoder, not an external parser.
        const data = JSON.parse(entry.text) as { event: string; args: unknown[]; request: Record<string, unknown> }
        const meta = entry.metadata
        if (meta === undefined) yield { event: data.event, args: data.args }
        else yield {
          event: data.event,
          request: { ...data.request, agent: meta.context.subject, ...meta.signal === undefined ? {} : { signal: meta.signal } },
          context: meta.context, resolve: meta.resolve, reject: meta.reject,
        }
      }
      if (this.closed.failed) throw this.closed.reason
    } finally {
      this.end(new Error('api-remotes: forwarded Remote event source ended'), false)
    }
  }
}
