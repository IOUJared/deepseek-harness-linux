/** Native Linux navigation observations and cancellable workspace guest ownership. */
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { LinuxBrowserBridge, LinuxBrowserLeaseId } from '../../types.ts'
import { emptyBrowserFrame, type BrowserFrame, type BrowserFrameState } from '../browser/BrowserFrame.ts'
import type { BrowserPageOptions } from '../browser/BrowserPage.ts'
import { browserAddressCheckpoint, currentBrowserTarget } from '../browser/BrowserPersistence.ts'
import { parseBrowserAddress, type BrowserTarget, MAX_BROWSER_URL_LENGTH } from '../browser/url.ts'
import { readLinuxBrowserState } from './protocol.ts'
import type { TauriPresentation } from './TauriPresentation.ts'

/** One ephemeral native guest per tab occurrence; hiding never releases its workspace lease. */
export class TauriBrowserFrame implements BrowserFrame {
  private readonly store = createSnapshotStore(emptyBrowserFrame())
  private readonly lifetime = new AbortController()
  private lease: LinuxBrowserLeaseId | undefined
  private ready = false
  private attached = false
  private sequence = -1
  private observedRequest = 0
  private revision = 0
  private pending: BrowserTarget | undefined
  private checkpoint: BrowserTarget | undefined
  private initializing: Promise<void> | undefined
  private queue = Promise.resolve()
  private unsubscribe: (() => void)[] = []
  private disposal: Promise<void> | undefined

  constructor(private readonly options: BrowserPageOptions, private readonly bridge: LinuxBrowserBridge,
    private readonly workspace: (signal: AbortSignal) => Promise<string>, private readonly applicationOrigin: string,
    private readonly presentation: TauriPresentation) {
    this.checkpoint = currentBrowserTarget(options.initial)
  }

  /** @returns common chrome state derived from native observations. */
  getSnapshot = (): BrowserFrameState => this.store.getSnapshot()
  /** @param listener - invalidation consumer. @returns unsubscribe callback. */
  subscribe = (listener: () => void): (() => void) => this.store.subscribe(listener)

  /** Start pending guest acquisition once a physical Sidebar viewport exists. */
  attach(): void { this.attached = true; if (this.pending !== undefined) this.initialize() }

  /** @param target - validated HTTP(S) address; observations replace this requested address after commit. */
  loadUrl(target: BrowserTarget): void {
    if (this.lifetime.signal.aborted) return
    const current = this.store.getSnapshot()
    if (this.ready && current.address === 'observed' && current.target?.url === target.url) { this.reload(); return }
    this.revision++
    this.pending = target
    this.store.set({ ...current, target, address: 'requested', loading: true, error: undefined })
    this.persist(target)
    if (this.ready) this.loadPending()
    else this.initialize()
  }

  /** Traverse actual WebKit back history when available. */
  goBack(): void { if (this.store.getSnapshot().canGoBack) this.navigate('back') }
  /** Traverse actual WebKit forward history when available. */
  goForward(): void { if (this.store.getSnapshot().canGoForward) this.navigate('forward') }
  /** Reload the native document, or retry guest acquisition after a transport failure. */
  reload(): void {
    const target = this.store.getSnapshot().target
    if (target === undefined || this.lifetime.signal.aborted) return
    if (this.ready) this.navigate('reload')
    else this.loadUrl(target)
  }

  /**
   * Wait for the current shell navigation's native load settlement, not command acknowledgement.
   * @param signal - caller deadline/cancellation; aborting a wait does not stop the shared guest.
   * @returns final observed state; rejects on load error, superseding command or lifetime disposal.
   */
  waitForLoad(signal: AbortSignal): Promise<BrowserFrameState> {
    const revision = this.revision
    const combined = AbortSignal.any([signal, this.lifetime.signal])
    return new Promise((resolve, reject) => {
      const finish = (error?: unknown): void => {
        stop()
        combined.removeEventListener('abort', aborted)
        // oxlint-disable-next-line typescript/prefer-promise-reject-errors -- Preserve the caller's AbortSignal reason.
        if (error !== undefined) reject(error)
        else resolve(this.getSnapshot())
      }
      const aborted = (): void => { finish(combined.reason) }
      const check = (): void => {
        const state = this.getSnapshot()
        if (combined.aborted) { aborted(); return }
        if (this.revision !== revision) { finish(new DOMException('Browser navigation superseded', 'AbortError')); return }
        if (state.error !== undefined) { finish(new Error('Native Browser load failed')); return }
        if (state.target === undefined) { finish(new Error('No Browser navigation requested')); return }
        if (this.observedRequest === revision && !state.loading && state.address === 'observed') finish()
      }
      const stop = this.subscribe(check)
      combined.addEventListener('abort', aborted, { once: true })
      check()
    })
  }

