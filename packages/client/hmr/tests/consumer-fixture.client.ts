/** Real Loader, artifact registry and HMR lifecycle; only browser inputs and interval time are controlled. */
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { IncomingMessage, ServerResponse } from 'node:http'
import { Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context, FiberState } from '@deepseek-ai/cordis'
import Loader, { type ModuleLoaderV2 } from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import { ClientModuleRegistry, type WebBootGraph } from '@deepseek-ai/dsh-client-modules'
import { WebServer, type WebRoute } from '@deepseek-ai/dsh-host-webserver'
import { expect, vi } from 'vitest'
import * as Hmr from '../src/index.ts'

const ID = '@fixture/browser-plugin'
let directory: string | undefined
let ctx: Context | undefined
const browsers: { request: IncomingMessage; response: ServerResponse }[] = []

/** Dispose fixture contexts, responses, sockets and temporary artifacts. */
export async function closeFixtures() {
  await ctx?.fiber.dispose()
  ctx = undefined
  for (const browser of browsers.splice(0)) {
    browser.response.destroy()
    browser.request.socket.destroy()
  }
  vi.useRealTimers()
  vi.restoreAllMocks()
  if (directory !== undefined) {
    expect(resolve(directory).startsWith(join(tmpdir(), 'dsh-hmr-consumers-'))).toBe(true)
    rmSync(directory, { recursive: true, force: true })
  }
  directory = undefined
}

/** Load the exported HMR plugin with real artifact and HTTP owners from fixture YAML. */
export async function boot() {
  directory = mkdtempSync(join(tmpdir(), 'dsh-hmr-consumers-'))
  const packageRoot = join(directory, 'node_modules', '@fixture', 'browser-plugin')
  mkdirSync(join(packageRoot, 'lib'), { recursive: true })
  writeFileSync(join(packageRoot, 'package.json'), JSON.stringify({
    name: ID, exports: { './package.json': './package.json', './client': './lib/client.js' },
    dsh: { client: { platform: 'web' } },
  }))
  const artifact = join(packageRoot, 'lib', 'client.js')
  writeFileSync(artifact, 'module.exports = { apply() {} }\n')
  const configPath = join(directory, 'cordis.yml')
  writeFileSync(configPath, [
    '- id: server', '  name: fixture-server', '  config:', '    host: 127.0.0.1', '    port: 0',
    '- id: browser-row', `  name: '${ID}'`,
    '- id: modules', '  name: fixture-modules',
    '- id: hmr', "  name: '@deepseek-ai/dsh-client-hmr'", '',
  ].join('\n'))
  ctx = new Context()
  ctx.baseUrl = pathToFileURL(directory).href + '/'
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  const plugins = new Map<string, unknown>([
    ['fixture-server', WebServer], ['fixture-modules', ClientModuleRegistry],
    ['@deepseek-ai/dsh-client-hmr', Hmr], [ID, { apply() {} }],
  ])
  const internal: ModuleLoaderV2 = {
    version: 'v2', loadCache: new Map(),
    import: async (specifier) => {
      if (!plugins.has(specifier)) throw new Error(`Unexpected fixture module: ${specifier}`)
      return plugins.get(specifier)
    },
    resolveSync: (_parent, { specifier }) => {
      if (specifier !== ID) throw new Error('Non-browser fixture owner')
      return { url: pathToFileURL(join(packageRoot, 'index.js')).href, format: 'module' }
    },
    register(): never { throw new Error('Unexpected module hook') },
    getOrCreateModuleJob(): never { throw new Error('Unexpected module job') },
    load(): never { throw new Error('Unexpected module load') },
  }
  ctx.loader.internal = internal
  // The actual route registry runs; the spy only captures the browser input target.
  const routes = vi.spyOn(WebServer.prototype, 'register')
  await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configPath).href } })
  await ctx.loader.await()
  for (const entry of ctx.loader.entries()) await entry.fiber?.await()
  const hmr = [...ctx.loader.entries()].find(entry => entry.options.name === '@deepseek-ai/dsh-client-hmr')!.fiber!
  expect(hmr.state).toBe(FiberState.ACTIVE)
  const route = routes.mock.calls.map(([row]) => row).find(row => row.path === Hmr.EVENTS_ENDPOINT)!
  expect(route).toBeDefined()
  const registry = ctx.clientModules
  expect(registry.graph().entries.map(row => row.id)).toEqual([ID])
  const rebuild = vi.spyOn(registry, 'rebuilt')
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
  const intervals = vi.spyOn(globalThis, 'setInterval')
  const stats = () => vi.mocked(statSync).mock.calls.filter(([path]) => path === artifact).length
  return { registry, artifact, route, hmr, rebuild, intervals, stats }
}

/** Attach one controlled browser response to the real HMR route. */
export async function browser(
  route: WebRoute,
  method = 'GET',
  onWrite?: (response: ServerResponse, line: string) => void,
) {
  const request = new IncomingMessage(new Socket())
  request.method = method
  const response = new ServerResponse(request)
  browsers.push({ request, response })
  const lines: string[] = []
  vi.spyOn(response, 'write').mockImplementation((line) => {
    lines.push(String(line))
    onWrite?.(response, String(line))
    return true
  })
  await route.handler(request, response)
  const graphs = () => lines.filter(line => line.startsWith('data: '))
    .map(line => JSON.parse(line.slice(6)) as { type: string; graph?: WebBootGraph; id?: string; rev?: string })
  const close = () => { response.destroy(); response.emit('close') }
  return { request, response, lines, graphs, close }
}
