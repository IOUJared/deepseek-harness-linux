/**
 * Host transport for Web client graph changes and rebuilt bundles. While browser
 * EventSource consumers are attached, one interval stat-polls graph bundles
 * (network mounts deliver no inotify events), reports changes through
 * `clientModules.rebuilt(id)`, and serves the `/plugins/events` SSE channel
 * broadcasting graph/rebuilt frames to the browser half (src/client/).
 * The Web composition mounts this transport for live graph updates;
 * a development rebuild watcher also supplies bundle changes.
 */
import { statSync } from 'node:fs'
import type { ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
// Type imports carry the clientModules/webServer Context merges.
import type { ClientArtifactBaseline } from '@deepseek-ai/dsh-client-modules'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type { PluginsEventFrame } from './events.ts'
import { EVENTS_ENDPOINT } from './events.ts'

export type { PluginsEventFrame } from './events.ts'
export { EVENTS_ENDPOINT } from './events.ts'

/** Cordis plugin name. */
export const name = 'client-hmr'

/** Required services: the client graph and Web route registry. */
export const inject = ['clientModules', 'webServer']

/** Plugin config, validated by the same-named schemastery schema. */
export interface Config {
  /** Bundle stat-poll interval in milliseconds (default 500, the build-side watcher's polling default). */
  pollIntervalMs?: number
}

export const Config: z<Config> = z.object({
  pollIntervalMs: z.number().step(1).min(1).default(500),
})

/** Serialize one frame as an SSE data line. */
function sseData(frame: PluginsEventFrame): string {
  return `data: ${JSON.stringify(frame)}\n\n`
}

type WatchedBundleStat = Omit<ClientArtifactBaseline, 'path'>

type WatchedBundle = {
  -readonly [K in keyof ClientArtifactBaseline]: ClientArtifactBaseline[K]
} & { dirty: boolean }

/** Snapshot the executable bundle metadata that drives reloads. */
function bundleStat(path: string): WatchedBundleStat {
  const bundle = statSync(path)
  return { mtimeMs: bundle.mtimeMs, ctimeMs: bundle.ctimeMs, size: bundle.size }
}

/** Whether the executable bundle metadata is unchanged since its last publication. */
function sameBundleStat(left: WatchedBundleStat, right: WatchedBundleStat): boolean {
  return left.mtimeMs === right.mtimeMs
    && left.ctimeMs === right.ctimeMs
    && left.size === right.size
}

/**
 * Mount bundle watches and graph/rebuilt SSE delivery.
 * @param ctx - host plugin context carrying clientModules and webServer.
 * @param config - validated {@link Config}.
 */
export function apply(ctx: Context, config: Config): void {
  // schemastery's .default() guarantees the field is set after validation.
  const pollIntervalMs = config.pollIntervalMs as number

  // --- bundle watch: one HMR-owned stat poll ------------------------------
  const watched = new Map<string, WatchedBundle>()
  const connections = new Set<ServerResponse>()
  let timer: ReturnType<typeof setInterval> | undefined
  let disposed = false

  const stopPolling = (): void => {
    if (timer !== undefined) clearInterval(timer)
    timer = undefined
    watched.clear()
  }

  const publish = (id: string, watch: WatchedBundle, current: WatchedBundleStat): void => {
    try {
      ctx.clientModules.rebuilt(id)
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code === 'ENOENT') {
        watch.dirty = true
        return
      }
      ctx.logger.warn(error)
    }
    watch.mtimeMs = current.mtimeMs
    watch.ctimeMs = current.ctimeMs
    watch.size = current.size
    watch.dirty = false
  }

  const watchRow = (id: string, baseline: ClientArtifactBaseline): void => {
    const watch: WatchedBundle = { ...baseline, dirty: false }
    watched.set(id, watch)
    let current: WatchedBundleStat
    try {
      current = bundleStat(baseline.path)
    } catch (error) {
      watch.dirty = true
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') ctx.logger.warn(error)
      return
    }
    // The module host captured its baseline before reading the bytes in the
    // startup batch. Only a mismatch crosses into generation publication.
    if (!sameBundleStat(current, watch)) publish(id, watch, current)
  }

  const pollWatches = (): void => {
    for (const [id, watch] of watched) {
      let current: WatchedBundleStat
      try {
        current = bundleStat(watch.path)
      } catch (error) {
        watch.dirty = true
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') ctx.logger.warn(error)
        continue
      }
      if (!watch.dirty && sameBundleStat(current, watch)) continue
      // Stat-before-publication preserves a detectable older baseline for
      // writes that land during the read. The preset stamps the entry after
      // sibling chunks, so a completed build supplies the final stat change.
      publish(id, watch, current)
    }
  }

  // Diff the watch set against the current graph: drop watches for removed
  // rows (or rows whose bundle path moved), add watches for new rows.
  const syncWatches = (): void => {
    const rows = new Map<string, ClientArtifactBaseline>()
    for (const row of ctx.clientModules.graph().entries) {
      const watch = ctx.clientModules.artifactBaseline(row.id)
      if (watch !== undefined) rows.set(row.id, watch)
    }
    for (const [id, watch] of watched) {
      if (rows.get(id)?.path === watch.path) continue
      watched.delete(id)
    }
    for (const [id, watch] of rows) {
      if (disposed) return
      if (!watched.has(id)) watchRow(id, watch)
    }
  }

  ctx.effect(() => {
    const unsubscribe = ctx.clientModules.onGraphChanged(() => {
      if (!disposed && connections.size > 0) syncWatches()
    })
    return () => {
      disposed = true
      unsubscribe()
      stopPolling()
    }
  }, 'client-hmr: bundle watches')

  // --- /plugins/events SSE channel ----------------------------------------

  const publishGraph = (): void => {
    const line = sseData({ type: 'graph', graph: ctx.clientModules.graph() })
    for (const res of connections) res.write(line)
  }

  const connect = (res: ServerResponse): void => {
    // Baselines belong to the published artifact snapshots, not the current
    // files. Catch up before this consumer receives its opening full graph.
    if (connections.size === 0) syncWatches()
    else pollWatches()
    if (disposed || res.destroyed) {
      if (connections.size === 0) stopPolling()
      return
    }
    connections.add(res)
    res.once('close', () => {
      connections.delete(res)
      if (connections.size === 0) stopPolling()
    })
    // EventSource ignores the opening comment.
    res.write(': connected\n\n')
    res.write(sseData({ type: 'graph', graph: ctx.clientModules.graph() }))
    if (connections.size === 0 || timer !== undefined) return
    const current = setInterval(() => {
      // Cleared intervals may already have queued a callback. An old callback
      // must neither stat files nor publish into a replacement connection.
      if (!disposed && timer === current && connections.size > 0) pollWatches()
    }, pollIntervalMs)
    timer = current
    current.unref()
  }

  ctx.effect(() => {
    const disposeRoute = ctx.webServer.register({
      kind: 'exact',
      path: EVENTS_ENDPOINT,
      handler: (req, res) => {
        // Named routes match ahead of the carrier's method gate; keep the old
        // global 405 semantics for non-GET hits on this endpoint.
        if (req.method !== 'GET' && req.method !== 'HEAD') {
          res.writeHead(405)
          res.end()
          return
        }
        if (disposed) {
          res.destroy()
          return
        }
        res.writeHead(200, {
          'content-type': 'text/event-stream',
          'cache-control': 'no-cache',
          'connection': 'keep-alive',
        })
        if (req.method === 'HEAD') res.end()
        else connect(res)
      },
    })
    const unsubscribeGraph = ctx.clientModules.onGraphChanged(publishGraph)
    const unsubscribe = ctx.clientModules.onRebuilt((id, rev) => {
      const line = sseData({ type: 'rebuilt', id, rev })
      for (const res of connections) res.write(line)
    })
    return () => {
      disposed = true
      stopPolling()
      unsubscribeGraph()
      unsubscribe()
      disposeRoute()
      for (const res of connections) res.destroy()
      connections.clear()
    }
  }, 'client-hmr: /plugins/events channel')
}
