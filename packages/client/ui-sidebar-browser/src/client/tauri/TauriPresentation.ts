/** Place a real native guest over a Sidebar-owned viewport; no remote DOM is embedded. */
import type { LinuxBrowserBounds, LinuxBrowserBridge, LinuxBrowserLeaseId } from '../../types.ts'
import type { BrowserPresentation } from '../view/BrowserPresentation.ts'

/** Native view placement, independent of navigation and workspace ownership. */
export class TauriPresentation implements BrowserPresentation {
  private host: HTMLElement | undefined
  private lease: LinuxBrowserLeaseId | undefined
  private animation: number | undefined
  private placement: string | undefined
  private queue = Promise.resolve()

  constructor(private readonly bridge: LinuxBrowserBridge, private readonly mounted: () => void,
    private readonly failed: (error: unknown) => void) {}

  /** @param viewportId - committed Sidebar content viewport. @returns hide without releasing the guest. */
  mount(viewportId: string): () => void {
    const host = document.getElementById(viewportId)
    if (host === null) throw new Error('Linux Browser viewport is not mounted')
    this.stop()
    this.host = host
    this.placement = undefined
    this.mounted()
    this.sample()
    return () => {
      if (this.host !== host) return
      this.stop()
      this.host = undefined
      this.place(undefined)
    }
  }

  /**
   * Begin placement of an acquired native guest in the current viewport.
   * @param lease - initially hidden native guest whose lifetime belongs to the frame.
   */
  bind(lease: LinuxBrowserLeaseId): void {
    this.lease = lease
    this.placement = undefined
    this.place(this.bounds())
  }

  /** Hide a lost guest while keeping the current physical viewport. */
  unbind(): void {
    this.place(undefined)
    this.lease = undefined
    this.placement = undefined
  }

  /** Stop geometry observation and hide the guest; release remains the frame's responsibility. */
  dispose(): void {
    this.stop()
    this.host = undefined
    this.place(undefined)
    this.lease = undefined
  }

  /**
   * Join outstanding native placement requests before releasing the view.
   * @returns after already-issued bounds/visibility requests settle.
   */
  settled(): Promise<void> { return this.queue }

  private stop(): void {
    if (this.animation !== undefined) cancelAnimationFrame(this.animation)
    this.animation = undefined
  }

  private sample = (): void => {
    this.place(this.bounds())
    this.animation = requestAnimationFrame(this.sample)
  }

  private bounds(): LinuxBrowserBounds | undefined {
    const host = this.host
    if (host === undefined || !host.isConnected || document.visibilityState === 'hidden'
      || host.getClientRects().length === 0 || host.closest('[inert],[aria-hidden="true"]') !== null
      || getComputedStyle(host).visibility !== 'visible') return undefined
    const rect = host.getBoundingClientRect()
    const values = [rect.x, rect.y, rect.width, rect.height]
    if (!values.every(Number.isFinite) || rect.width <= 0 || rect.height <= 0 || rect.x < 0 || rect.y < 0
      || rect.right > window.innerWidth || rect.bottom > window.innerHeight) return undefined
    // Native children do not participate in DOM stacking; hide under visible shell menus and dialogs.
    for (const overlay of document.querySelectorAll('[aria-modal="true"],dialog[open],[role="menu"],[role="listbox"]')) {
      if (host.contains(overlay) || overlay.getClientRects().length === 0) continue
      const box = overlay.getBoundingClientRect()
      if (box.right > rect.left && box.left < rect.right && box.bottom > rect.top && box.top < rect.bottom) return undefined
    }
    return { x: rect.x, y: rect.y, width: rect.width, height: rect.height }
  }

  private place(bounds: LinuxBrowserBounds | undefined): void {
    const lease = this.lease
    if (lease === undefined) return
    const key = JSON.stringify(bounds ?? null)
    if (this.placement === key) return
    this.placement = key
    this.queue = this.queue.then(async () => {
      if (bounds !== undefined) {
        if (this.placement !== key) return
        await this.bridge.setBounds(lease, bounds)
        if (this.placement !== key) return
      }
      await this.bridge.setVisible(lease, bounds !== undefined)
    }).catch((error: unknown) => { this.failed(error) })
  }
}
