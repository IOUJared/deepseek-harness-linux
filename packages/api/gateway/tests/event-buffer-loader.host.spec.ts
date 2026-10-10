/** Source-plane profile Loader composition for Gateway policy and the built-in Remotes consumer. */
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import Loader, { type ModuleLoaderV2 } from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import Typert from '@deepseek-ai/dsh-typert-registry'
import * as Remotes from '@deepseek-ai/dsh-api-remotes'
import type { SettingsNamespace } from '@deepseek-ai/dsh-settings'
import Gateway, { type Config } from '../src/index.ts'
import { profileComposition } from '../../../settings/settings/tests/profile-composition.ts'
import { afterEach, describe, expect, it } from 'vitest'

const fixtures: { ctx: Context; directory: string }[] = []
afterEach(async () => {
  for (const { ctx, directory } of fixtures.splice(0)) {
    await ctx.fiber.dispose()
    const resolved = await realpath(directory)
    if (!resolved.startsWith(join(tmpdir(), 'dsh-event-buffer-loader-'))) throw new Error('unexpected fixture cleanup target')
    await rm(resolved, { recursive: true, force: true })
  }
})

async function boot(config: Config = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-event-buffer-loader-'))
  const ctx = new Context()
  fixtures.push({ ctx, directory })
  const path = join(directory, 'cordis.yml')
  await writeFile(path, JSON.stringify([
    { id: 'typert', name: 'test-typert' },
    { id: 'gateway', name: 'test-gateway', config },
    { id: 'remotes', name: 'test-remotes' },
  ]) + '\n')
  ctx.baseUrl = pathToFileURL(directory).href + '/'
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  const modules = new Map<string, unknown>([['test-typert', Typert], ['test-gateway', Gateway], ['test-remotes', Remotes]])
  const internal: ModuleLoaderV2 = {
    version: 'v2', loadCache: new Map(), import: name => Promise.resolve(modules.get(name)),
    register(): never { throw new Error('unexpected source module hook') },
    getOrCreateModuleJob(): never { throw new Error('unexpected source module job') },
    resolveSync(): never { throw new Error('unexpected source module resolver') },
    load(): never { throw new Error('unexpected source module load') },
  }
  ctx.loader.internal = internal
  await profileComposition(ctx, directory, path)
  const entry = [...ctx.loader.entries()].find(row => row.options.id === 'gateway')
  if (entry?.fiber === undefined) throw new Error('missing Gateway Loader fiber')
  await entry.fiber.await()
  return { ctx, fiber: entry.fiber }
}

async function* empty(): AsyncIterable<never> {}

const fields = ['remoteEventBufferItems', 'remoteEventBufferBytes', 'remoteEventPendingItems', 'remoteEventPendingBytes'] as const

describe('forwarded event policy through production profile Loader', () => {
  it('resolves bounded defaults and withdraws all Services and event-source contributions', async () => {
    const { ctx, fiber } = await boot()
    expect(fiber.config).toMatchObject({
      remoteEventBufferItems: 128, remoteEventBufferBytes: 262144, remoteEventPendingItems: 128, remoteEventPendingBytes: 262144,
    })
    expect(ctx.get('typertGateway')).toBeDefined()
    await ctx.fiber.dispose()
    expect(ctx.get('typertGateway')).toBeUndefined()
  })

  it.each(fields)('rejects invalid %s at load before the dispatcher activates', async (field) => {
    for (const value of [0, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      await expect(boot({ [field]: value })).rejects.toThrow(new RegExp(`invalid config:[\\s\\S]*${field}`))
      expect(fixtures.at(-1)!.ctx.get('typertGateway')).toBeUndefined()
    }
    for (const value of [NaN, Infinity, -1]) expect(() => Gateway.Config({ [field]: value })).toThrow()
  })

  it('enforces the selected source policy, fails the affected registration once, and does not recreate it on retry', async () => {
    const { ctx } = await boot({
      remoteEventBufferItems: 1, remoteEventBufferBytes: 1024, remoteEventPendingItems: 2, remoteEventPendingBytes: 2048,
    })
    const lifetime = new AbortController()
    const events = (await ctx.typertGateway.wireStream.open('$events', { args: {} }, empty(), undefined, lifetime.signal))[Symbol.asyncIterator]()
    await expect(events.next()).resolves.toMatchObject({ value: { type: 'ready' } })
    const namespace = 'PUBLIC-theme' as SettingsNamespace
    ctx.emit('settings/document-updated', namespace, 1)
    ctx.emit('settings/document-updated', namespace, 2)
    await expect(events.next()).rejects.toMatchObject({ code: 'gateway/event-overflow', details: { field: 'source' } })
    expect(ctx.typertGateway.hasLiveClient()).toBe(false)
    for (let retry = 0; retry < 2; retry++) {
      const failed = (await ctx.typertGateway.wireStream.open('$events', { args: {} }, empty(), undefined, lifetime.signal))[Symbol.asyncIterator]()
      await expect(failed.next()).rejects.toMatchObject({ code: 'gateway/service-unavailable' })
    }
    lifetime.abort()
  })
})
