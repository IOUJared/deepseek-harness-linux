/** Bounded, controller-owned prompt reservations and exact raw-payload receipts. */
import { createHash } from 'node:crypto'
import { RemoteError, remoteErrorOf } from '@deepseek-ai/dsh-typert-protocol'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { assertNever } from '@deepseek-ai/dsh-util-values'
import type { SessionPromptAdmissionValue, SessionPromptRequest, SessionPromptValue, SessionRequestId } from './types.ts'

const MAX_ADMISSIONS = 128

/** Hash declared raw fields, not normalized image/file content or transport identities.
 * @param request - detached raw prompt request.
 * @returns the versioned SHA256 receipt fingerprint.
 */
export function promptFingerprint(request: SessionPromptRequest): string {
  const content = request.content.map(part => {
    switch (part.type) {
      case 'text': return ['text', part.text]
      case 'image': return ['image', part.mediaType, part.data, part.name ?? null]
      case 'file': return ['file', part.receiptId]
      default: return assertNever(part)
    }
  })
  return `v1:sha256:${createHash('sha256').update(JSON.stringify([request.mode, content, request.clientTimeZone ?? null])).digest('hex')}`
}

/** Compare only a recognized stored raw-request fingerprint; legacy content is not equivalent evidence.
 * @param stored - fingerprint read from persisted or pending user-RPC metadata.
 * @param fingerprint - incoming raw-request fingerprint.
 * @param request - transport identities for the fixed conflict diagnostic.
 */
export function assertPromptFingerprint(stored: string | undefined, fingerprint: string, request: Pick<SessionPromptRequest, 'sessionId' | 'requestId'>): void {
  if (stored === fingerprint) return
  throw new RemoteError('session/prompt-conflict', 'Prompt request identity cannot be reused for this payload.', {
    sessionId: request.sessionId, requestId: request.requestId,
    reason: stored !== undefined && /^v1:sha256:[a-f0-9]{64}$/.test(stored) ? 'PAYLOAD_CHANGED' : 'PAYLOAD_UNVERIFIABLE',
  })
}

/** One reserved prompt; only the operation owning it can cross inbox dispatch. */
export interface PromptAdmissionClaim {
  readonly fingerprint: string
  assertOpen(): void
  dispatch(): void
}

interface Entry {
  readonly sessionId: SessionId
  readonly requestId: SessionRequestId
  readonly fingerprint: string
  readonly task: Promise<SessionPromptValue>
  dispatched: boolean
  settled: boolean
  journal: boolean
  status: SessionPromptAdmissionValue
}

function key(sessionId: SessionId, requestId: SessionRequestId): string {
  return JSON.stringify([sessionId, requestId])
}

function rejectionCode(error: unknown): Extract<SessionPromptAdmissionValue, { state: 'rejected' }>['code'] {
  const code = remoteErrorOf(error)?.code
  switch (code) {
    case 'gateway/bad-request':
    case 'session/invalid-time-zone':
    case 'session/attachment-invalid':
    case 'session/not-found':
    case 'session/agent-busy':
    case 'session/prompt-closed':
      return code
    default: return 'gateway/internal'
  }
}

/** Keeps at most 128 reservations; unproven post-dispatch outcomes and claimed work cannot be evicted. */
export class PromptAdmissionLedger {
  private readonly entries = new Map<string, Entry>()
  private readonly lifetime = new AbortController()
  private disposal: Promise<void> | undefined

  /** @param ownerActive - synchronous controller/root-fiber admission authority. */
  constructor(private readonly ownerActive: () => boolean) {}

