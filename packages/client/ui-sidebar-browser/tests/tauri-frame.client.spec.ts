// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { tauriHarness } from './tauri-harness.client.ts'
import type { LinuxBrowserReservation, LinuxBrowserState } from '../src/types.ts'
import { browserAddressCheckpoint } from '../src/client/browser/BrowserPersistence.ts'

const target = { kind: 'https', url: 'https://example.test/', title: 'example.test' } as const
const fixtures: ReturnType<typeof tauriHarness>[] = []
const fixture = (...args: Parameters<typeof tauriHarness>) => { const h = tauriHarness(...args); fixtures.push(h); return h }
afterEach(async () => { await Promise.all(fixtures.splice(0).map(h => h.dispose())); vi.restoreAllMocks() })

it('is idle until both navigation and mounting and never creates an iframe', async () => {
  const h = fixture()
  h.frame.loadUrl(target)
  expect(h.bridge.acquire).not.toHaveBeenCalled()
  h.mount()
  await vi.waitFor(() => { expect(h.bridge.open).toHaveBeenCalledWith(h.lease, target.url, 1) })
  expect(h.workspace).toHaveBeenCalledOnce()
  expect(h.bridge.acquire).toHaveBeenCalledWith('cwd:/workspace')
  expect(h.host.children.length).toBe(0)
  expect(h.frame.getSnapshot()).toMatchObject({ address: 'requested', loading: true, sandboxEnabled: undefined })
})

it('keeps saved addresses idle until an explicit navigation', async () => {
  const h = fixture({}, browserAddressCheckpoint(target, 2))
  h.mount()
  expect(h.frame.getSnapshot().target).toBeUndefined()
  expect(h.bridge.acquire).not.toHaveBeenCalled()
})

it('observes actual redirects, titles, native history, loading and errors', async () => {
  const h = fixture()
  h.mount()
  h.frame.loadUrl(target)
  await vi.waitFor(() => { expect(h.bridge.open).toHaveBeenCalledOnce() })
  const wait = h.frame.waitForLoad(new AbortController().signal)
  h.emit({ loading: true, url: 'https://example.test/redirect', title: 'Redirect', canGoBack: true })
  expect(h.frame.getSnapshot()).toMatchObject({ address: 'observed', loading: true,
    target: { url: 'https://example.test/redirect', title: 'Redirect' }, canGoBack: true })
  h.emit({ sequence: 2, url: 'https://example.test/final', title: 'Final', canGoBack: true, canGoForward: true })
  await expect(wait).resolves.toMatchObject({ loading: false, target: { title: 'Final' } })
  expect(h.persist.mock.lastCall?.[0]).toMatchObject({ entries: [{ url: 'https://example.test/final', title: 'Final' }] })
  h.frame.goBack()
  await vi.waitFor(() => { expect(h.bridge.navigate).toHaveBeenLastCalledWith(h.lease, 'back', 2) })
  h.emit({ sequence: 3, requestId: 2, canGoForward: true, error: { code: -105, description: 'DNS failure' } })
  expect(h.frame.getSnapshot()).toMatchObject({ loading: false, error: { code: -105, description: 'DNS failure' } })
  await expect(h.frame.waitForLoad(new AbortController().signal)).rejects.toThrow('Native Browser load failed')
  h.frame.goForward()
  await vi.waitFor(() => { expect(h.bridge.navigate).toHaveBeenLastCalledWith(h.lease, 'forward', 3) })
  h.emit({ sequence: 4, requestId: 3, canGoBack: true })
  expect(h.frame.getSnapshot().error).toBeUndefined()
  h.frame.reload()
  await vi.waitFor(() => { expect(h.bridge.navigate).toHaveBeenLastCalledWith(h.lease, 'reload', 4) })
})

