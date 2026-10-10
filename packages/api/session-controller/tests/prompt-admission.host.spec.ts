/** Prompt reservations, positive inbox/journal evidence and nondeterministic admission races. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { brandString } from '@deepseek-ai/dsh-brand'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { UserMessage } from '@deepseek-ai/dsh-session'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import type { FileUploadReceiptId } from '@deepseek-ai/dsh-client-file-upload/types'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import { PromptAdmissionLedger, promptFingerprint, assertPromptFingerprint } from '../src/prompt-admission.ts'
import type { SessionPromptRequest, SessionRequestId } from '../src/types.ts'
import { createSessionTestController } from './test-remote.ts'

function request(id = 'PUBLIC-request', text = 'PUBLIC work'): SessionPromptRequest {
  return { sessionId: SessionId('PUBLIC-session'), requestId: brandString<SessionRequestId>(id), mode: 'queue',
    content: [{ type: 'text', text }] }
}
const accepted = { accepted: true } as const
const contexts = new Set<Context>()
afterEach(async () => {
  for (const ctx of contexts) await ctx.fiber.dispose()
  contexts.clear()
  vi.restoreAllMocks()
})

async function harness() {
  const ctx = new Context()
  contexts.add(ctx)
  await mountAgentLoopTestDependencies(ctx)
  const driver = await mountAgentLoopTestHarness(ctx)
  const agent = await driver.create(request().sessionId, { provider: 'PUBLIC-provider', model: 'PUBLIC-model' }, { cwd: '/PUBLIC-workspace' })
  const controller = createSessionTestController(ctx, {
    defaultModelSelection: () => ({ provider: 'PUBLIC-provider', model: 'PUBLIC-model' }), cwd: '/PUBLIC-workspace',
  })
  // Unit admission tests hold the wake separately; the real Inbox still records every insertion/claim.
  const followup = vi.spyOn(agent, 'followup').mockImplementation((message: UserMessage) => agent.inbox.append('next-turn', message))
  const steer = vi.spyOn(agent, 'steer').mockImplementation((message: UserMessage) => agent.inbox.append('next-step', message))
  return { ctx, agent, controller, driver, followup, steer }
}

describe('bounded prompt admission ledger', () => {
  it('shares the original promise, detached raw payload and terminal result before asynchronous work', async () => {
    const ledger = new PromptAdmissionLedger(() => true)
    const entered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const mutableText = { type: 'text' as const, text: 'PUBLIC work' }
    const raw = { ...request(), content: [mutableText] }
    const executor = vi.fn(async (snapshot: SessionPromptRequest) => {
      entered.resolve()
      await release.promise
      expect(snapshot.content).toEqual([{ type: 'text', text: 'PUBLIC work' }])
      return accepted
    })
    const first = ledger.admit(raw, executor)
    const duplicate = ledger.admit({ ...raw, content: [{ text: 'PUBLIC work', type: 'text' }] }, executor)
    expect(duplicate).toBe(first)
    mutableText.text = 'PUBLIC caller mutation after reservation'
    await entered.promise
    expect(ledger.status(raw.sessionId, raw.requestId)).toEqual({ state: 'admitting' })
    try {
      await expect(ledger.admit({ ...raw, content: [{ type: 'text', text: 'PUBLIC changed' }] }, executor))
        .rejects.toMatchObject({ code: 'session/prompt-conflict', details: { reason: 'PAYLOAD_CHANGED' } })
    } finally { release.resolve() }
    expect(await first).toBe(accepted)
    expect(await duplicate).toBe(accepted)
    expect(executor).toHaveBeenCalledOnce()
    await ledger.dispose()
  })

  it('hashes original ordered image/file fields, delivery mode and raw timezone independently of object field order', () => {
    const original: SessionPromptRequest = { ...request(), clientTimeZone: 'US/Pacific', content: [
      { type: 'image', mediaType: 'image/png', data: 'PUBLIC-base64', name: 'PUBLIC image' },
      { type: 'file', receiptId: brandString<FileUploadReceiptId>('PUBLIC-upload') },
    ] }
    expect(promptFingerprint(original)).toMatch(/^v1:sha256:[a-f0-9]{64}$/)
    const variants: SessionPromptRequest[] = [
      { ...original, mode: 'steer' }, { ...original, clientTimeZone: 'America/Los_Angeles' },
      { ...original, content: [...original.content].reverse() },
      { ...original, content: [{ type: 'image', mediaType: 'image/png', data: 'PUBLIC-other', name: 'PUBLIC image' }, original.content[1]!] },
      { ...original, content: [{ type: 'image', mediaType: 'image/png', data: 'PUBLIC-base64', name: 'PUBLIC renamed' }, original.content[1]!] },
      { ...original, content: [original.content[0]!, { type: 'file', receiptId: brandString<FileUploadReceiptId>('PUBLIC-other-upload') }] },
    ]
    for (const variant of variants) expect(promptFingerprint(variant)).not.toBe(promptFingerprint(original))
    expect(promptFingerprint({ ...original, requestId: brandString<SessionRequestId>('PUBLIC-other-id'), sessionId: SessionId('PUBLIC-other-session') }))
      .toBe(promptFingerprint(original))
    expect(() => assertPromptFingerprint(undefined, promptFingerprint(original), original))
      .toThrow(expect.objectContaining({ code: 'session/prompt-conflict', details: expect.objectContaining({ reason: 'PAYLOAD_UNVERIFIABLE' }) }))
  })

  it('retains identical failures and distinguishes definite rejection from unproven post-dispatch outcome', async () => {
    const ledger = new PromptAdmissionLedger(() => true)
    const failure = new RemoteError('session/attachment-invalid', 'PUBLIC invalid', { reason: 'PUBLIC_INVALID' })
    const before = request('PUBLIC-before')
    const rejection = ledger.admit(before, async () => { throw failure })
    await expect(rejection).rejects.toBe(failure)
    expect(ledger.admit(before, async () => accepted)).toBe(rejection)
    expect(ledger.status(before.sessionId, before.requestId)).toEqual({ state: 'rejected', code: 'session/attachment-invalid' })
    const after = request('PUBLIC-after')
    const uncertain = ledger.admit(after, async (_snapshot, claim) => { claim.dispatch(); throw failure })
    await expect(uncertain).rejects.toBe(failure)
    expect(ledger.status(after.sessionId, after.requestId)).toEqual({ state: 'unknown' })
    expect(ledger.admit(after, async () => accepted)).toBe(uncertain)
    await ledger.dispose()
  })

  it('retains unknown after AgentBusy unless actual positive journal evidence exists', async () => {
    const ledger = new PromptAdmissionLedger(() => true)
    const busy = new RemoteError('session/agent-busy', 'PUBLIC busy after possible admission', { reason: 'PUBLIC_BUSY' })
    const unknown = request('PUBLIC-busy-unknown')
    await expect(ledger.admit(unknown, async (_snapshot, claim) => { claim.dispatch(); throw busy })).rejects.toBe(busy)
    expect(ledger.status(unknown.sessionId, unknown.requestId)).toEqual({ state: 'unknown' })
    const observed = request('PUBLIC-busy-observed')
    const failed = ledger.admit(observed, async (_snapshot, claim) => {
      claim.dispatch()
      ledger.journal(observed.sessionId, observed.requestId, { state: 'accepted', evidence: 'journal', phase: 'admitted', seq: 1 })
      throw busy
    })
    await expect(failed).rejects.toBe(busy)
    expect(ledger.status(observed.sessionId, observed.requestId)).toEqual({ state: 'accepted', evidence: 'journal', phase: 'admitted', seq: 1 })
    expect(ledger.admit(observed, async () => accepted)).toBe(failed)
    await ledger.dispose()
  })

  it('denies a 129th unsettled reservation while exact duplicates still join', async () => {
    const ledger = new PromptAdmissionLedger(() => true)
    const release = Promise.withResolvers<void>()
    const originals = Array.from({ length: 128 }, (_unused, index) => request(`PUBLIC-${index}`))
    const operation = vi.fn(async () => { await release.promise; return accepted })
    const tasks = originals.map(raw => ledger.admit(raw, operation))
    try {
      await expect(ledger.admit(request('PUBLIC-overflow'), operation)).rejects.toMatchObject({ code: 'session/prompt-capacity' })
      expect(ledger.admit(originals[0]!, operation)).toBe(tasks[0])
    } finally { release.resolve() }
    await Promise.all(tasks)
    expect(operation).toHaveBeenCalledTimes(128)
    await ledger.dispose()
  })

  it('does not evict 128 indeterminate dispatched failures to make room for another write', async () => {
    const ledger = new PromptAdmissionLedger(() => true)
    const operation = vi.fn(async (_snapshot: SessionPromptRequest, claim: { dispatch(): void }) => {
      claim.dispatch(); throw new RemoteError('session/agent-busy', 'PUBLIC uncertain dispatch', { reason: 'PUBLIC_BUSY' })
    })
    const first = request('PUBLIC-uncertain-0')
    const retained = ledger.admit(first, operation)
    await expect(retained).rejects.toMatchObject({ code: 'session/agent-busy' })
    for (let index = 1; index < 128; index++) {
      await expect(ledger.admit(request(`PUBLIC-uncertain-${index}`), operation)).rejects.toMatchObject({ code: 'session/agent-busy' })
    }
    expect(ledger.status(first.sessionId, first.requestId)).toEqual({ state: 'unknown' })
    await expect(ledger.admit(request('PUBLIC-overflow'), operation)).rejects.toMatchObject({ code: 'session/prompt-capacity' })
    expect(ledger.admit(first, operation)).toBe(retained)
    expect(operation).toHaveBeenCalledTimes(128)
    await ledger.dispose()
  })

  it('can evict a settled definite pre-dispatch rejection without disturbing remaining reservations', async () => {
    const ledger = new PromptAdmissionLedger(() => true)
    const original = request('PUBLIC-rejected-0')
    for (let index = 0; index < 128; index++) {
      await expect(ledger.admit(request(`PUBLIC-rejected-${index}`), async () => {
        throw new RemoteError('gateway/bad-request', 'PUBLIC empty intent', {})
      })).rejects.toMatchObject({ code: 'gateway/bad-request' })
    }
    await expect(ledger.admit(request('PUBLIC-overflow'), async () => accepted)).resolves.toEqual(accepted)
    expect(ledger.status(original.sessionId, original.requestId)).toBeUndefined()
    expect(ledger.status(original.sessionId, request('PUBLIC-rejected-1').requestId)).toEqual({ state: 'rejected', code: 'gateway/bad-request' })
    await ledger.dispose()
  })

  it('never evicts claimed entries but can retire a journal-recorded terminal receipt', async () => {
    const ledger = new PromptAdmissionLedger(() => true)
    for (let index = 0; index < 128; index++) {
      const raw = request(`PUBLIC-claimed-${index}`)
      await ledger.admit(raw, async () => accepted)
      ledger.journal(raw.sessionId, raw.requestId, { state: 'accepted', evidence: 'journal', phase: 'admitted', seq: index })
      ledger.claimed(raw.sessionId, raw.requestId)
    }
    await expect(ledger.admit(request('PUBLIC-overflow'), async () => accepted)).rejects.toMatchObject({ code: 'session/prompt-capacity' })
    const recorded = request('PUBLIC-claimed-0')
    ledger.journal(recorded.sessionId, recorded.requestId, { state: 'accepted', evidence: 'journal', phase: 'recorded', seq: 129 })
    await expect(ledger.admit(request('PUBLIC-overflow'), async () => accepted)).resolves.toEqual(accepted)
    await ledger.dispose()
  })
})

describe('Session Controller prompt admission evidence', () => {
  it('imports and enqueues once when exact duplicate prompts race behind attachment admission', async () => {
    const { ctx, controller, agent, followup } = await harness()
    const binding = vi.spyOn(ctx.fileUploads, 'bindPrompt')
    const original = ctx.attachments.admitPromptContent.bind(ctx.attachments)
    const entered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const admission = vi.spyOn(ctx.attachments, 'admitPromptContent').mockImplementation(async content => {
      entered.resolve(); await release.promise; return original(content)
    })
    const raw = request()
    const first = controller.prompt(raw, new AbortController().signal)
    const second = controller.prompt(raw, new AbortController().signal)
    expect(second).toBe(first)
    await entered.promise
    try {
      expect(await controller.promptAdmission(raw, new AbortController().signal)).toEqual({ state: 'admitting' })
      await expect(controller.prompt({ ...raw, mode: 'steer' }, new AbortController().signal)).rejects.toMatchObject({ code: 'session/prompt-conflict' })
      expect(agent.inbox.nextTurn).toEqual([])
    } finally { release.resolve() }
    await first
    await second
    expect(admission).toHaveBeenCalledOnce()
    expect(binding).toHaveBeenCalledOnce()
    expect(followup).toHaveBeenCalledOnce()
    expect(agent.session.snapshotEvents().filter(event => event.type === 'agent/inbox/spliced')).toHaveLength(1)
    expect(agent.inbox.nextTurn).toHaveLength(1)
    expect(await controller.promptAdmission(raw, new AbortController().signal)).toMatchObject({ state: 'accepted', evidence: 'inbox', phase: 'queued' })
  })

  it('reports actual inbox acceptance even when the first inbox call subsequently throws AgentBusy', async () => {
    const { controller, agent, followup } = await harness()
    const busy = new RemoteError('session/agent-busy', 'PUBLIC error after inbox insertion', { reason: 'PUBLIC_BUSY' })
    followup.mockImplementation((message: UserMessage) => { agent.inbox.append('next-turn', message); throw busy })
    const raw = request()
    const first = controller.prompt(raw, new AbortController().signal)
    await expect(first).rejects.toBe(busy)
    expect(await controller.promptAdmission(raw, new AbortController().signal)).toMatchObject({
      state: 'accepted', evidence: 'inbox', phase: 'queued',
    })
    expect(controller.prompt(raw, new AbortController().signal)).toBe(first)
    expect(followup).toHaveBeenCalledOnce()
  })

  it('keeps positive evidence across the real Inbox claim before user/message exists and rejects payload reuse', async () => {
    const { agent, controller, driver, followup } = await harness()
    const raw = request()
    const first = controller.prompt(raw, new AbortController().signal)
    await first
    const claimed = driver.claim(agent, 'next-turn', 1)
    expect(agent.inbox.nextTurn).toEqual([])
    expect(agent.session.snapshotEvents().some(event => event.type === 'user/message')).toBe(false)
    expect(await controller.promptAdmission(raw, new AbortController().signal)).toMatchObject({ state: 'accepted', phase: 'claimed', evidence: 'memory' })
    expect(controller.prompt(raw, new AbortController().signal)).toBe(first)
    await expect(controller.prompt({ ...raw, content: [{ type: 'text', text: 'PUBLIC replacement' }] }, new AbortController().signal))
      .rejects.toMatchObject({ code: 'session/prompt-conflict' })
    agent.session.append('user/message', claimed[0]!, { surfaceOp: 'append' })
    expect(await controller.promptAdmission(raw, new AbortController().signal)).toMatchObject({ state: 'accepted', phase: 'recorded', evidence: 'journal' })
    expect(followup).toHaveBeenCalledOnce()
  })

  it('prevents inbox dispatch after retirement while joining an already-running importer', async () => {
    const { ctx, controller, followup } = await harness()
    const original = ctx.attachments.admitPromptContent.bind(ctx.attachments)
    const entered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    vi.spyOn(ctx.attachments, 'admitPromptContent').mockImplementation(async content => {
      entered.resolve(); await release.promise; return original(content)
    })
    const raw = request()
    const result = controller.prompt(raw, new AbortController().signal).catch((error: unknown) => error)
    await entered.promise
    let stopped = false
    const stopping = ctx.fiber.dispose().then(() => { stopped = true })
    try {
      await vi.waitFor(() => { expect(stopped).toBe(false) })
      await expect(controller.prompt(request('PUBLIC-after-stop'), new AbortController().signal)).rejects.toMatchObject({ code: 'session/prompt-closed' })
    } finally { release.resolve() }
    await stopping
    expect(await result).toMatchObject({ code: 'session/prompt-closed' })
    expect(followup).not.toHaveBeenCalled()
  })
})
