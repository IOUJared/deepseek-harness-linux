import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { EventBuffer, RemoteEventSourceBuffer, encodeEvent } from '../src/event-buffer.ts'
import type { TypertRemoteEventInvocation } from '../src/types.ts'

const roots: Context[] = []
afterEach(async () => { for (const root of roots.splice(0)) await root.fiber.dispose() })

function invocation() {
  const ctx = new Context()
  roots.push(ctx)
  const agent = { id: 'agent-🌹', ctx }
  const signal = new AbortController().signal
  const request = { agent, signal, questions: [{ text: '🌹', choices: ['original'] }] }
  const resolve = vi.fn()
  const reject = vi.fn()
  const frame: TypertRemoteEventInvocation = {
    event: 'user-questions/request', request, context: { value: ctx, subject: agent, agentId: agent.id }, resolve, reject,
  }
  return { frame, request, agent, ctx, signal, resolve, reject }
}

function source(items = 2, bytes = 262144) {
  const lifetime = new AbortController()
  const buffer = new RemoteEventSourceBuffer(lifetime.signal, { items, bytes })
  const cleanup = vi.fn()
  const iterator = buffer.iterate(cleanup)[Symbol.asyncIterator]()
  return { lifetime, buffer, cleanup, iterator }
}

describe('forwarded event immutable bounded storage', () => {
  it('admits exact UTF-8 bytes including metadata, releases bytes on pop, and rejects one byte less', () => {
    const value = { type: 'emit', event: 'fixture/🌹', args: ['雪'] }
    const entry = encodeEvent(value, undefined)
    expect(entry.bytes).toBe(Buffer.byteLength(JSON.stringify(value)))
    expect(entry.bytes).toBeGreaterThan(entry.text.length)
    const exact = new EventBuffer({ items: 1, bytes: entry.bytes })
    expect(exact.push(entry)).toBe(true)
    expect(exact.push(entry)).toBe(false)
    expect(exact.pop()).toBe(entry)
    expect(exact.push(entry)).toBe(true)
    expect(exact.pop()).toBe(entry)
    expect(exact.pop()).toBeUndefined()
    expect(new EventBuffer({ items: 1, bytes: entry.bytes - 1 }).push(entry)).toBe(false)
    expect(new EventBuffer({ items: 1, bytes: 1 }).push(entry)).toBe(false)
  })

  it('accounts cumulative bytes independently of count and immutable input mutation', () => {
    const value = { event: 'fixture/update', args: ['🌹'] }
    const entry = encodeEvent(value, undefined)
    value.args.push('x'.repeat(100000))
    const buffer = new EventBuffer({ items: 3, bytes: entry.bytes * 2 })
    expect(buffer.push(entry)).toBe(true)
    expect(buffer.push(entry)).toBe(true)
    expect(buffer.push(entry)).toBe(false)
    expect(JSON.parse(buffer.pop()!.text)).toEqual({ event: 'fixture/update', args: ['🌹'] })
    expect(buffer.push(entry)).toBe(true)
  })

  it('snapshots question JSON while preserving Agent, Context and signal capabilities', async () => {
    const { buffer, lifetime, iterator } = source()
    const pending = invocation()
    buffer.push(pending.frame)
    pending.request.questions[0]!.choices.push('mutated')
    pending.request.questions[0]!.text = 'changed'
    const delivery = await iterator.next()
    expect(delivery.done).toBe(false)
    if (delivery.done || !('context' in delivery.value)) throw new Error('missing invocation')
    expect(delivery.value.request).toMatchObject({ questions: [{ text: '🌹', choices: ['original'] }] })
    expect(delivery.value.context.value).toBe(pending.ctx)
    expect(delivery.value.context.subject).toBe(pending.agent)
    expect((delivery.value.request as { agent: object }).agent).toBe(pending.agent)
    expect((delivery.value.request as { signal: AbortSignal }).signal).toBe(pending.signal)
    lifetime.abort()
    await expect(iterator.next()).resolves.toMatchObject({ done: true })
  })

  it('counts source invocation JSON metadata and multibyte payload at exact and one-byte-under limits', async () => {
    const pending = invocation()
    const bytes = Buffer.byteLength(JSON.stringify({
      event: pending.frame.event, agentId: pending.agent.id, request: { questions: pending.request.questions },
    }))
    const exact = source(1, bytes)
    exact.buffer.push(pending.frame)
    await expect(exact.iterator.next()).resolves.toMatchObject({ done: false })
    expect(pending.reject).not.toHaveBeenCalled()
    exact.lifetime.abort()
    const under = source(1, bytes - 1)
    under.buffer.push(pending.frame)
    expect(pending.reject).toHaveBeenCalledOnce()
    await expect(under.iterator.next()).rejects.toMatchObject({ code: 'gateway/event-overflow' })
  })

  it('fails only the full source, rejects queued and triggering questions, and never delegates on overflow', async () => {
    const first = source(1)
    const other = source(1)
    const queued = invocation()
    const triggering = invocation()
    expect(first.buffer.push(queued.frame)).toBe(true)
    expect(first.buffer.push(triggering.frame)).toBe(true)
    for (const pending of [queued, triggering]) {
      expect(pending.reject).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
        code: 'gateway/event-overflow', message: 'Forwarded Remote event buffer exceeded its limit',
        details: { endpoint: '$events', field: 'source' },
      }))
      expect(pending.resolve).not.toHaveBeenCalled()
    }
    expect(first.cleanup).toHaveBeenCalledOnce()
    const late = invocation()
    expect(first.buffer.push(late.frame)).toBe(true)
    expect(late.reject).toHaveBeenCalledOnce()
    await expect(first.iterator.next()).rejects.toMatchObject({ code: 'gateway/event-overflow' })
    other.buffer.push({ event: 'fixture/update', args: [1] })
    await expect(other.iterator.next()).resolves.toMatchObject({ value: { args: [1] }, done: false })
    other.lifetime.abort()
  })

  it('rejects an oversized single invocation and drains even when a rejection callback throws', async () => {
    const { buffer, cleanup, iterator } = source(2, 1)
    const pending = invocation()
    buffer.push(pending.frame)
    expect(pending.reject).toHaveBeenCalledOnce()
    expect(cleanup).toHaveBeenCalledOnce()
    await expect(iterator.next()).rejects.toMatchObject({ code: 'gateway/event-overflow' })
    const second = source(2)
    const broken = invocation()
    second.buffer.push({ ...broken.frame, reject: () => { throw new Error('broken provider callback') } })
    const good = invocation()
    second.buffer.push(good.frame)
    expect(() => { second.lifetime.abort('stop') }).not.toThrow()
    expect(good.reject).toHaveBeenCalledExactlyOnceWith('stop')
    expect(second.cleanup).toHaveBeenCalledOnce()
  })

  it('aborts before first pull and while paused without delivering retained frames or waiting for return', async () => {
    for (const started of [false, true]) {
      const { buffer, lifetime, cleanup, iterator } = source()
      if (started) {
        buffer.push({ event: 'fixture/start', args: [] })
        await iterator.next()
      }
      const pending = invocation()
      buffer.push(pending.frame)
      const reason = new Error('cancel generation')
      lifetime.abort(reason)
      expect(pending.reject).toHaveBeenCalledExactlyOnceWith(reason)
      expect(cleanup).toHaveBeenCalledOnce()
      expect(buffer.push({ event: 'fixture/late', args: [] })).toBe(false)
      await expect(iterator.next()).resolves.toMatchObject({ done: true })
    }
  })

  it('rejects non-lossless notification JSON before snapshot normalization', async () => {
    const { buffer, iterator, lifetime } = source()
    for (const value of [NaN, Infinity, undefined, () => {}, new Date(0), { nested: undefined }]) {
      expect(() => buffer.push({ event: 'fixture/invalid', args: [value] })).toThrow('not lossless JSON')
    }
    buffer.push({ event: 'fixture/valid', args: [null] })
    await expect(iterator.next()).resolves.toMatchObject({ value: { args: [null] } })
    lifetime.abort()
  })

  it('contains cleanup failure, wakes the reader, and prevents a second reader', async () => {
    const lifetime = new AbortController()
    const buffer = new RemoteEventSourceBuffer(lifetime.signal, { items: 1, bytes: 1024 })
    const error = new Error('cleanup failed')
    const reader = buffer.iterate(() => { throw error })[Symbol.asyncIterator]()
    expect(() => buffer.iterate(() => {})).toThrow('already has a reader')
    const pull = reader.next()
    expect(() => { lifetime.abort() }).not.toThrow()
    await expect(pull).rejects.toBe(error)
    expect(buffer.push({ event: 'fixture/late', args: [] })).toBe(false)
  })

  it('wakes an idle pull on abort without spinning', async () => {
    const { lifetime, iterator, cleanup } = source()
    const pull = iterator.next()
    lifetime.abort()
    await expect(pull).resolves.toMatchObject({ done: true })
    expect(cleanup).toHaveBeenCalledOnce()
  })
})