it('ignores stale events and an older current-state query that races a live event', async () => {
  let resolveState!: (state: LinuxBrowserState) => void
  const h = fixture({ getState: vi.fn(() => new Promise<LinuxBrowserState>((resolve) => { resolveState = resolve })) })
  h.mount()
  h.frame.loadUrl(target)
  await vi.waitFor(() => { expect(h.bridge.getState).toHaveBeenCalledOnce() })
  h.emit({ sequence: 3, title: 'New title' })
  resolveState({ lease: h.lease, sequence: 2, requestId: 0, url: null, title: '', loading: false,
    canGoBack: false, canGoForward: false, error: null })
  await vi.waitFor(() => { expect(h.bridge.open).toHaveBeenCalledOnce() })
  expect(h.frame.getSnapshot().target?.title).toBe('New title')
  h.emit({ sequence: 1, title: 'Old title' })
  expect(h.frame.getSnapshot().target?.title).toBe('New title')
  h.frame.loadUrl({ ...target, url: 'https://new.example/' })
  h.emit({ sequence: 4, requestId: 1, title: 'Old request' })
  expect(h.frame.getSnapshot()).toMatchObject({ address: 'requested', target: { url: 'https://new.example/' } })
})

it('settles waits on cancellation, superseding navigation and page lifetime end', async () => {
  const h = fixture()
  await expect(h.frame.waitForLoad(new AbortController().signal)).rejects.toThrow('No Browser navigation requested')
  h.mount()
  h.frame.loadUrl(target)
  await vi.waitFor(() => { expect(h.bridge.open).toHaveBeenCalledOnce() })
  const caller = new AbortController()
  const cancelled = expect(h.frame.waitForLoad(caller.signal)).rejects.toThrow('cancel wait')
  caller.abort(new Error('cancel wait'))
  await cancelled
  expect(h.bridge.release).not.toHaveBeenCalled()
  const superseded = expect(h.frame.waitForLoad(new AbortController().signal)).rejects.toMatchObject({ name: 'AbortError' })
  h.frame.loadUrl({ ...target, url: 'https://next.example/' })
  await superseded
  const disposed = expect(h.frame.waitForLoad(new AbortController().signal)).rejects.toMatchObject({ name: 'AbortError' })
  const first = h.frame.dispose()
  expect(h.frame.dispose()).toBe(first)
  await Promise.all([first, disposed])
  expect(h.stopState).toHaveBeenCalledOnce()
  expect(h.stopPopup).toHaveBeenCalledOnce()
  expect(h.bridge.release).toHaveBeenCalledExactlyOnceWith(h.lease)
  h.frame.loadUrl(target)
  h.frame.reload()
})

it('releases a late acquisition after lifetime cancellation without loading the guest', async () => {
  let resolveAcquire!: (reservation: LinuxBrowserReservation) => void
  const h = fixture({ acquire: vi.fn(() => new Promise<LinuxBrowserReservation>((resolve) => { resolveAcquire = resolve })) })
  h.mount()
  h.frame.loadUrl(target)
  await vi.waitFor(() => { expect(h.bridge.acquire).toHaveBeenCalledOnce() })
  const disposed = h.frame.dispose()
  resolveAcquire({ lease: h.lease })
  await disposed
  expect(h.bridge.open).not.toHaveBeenCalled()
  expect(h.bridge.onState).not.toHaveBeenCalled()
  expect(h.bridge.release).toHaveBeenCalledExactlyOnceWith(h.lease)
})

it('does not acquire when workspace resolution is cancelled', async () => {
  const h = fixture()
  h.mount()
  h.frame.loadUrl(target)
  await h.frame.dispose()
  expect(h.bridge.acquire).not.toHaveBeenCalled()
})

it('releases failed initialization and reacquires on an explicit retry', async () => {
  vi.spyOn(console, 'error').mockImplementation(() => {})
  const h = fixture()
  vi.mocked(h.bridge.getState).mockRejectedValueOnce(new Error('query failed'))
  h.mount()
  h.frame.loadUrl(target)
  await vi.waitFor(() => { expect(h.frame.getSnapshot().error).toBeDefined() })
  expect(h.stopState).toHaveBeenCalledOnce()
  expect(h.stopPopup).toHaveBeenCalledOnce()
  expect(h.bridge.release).toHaveBeenCalledExactlyOnceWith(h.lease)
  h.frame.reload()
  await vi.waitFor(() => { expect(h.bridge.open).toHaveBeenCalledWith(h.lease, target.url, 2) })
  expect(h.bridge.acquire).toHaveBeenCalledTimes(2)
})

