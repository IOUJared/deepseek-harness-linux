/** Browser-consumer lifecycle counters through the real Loader and artifact registry. */
import { writeFileSync } from 'node:fs'
import { afterEach, expect, it, vi } from 'vitest'
import { boot, browser, closeFixtures } from './consumer-fixture.client.ts'

vi.mock('node:fs', async (original) => {
  const fs = await original<typeof import('node:fs')>()
  return { ...fs, statSync: vi.fn(fs.statSync) }
})

afterEach(closeFixtures)

it('has zero recurring native-idle stats/timers, catches up before the first SSE graph and shares one poller', async () => {
  const fixture = await boot()
  const initial = fixture.registry.graph()
  const startupStats = fixture.stats()
  expect(startupStats).toBe(1) // Registry's one-shot artifact snapshot, not HMR polling.
  await vi.advanceTimersByTimeAsync(5_000)
  expect(fixture.stats()).toBe(startupStats)
  expect(fixture.intervals).not.toHaveBeenCalled()
  expect(vi.getTimerCount()).toBe(0)
  const head = await browser(fixture.route, 'HEAD')
  expect(head.response.writableEnded).toBe(true)
  expect(head.lines).toEqual([])
  expect(fixture.stats()).toBe(startupStats)
  expect(vi.getTimerCount()).toBe(0)

  writeFileSync(fixture.artifact, 'module.exports = { apply() {}, changed: "idle build" }\n')
  // HTTP artifact availability remains independent of an attached consumer.
  const oldBatch = initial.batches[0]!
  const served = await fixture.registry.fetchBundle(new Request(`http://localhost/${oldBatch.url}`))
  expect(served.status).toBe(200)
  expect(await served.text()).toContain('module.exports = { apply() {} }')
  const first = await browser(fixture.route)
  expect(first.graphs()).toHaveLength(1)
  const caughtUp = first.graphs()[0]!.graph!
  expect(caughtUp.entries[0]!.rev).not.toBe(initial.entries[0]!.rev)
  expect(caughtUp).toEqual(fixture.registry.graph())
  expect(fixture.rebuild).toHaveBeenCalledOnce()
  expect(fixture.intervals).toHaveBeenCalledTimes(1)
  expect(fixture.intervals.mock.calls[0]![1]).toBe(500) // Existing Config default through Loader.
  const freshBatch = caughtUp.batches[0]!
  const fresh = await fixture.registry.fetchBundle(new Request(`http://localhost/${freshBatch.url}`))
  expect(await fresh.text()).toContain('idle build')

  const second = await browser(fixture.route)
  expect(second.graphs()).toHaveLength(1)
  expect(second.graphs()[0]!.graph).toEqual(caughtUp)
  expect(fixture.intervals).toHaveBeenCalledTimes(1)
  fixture.rebuild.mockClear()
  const beforeTick = fixture.stats()
  await vi.advanceTimersByTimeAsync(500)
  expect(fixture.stats() - beforeTick).toBe(1)
  expect(fixture.rebuild).not.toHaveBeenCalled()
  writeFileSync(fixture.artifact, 'module.exports = { apply() {}, changed: "active build plus bytes" }\n')
  await vi.advanceTimersByTimeAsync(500)
  expect(fixture.rebuild).toHaveBeenCalledOnce()
  for (const consumer of [first, second]) {
    expect(consumer.graphs().slice(1).map(frame => frame.type)).toEqual(['rebuilt', 'graph'])
  }
  first.close()
  expect(vi.getTimerCount()).toBe(1)
  second.close()
  expect(vi.getTimerCount()).toBe(0)
  const idleStats = fixture.stats()
  const idleLines = first.lines.length + second.lines.length
  await vi.advanceTimersByTimeAsync(5_000)
  expect(fixture.stats()).toBe(idleStats)
  expect(first.lines.length + second.lines.length).toBe(idleLines)
})

it('does not restart on an opening disconnect or publish after the last consumer closes during a rebuild', async () => {
  const fixture = await boot()
  const opening = await browser(fixture.route, 'GET', (response, line) => {
    if (!line.startsWith('data: ')) return
    response.destroy()
    response.emit('close')
  })
  expect(opening.graphs()).toHaveLength(1)
  expect(vi.getTimerCount()).toBe(0)
  const consumer = await browser(fixture.route, 'GET', (response, line) => {
    if (!line.includes('"type":"rebuilt"')) return
    response.destroy()
    response.emit('close')
  })
  const callback = fixture.intervals.mock.calls[0]![0]
  writeFileSync(fixture.artifact, 'module.exports = { disconnectDuringRebuild: true }\n')
  await vi.advanceTimersByTimeAsync(500)
  expect(consumer.graphs().map(frame => frame.type)).toEqual(['graph', 'rebuilt'])
  expect(fixture.rebuild).toHaveBeenCalledOnce()
  expect(vi.getTimerCount()).toBe(0)
  const idleStats = fixture.stats()
  callback()
  expect(fixture.stats()).toBe(idleStats)
  const reconnect = await browser(fixture.route)
  expect(reconnect.graphs()).toHaveLength(1)
  expect(reconnect.graphs()[0]!.graph).toEqual(fixture.registry.graph())
  expect(fixture.rebuild).toHaveBeenCalledOnce()
  expect(vi.getTimerCount()).toBe(1)
})

it('cancels queued callbacks, reconnects with a fresh snapshot, and cannot restart after Loader disposal', async () => {
  const fixture = await boot()
  const first = await browser(fixture.route)
  const staleCallback = fixture.intervals.mock.calls[0]![0]
  first.close()
  writeFileSync(fixture.artifact, 'module.exports = { apply() {}, afterDisconnect: true }\n')
  const idleStats = fixture.stats()
  staleCallback()
  expect(fixture.stats()).toBe(idleStats)
  const [second, third] = await Promise.all([browser(fixture.route), browser(fixture.route)])
  expect(second.graphs()[0]!.graph).toEqual(third.graphs()[0]!.graph)
  expect(second.graphs()[0]!.graph!.rev).not.toBe(first.graphs()[0]!.graph!.rev)
  expect(fixture.intervals).toHaveBeenCalledTimes(2)
  expect(vi.getTimerCount()).toBe(1)
  const reconnectStats = fixture.stats()
  staleCallback()
  expect(fixture.stats()).toBe(reconnectStats)

  const currentCallback = fixture.intervals.mock.calls[1]![0]
  await fixture.hmr.dispose()
  expect(second.response.destroyed).toBe(true)
  expect(third.response.destroyed).toBe(true)
  expect(vi.getTimerCount()).toBe(0)
  const disposedStats = fixture.stats()
  const disposedLines = second.lines.length + third.lines.length
  writeFileSync(fixture.artifact, 'module.exports = { disposed: true, extra: "changed" }\n')
  currentCallback()
  staleCallback()
  await vi.advanceTimersByTimeAsync(5_000)
  const late = await browser(fixture.route)
  expect(late.response.destroyed).toBe(true)
  expect(late.lines).toEqual([])
  expect(fixture.stats()).toBe(disposedStats)
  expect(second.lines.length + third.lines.length).toBe(disposedLines)
  expect(vi.getTimerCount()).toBe(0)
})
