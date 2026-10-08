/** Type-only native Browser declarations shared by desktop shells and browser providers. */
import type { Branded } from '@deepseek-ai/dsh-brand'

/** Main-issued identity of one guest reservation. */
export type DesktopBrowserLeaseId = Branded<'DesktopBrowserLeaseId'>

/** A guest's approved, process-local storage partition. */
export interface DesktopBrowserReservation {
  readonly lease: DesktopBrowserLeaseId
  readonly partition: string
}

/** Main-approved request to open an HTTP(S) page from an existing guest. */
export interface DesktopBrowserOpenRequest {
  readonly lease: DesktopBrowserLeaseId
  readonly url: string
}

/** Origin-scoped operations; no Electron objects or arbitrary IPC cross this interface. */
export interface DesktopBrowserBridge {
  /** @param workspace - resolved storage account. @returns one approved guest reservation. */
  acquire(workspace: string): Promise<DesktopBrowserReservation>
  /** @param lease - the caller's reservation. @returns after its guest has been destroyed. */
  release(lease: DesktopBrowserLeaseId): Promise<void>
  /** @param lease - originating guest. @param listener - approved URL consumer. @returns unsubscribe callback. */
  onOpenRequested(lease: DesktopBrowserLeaseId, listener: (url: string) => void): () => void
}

/** Native-issued identity, scoped to one trusted shell document and workspace. */
export type LinuxBrowserLeaseId = Branded<'LinuxBrowserLeaseId'>

/** One initially hidden native guest; no secret or storage path is returned. */
export interface LinuxBrowserReservation {
  readonly lease: LinuxBrowserLeaseId
}

/** Content rectangle in shell viewport CSS pixels, before OS scale-factor conversion. */
export interface LinuxBrowserBounds {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}

/** Full native observation, including redirects and page-initiated history changes. */
export interface LinuxBrowserState {
  readonly lease: LinuxBrowserLeaseId
  /** Strictly increasing per lease; query responses and events share this counter. */
  readonly sequence: number
  /** Latest accepted shell command, initially zero; redirects retain the command id. */
  readonly requestId: number
  /** Null before an allowed main document commits; never the requested URL substituted for an observation. */
  readonly url: string | null
  readonly title: string
  readonly loading: boolean
  readonly canGoBack: boolean
  readonly canGoForward: boolean
  readonly error: { readonly code: number | null; readonly description: string } | null
}

/** A denied native popup, offered as a new Sidebar tab without an opener. */
export interface LinuxBrowserOpenRequest {
  readonly lease: LinuxBrowserLeaseId
  readonly url: string
}

/**
 * Optional trusted-shell-only bridge. It confers no Tauri permissions and is never injected into guests.
 * Promises acknowledge native command acceptance, not page completion; release waits for destruction.
 */
export interface LinuxBrowserBridge {
  /** Version read from native transport; this carrier accepts only version 1. */
  readonly protocolVersion: number
  /** @param workspace - canonical CWD account key or isolated Session key. @returns initially hidden lease. */
  acquire(this: void, workspace: string): Promise<LinuxBrowserReservation>
  /** Idempotent destruction fence; invalidates queued commands and disconnects native signals. @param lease - owned lease. */
  release(this: void, lease: LinuxBrowserLeaseId): Promise<void>
  /** @param lease - owned lease. @param url - allowed HTTP(S) address. @param requestId - increasing positive command id. */
  open(this: void, lease: LinuxBrowserLeaseId, url: string, requestId: number): Promise<void>
  /** @param lease - owned lease. @param action - closed navigation enum. @param requestId - increasing positive command id. */
  navigate(this: void, lease: LinuxBrowserLeaseId, action: 'back' | 'forward' | 'reload', requestId: number): Promise<void>
  /** @param lease - owned lease. @param bounds - finite, positive content rectangle inside the shell viewport. */
  setBounds(this: void, lease: LinuxBrowserLeaseId, bounds: LinuxBrowserBounds): Promise<void>
  /** Hidden guests remain alive; native shell overlay policy may veto showing. @param lease - owned lease. @param visible - request. */
  setVisible(this: void, lease: LinuxBrowserLeaseId, visible: boolean): Promise<void>
  /** @param lease - owned lease. @returns full current observation, ordered against events by sequence. */
  getState(this: void, lease: LinuxBrowserLeaseId): Promise<LinuxBrowserState>
  /** Subscribe before getState. @param lease - owned lease. @param listener - full state consumer. @returns synchronous unsubscribe. */
  onState(this: void, lease: LinuxBrowserLeaseId, listener: (state: LinuxBrowserState) => void): () => void
  /** @param lease - source lease. @param listener - approved HTTP(S) popup consumer. @returns synchronous unsubscribe. */
  onOpenRequested(this: void, lease: LinuxBrowserLeaseId, listener: (request: LinuxBrowserOpenRequest) => void): () => void
}
