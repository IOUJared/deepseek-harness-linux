// @vitest-environment jsdom
/** Optional browser HMR uses the real module table, Loader and entry replacement controller. */
import { writeFileSync } from 'node:fs'
import { IncomingMessage, ServerResponse } from 'node:http'
import { Socket } from 'node:net'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import * as BrowserModules from '@deepseek-ai/dsh-client-modules/client'
import type { ClientModuleLoaderTarget } from '@deepseek-ai/dsh-client-modules/client'
import { afterEach, expect, it, vi } from 'vitest'
import * as BrowserHmr from '../src/client/index.ts'
import { boot, closeFixtures } from './consumer-fixture.client.ts'

const pages: Context[] = []
const sockets: Socket[] = []
afterEach(async () => {
  for (const page of pages.splice(0)) await page.fiber.dispose()
  for (const socket of sockets.splice(0)) socket.destroy()
  document.body.replaceChildren()
  vi.unstubAllGlobals()
  await closeFixtures()
})

it('refreshes an idle-changed artifact through the exported browser HMR plugin and real page entry controller', async () => {
  const fixture = await boot()
  const initial = fixture.registry.graph()
  const id = initial.entries[0]!.id
  writeFileSync(fixture.artifact, 'module.exports = { changedWhileIdle: true }\n')
  const sources: { close: () => void }[] = []
  vi.stubGlobal('EventSource', class extends EventTarget {
    constructor() {
      super()
      const request = new IncomingMessage(new Socket())
      request.method = 'GET'
      const response = new ServerResponse(request)
      sockets.push(request.socket)
      const frames: string[] = []
      response.write = (line) => { frames.push(String(line)); return true }
      sources.push({ close: () => { response.destroy(); response.emit('close') } })
      void fixture.route.handler(request, response)
      queueMicrotask(() => {
        for (const line of frames) {
          if (line.startsWith('data: ')) this.dispatchEvent(new MessageEvent('message', { data: line.slice(6) }))
        }
      })
    }
    close() { sources[0]!.close() }
  })
  const widgetFactory = (revision: string) => () => ({
    apply(pluginCtx: Context) {
      pluginCtx.effect(() => {
        const element = document.createElement('div')
        element.textContent = revision
        document.body.append(element)
        return () => { element.remove() }
      })
    },
  })
  const target: ClientModuleLoaderTarget = {
    mode: 'queue', pendingQueue: [], load() {},
    create: options => BrowserModules.createClientModuleSystem(target, { id: 'bootstrap', exports: BrowserModules }, options),
  }
  const modules = target.create({
    boot: initial, staticModules: {},
    loadBundle: async (url) => {
      const row = url === initial.batches[0]!.url ? initial.entries[0]! : fixture.registry.graph().entries[0]!
      target.load({ id, factory: widgetFactory(row.rev) })
    },
  })
  const page = new Context()
  pages.push(page)
  await page.plugin(Loader)
  page.loader.internal = modules as never
  await modules.entries.start(page.loader, modules.manifest)
  expect(document.body.textContent).toBe(initial.entries[0]!.rev)
  // Both plugin namespaces pass through the actual page Loader import path.
  await page.loader.create({ name: 'bootstrap' })
  target.load({ id: 'browser-hmr', factory: () => BrowserHmr })
  const browserHmrId = await page.loader.create({ name: 'browser-hmr' })
  await page.loader.await()
  await page.loader.resolve(browserHmrId).fiber!.await()
  await vi.waitFor(() => { expect(document.body.textContent).toBe(fixture.registry.graph().entries[0]!.rev) })
  expect(document.body.textContent).not.toBe(initial.entries[0]!.rev)
  expect(document.body.children).toHaveLength(1)
  expect(modules.entries.state.getSnapshot()).toEqual({ syncing: false, failures: [] })
  expect(vi.getTimerCount()).toBe(1)
  await page.loader.resolve(browserHmrId).fiber!.dispose()
  expect(vi.getTimerCount()).toBe(0)
  await vi.advanceTimersByTimeAsync(5_000)
  expect(vi.getTimerCount()).toBe(0)
})