  /** @returns after acquisition, outstanding native calls and lease destruction; repeated callers join disposal. */
  dispose(): Promise<void> {
    if (this.disposal !== undefined) return this.disposal
    this.lifetime.abort()
    this.pending = undefined
    this.disconnect()
    this.presentation.dispose()
    this.disposal = (async () => {
      await this.initializing
      await this.queue
      await this.presentation.settled()
      const lease = this.lease
      this.lease = undefined
      if (lease !== undefined) await this.bridge.release(lease)
    })()
    return this.disposal
  }

  /**
   * Publish a transport failure through the existing localized failure UI.
   * @param error - diagnostic for maintainers only.
   */
  commandFailed(error: unknown): void {
    if (this.lifetime.signal.aborted) return
    console.error('Linux Browser operation failed', error)
    this.store.set({ ...this.store.getSnapshot(), loading: false, error: { code: undefined, description: undefined } })
  }

  private initialize(): void {
    if (!this.attached || this.initializing !== undefined || this.lease !== undefined || this.lifetime.signal.aborted) return
    this.initializing = this.createGuest().catch(async (error: unknown) => {
      this.disconnect()
      this.presentation.unbind()
      const lease = this.lease
      this.ready = false
      if (lease !== undefined) {
        try { await this.bridge.release(lease); this.lease = undefined }
        catch (releaseError) { this.commandFailed(releaseError) }
      }
      this.commandFailed(error)
    }).finally(() => { this.initializing = undefined })
  }

  private async createGuest(): Promise<void> {
    const workspace = await this.workspace(this.lifetime.signal)
    this.lifetime.signal.throwIfAborted()
    const reservation = await this.bridge.acquire(workspace)
    this.lease = reservation.lease
    if (this.lifetime.signal.aborted) return
    this.sequence = -1
    this.unsubscribe.push(this.bridge.onState(reservation.lease, (state) => {
      try { this.observe(state) } catch (error) { this.commandFailed(error) }
    }))
    this.unsubscribe.push(this.bridge.onOpenRequested(reservation.lease, (request) => {
      if (this.lifetime.signal.aborted || request.lease !== this.lease || typeof request.url !== 'string'
        || request.url.length > MAX_BROWSER_URL_LENGTH) return
      const parsed = parseBrowserAddress(request.url, this.applicationOrigin)
      if (parsed.ok) this.options.openRequested(parsed.target.url)
    }))
    this.observe(await this.bridge.getState(reservation.lease))
    // oxlint-disable-next-line typescript/no-unnecessary-condition -- Lifetime can end while the native query is pending.
    if (this.lifetime.signal.aborted) return
    this.ready = true
    this.presentation.bind(reservation.lease)
    this.loadPending()
  }

  private loadPending(): void {
    const target = this.pending
    const lease = this.lease
    if (target === undefined || lease === undefined) return
    const revision = this.revision
    this.pending = undefined
    this.command(revision, () => this.bridge.open(lease, target.url, revision))
  }

  private navigate(action: 'back' | 'forward' | 'reload'): void {
    const lease = this.lease
    if (!this.ready || lease === undefined || this.lifetime.signal.aborted) return
    const revision = ++this.revision
    this.pending = undefined
    this.store.set({ ...this.store.getSnapshot(), loading: true, error: undefined })
    this.command(revision, () => this.bridge.navigate(lease, action, revision))
  }

  private command(revision: number, run: () => Promise<void>): void {
    this.queue = this.queue.then(async () => {
      if (!this.lifetime.signal.aborted && revision === this.revision) await run()
    }).catch((error: unknown) => { if (revision === this.revision) this.commandFailed(error) })
  }

  private observe(value: unknown): void {
    const lease = this.lease
    if (lease === undefined || this.lifetime.signal.aborted) return
    const state = readLinuxBrowserState(value, lease)
    if (state.sequence <= this.sequence) return
    this.sequence = state.sequence
    if (state.requestId < this.revision) return
    if (state.requestId > this.revision) throw new Error('Unexpected Linux Browser request id')
    const current = this.store.getSnapshot()
    let target = current.target
    if (state.url !== null) {
      const parsed = parseBrowserAddress(state.url, this.applicationOrigin)
      if (!parsed.ok) throw new Error('Native Browser observed a prohibited address')
      target = { ...parsed.target, title: state.title || parsed.target.title }
    }
    this.observedRequest = state.requestId
    this.store.set({ target, address: state.url === null ? current.address : 'observed',
      loading: state.loading, canGoBack: state.canGoBack, canGoForward: state.canGoForward,
      error: state.error === null ? undefined : { code: state.error.code ?? undefined, description: state.error.description },
      sandboxEnabled: undefined })
    if (state.url !== null && target !== undefined) this.persist(target)
  }

  private persist(target: BrowserTarget): void {
    if (target.url === this.checkpoint?.url && target.title === this.checkpoint.title) return
    this.checkpoint = target
    this.options.persist(browserAddressCheckpoint(target, this.revision))
  }

  private disconnect(): void {
    for (const stop of this.unsubscribe) stop()
    this.unsubscribe = []
  }
}