it('coalesces queued navigation and treats a repeated observed URL as native reload', async () => {
  const h = fixture()
  h.frame.goBack()
  h.frame.goForward()
  h.frame.reload()
  expect(h.bridge.navigate).not.toHaveBeenCalled()
  h.mount()
  h.frame.loadUrl(target)
  await vi.waitFor(() => { expect(h.bridge.open).toHaveBeenCalledOnce() })
  h.emit({})
  h.frame.loadUrl(target)
  await vi.waitFor(() => { expect(h.bridge.navigate).toHaveBeenCalledWith(h.lease, 'reload', 2) })
  h.frame.loadUrl({ ...target, url: 'https://superseded.example/' })
  h.frame.loadUrl({ ...target, url: 'https://latest.example/' })
  await vi.waitFor(() => { expect(h.bridge.open).toHaveBeenLastCalledWith(h.lease, 'https://latest.example/', 4) })
  expect(h.bridge.open).toHaveBeenCalledTimes(2)
})

it('rejects a pre-aborted wait and disposes a pending current-state query silently', async () => {
  let resolveState!: (state: LinuxBrowserState) => void
  const h = fixture({ getState: vi.fn(() => new Promise<LinuxBrowserState>((resolve) => { resolveState = resolve })) })
  const signal = AbortSignal.abort(new Error('deadline reached'))
  await expect(h.frame.waitForLoad(signal)).rejects.toThrow('deadline reached')
  h.mount()
  h.frame.loadUrl(target)
  await vi.waitFor(() => { expect(h.bridge.getState).toHaveBeenCalledOnce() })
  const disposal = h.frame.dispose()
  resolveState({ lease: h.lease, sequence: 1, requestId: 1, url: target.url, title: 'Late', loading: false,
    canGoBack: false, canGoForward: false, error: null })
  await disposal
  expect(h.bridge.open).not.toHaveBeenCalled()
  expect(h.frame.getSnapshot().address).toBe('requested')
})

it('retains the native workspace lease across physical hide and remount', async () => {
  const h = fixture()
  const hide = h.mount()
  h.frame.loadUrl(target)
  await vi.waitFor(() => { expect(h.bridge.open).toHaveBeenCalledOnce() })
  hide()
  h.mount()
  expect(h.bridge.acquire).toHaveBeenCalledOnce()
  expect(h.bridge.release).not.toHaveBeenCalled()
})

it('denies unapproved popup addresses and forwards approved requests without creating a native popup', async () => {
  const h = fixture()
  h.mount()
  h.frame.loadUrl(target)
  await vi.waitFor(() => { expect(h.bridge.open).toHaveBeenCalledOnce() })
  for (const url of ['file:///secret', 'javascript:alert(1)', 'https://shell.example/api', 'https://user:secret@example.test/']) h.popup(url)
  h.popup('https://popup.example/', 'other-lease' as typeof h.lease)
  expect(h.openRequested).not.toHaveBeenCalled()
  h.popup('https://popup.example/')
  expect(h.openRequested).toHaveBeenCalledExactlyOnceWith('https://popup.example/')
})

it('contains malformed native observations and refused transport commands in localized frame errors', async () => {
  vi.spyOn(console, 'error').mockImplementation(() => {})
  const h = fixture({ open: vi.fn(async () => { throw new Error('transport refused') }) })
  h.mount()
  h.frame.loadUrl(target)
  await vi.waitFor(() => { expect(h.frame.getSnapshot().error).toBeDefined() })
  h.emit({ url: 'https://shell.example/api' })
  expect(h.frame.getSnapshot().target?.url).toBe(target.url)
  h.emit({ sequence: 2, requestId: 500 })
  expect(h.frame.getSnapshot().error).toEqual({ code: undefined, description: undefined })
})