  /** Reserve before invoking any asynchronous resolver or attachment admission.
   * @param request - request whose detached raw payload this operation will own.
   * @param operation - sole admission executor for this identity.
   * @returns the retained original promise for exact duplicates, without another write.
   */
  admit(request: SessionPromptRequest, operation: (snapshot: SessionPromptRequest, claim: PromptAdmissionClaim) => Promise<SessionPromptValue>): Promise<SessionPromptValue> {
    const snapshot = structuredClone(request)
    const fingerprint = promptFingerprint(snapshot)
    const id = key(snapshot.sessionId, snapshot.requestId)
    const previous = this.entries.get(id)
    if (previous !== undefined) {
      try { assertPromptFingerprint(previous.fingerprint, fingerprint, snapshot) }
      catch (error) { return Promise.reject(error) }
      return previous.task
    }
    if (this.lifetime.signal.aborted || !this.ownerActive()) return Promise.reject(this.closed())
    if (this.entries.size >= MAX_ADMISSIONS) {
      const evictable = [...this.entries].find(([, entry]) => entry.settled
        && (entry.status.state === 'rejected'
          || (entry.journal && !(entry.status.state === 'accepted' && entry.status.phase === 'claimed'))))
      if (evictable === undefined) return Promise.reject(new RemoteError('session/prompt-capacity', 'Prompt admission capacity is exhausted.', {}))
      this.entries.delete(evictable[0])
    }
    // The executor starts in a later microtask, after the complete reservation is installed.
    const task = Promise.resolve().then(async () => {
      const claim: PromptAdmissionClaim = {
        fingerprint,
        assertOpen: () => { if (this.lifetime.signal.aborted || !this.ownerActive()) throw this.closed() },
        dispatch: () => { claim.assertOpen(); entry.dispatched = true },
      }
      try {
        claim.assertOpen()
        const result = await operation(snapshot, claim)
        if (entry.status.state !== 'accepted') entry.status = { state: 'accepted', evidence: 'memory', phase: 'admitted' }
        return result
      } catch (error) {
        if (entry.status.state !== 'accepted') entry.status = entry.dispatched
          ? { state: 'unknown' } : { state: 'rejected', code: rejectionCode(error) }
        throw error
      } finally { entry.settled = true }
    })
    const entry: Entry = { sessionId: snapshot.sessionId, requestId: snapshot.requestId, fingerprint, task,
      dispatched: false, settled: false, journal: false, status: { state: 'admitting' } }
    this.entries.set(id, entry)
    // Retained rejected promises must not become unhandled when an RPC carrier disconnects.
    void task.catch((_error: unknown) => { /* The original caller and status receipt retain the outcome. */ })
    return task
  }

  /** Read current receipt state without reserving or touching eviction order.
   * @param sessionId - Session identity.
   * @param requestId - original client identity.
   * @returns a detached status or no retained receipt.
   */
  status(sessionId: SessionId, requestId: SessionRequestId): SessionPromptAdmissionValue | undefined {
    const entry = this.entries.get(key(sessionId, requestId))
    return entry === undefined ? undefined : { ...entry.status }
  }

  /** Record positive existing journal evidence, not inferred execution.
   * @param sessionId - Session that committed the user message or inbox insertion.
   * @param requestId - persisted original request identity.
   * @param status - positive admitted metadata from that event.
   */
  journal(sessionId: SessionId, requestId: SessionRequestId, status: Extract<SessionPromptAdmissionValue, { state: 'accepted' }>): void {
    const entry = this.entries.get(key(sessionId, requestId))
    if (entry === undefined) return
    entry.journal = true
    // A durable insertion does not supersede an explicitly observed claim.
    if (status.phase === 'admitted' && entry.status.state === 'accepted' && entry.status.phase === 'claimed') return
    entry.status = { ...status }
  }

  /** Preserve an actual driver claim through the pre-user/message preparation gap.
   * @param sessionId - claiming Session.
   * @param requestId - claimed user-RPC identity.
   */
  claimed(sessionId: SessionId, requestId: SessionRequestId): void {
    const entry = this.entries.get(key(sessionId, requestId))
    if (entry !== undefined) entry.status = { state: 'accepted', evidence: 'memory', phase: 'claimed' }
  }

  /** Close admission synchronously and join every operation before controller teardown completes.
   * @returns after pending resolvers/importers can no longer reach the inbox.
   */
  dispose(): Promise<void> {
    if (this.disposal !== undefined) return this.disposal
    this.lifetime.abort()
    this.disposal = Promise.allSettled([...this.entries.values()].map(entry => entry.task)).then(() => {})
    return this.disposal
  }

  private closed(): RemoteError<'session/prompt-closed'> {
    return new RemoteError('session/prompt-closed', 'Prompt admission is closed.', {})
  }
}
