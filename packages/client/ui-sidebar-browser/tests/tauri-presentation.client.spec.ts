// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { TauriPresentation } from '../src/client/tauri/TauriPresentation.ts'
import { tauriHarness } from './tauri-harness.client.ts'

const fixtures: ReturnType<typeof tauriHarness>[] = []
afterEach(async () => { await Promise.all(fixtures.splice(0).map(h => h.dispose())); vi.restoreAllMocks(); vi.unstubAllGlobals() })

function geometry() {
  const h = tauriHarness()
  fixtures.push(h)
  let rect = new DOMRect(20, 30, 200, 100)
  let tick: FrameRequestCallback | undefined
  vi.stubGlobal('requestAnimationFrame', vi.fn((callback: FrameRequestCallback) => { tick = callback; return 1 }))
  vi.stubGlobal('cancelAnimationFrame', vi.fn())
  vi.spyOn(h.host, 'getBoundingClientRect').mockImplementation(() => rect)
  vi.spyOn(h.host, 'getClientRects').mockImplementation(() => Object.assign([rect], { item: (index: number) => index === 0 ? rect : null }))
  return { ...h, tick: () => { tick?.(0) }, rect: (value: DOMRect) => { rect = value } }
}

it('measures native content bounds without creating guest DOM, resizes, and hides under shell overlays', async () => {
  const h = geometry()
  const hide = h.mount()
  h.frame.loadUrl({ kind: 'https', url: 'https://example.test/', title: 'Example' })
  await vi.waitFor(() => { expect(h.bridge.setVisible).toHaveBeenLastCalledWith(h.lease, true) })
  expect(h.bridge.setBounds).toHaveBeenCalledExactlyOnceWith(h.lease, { x: 20, y: 30, width: 200, height: 100 })
  expect(h.host.children.length).toBe(0)
  h.tick()
  await Promise.resolve()
  expect(h.bridge.setBounds).toHaveBeenCalledOnce()
  h.rect(new DOMRect(30, 40, 300, 200))
  h.tick()
  await vi.waitFor(() => { expect(h.bridge.setBounds).toHaveBeenLastCalledWith(h.lease, { x: 30, y: 40, width: 300, height: 200 }) })
  const menu = document.createElement('div')
  menu.setAttribute('role', 'menu')
  document.body.append(menu)
  const box = new DOMRect(40, 50, 20, 20)
  vi.spyOn(menu, 'getBoundingClientRect').mockReturnValue(box)
  vi.spyOn(menu, 'getClientRects').mockReturnValue(Object.assign([box], { item: () => box }))
  try {
    h.tick()
    await vi.waitFor(() => { expect(h.bridge.setVisible).toHaveBeenLastCalledWith(h.lease, false) })
    menu.remove()
    h.tick()
    await vi.waitFor(() => { expect(h.bridge.setVisible).toHaveBeenLastCalledWith(h.lease, true) })
    hide()
    await vi.waitFor(() => { expect(h.bridge.setVisible).toHaveBeenLastCalledWith(h.lease, false) })
    expect(h.bridge.release).not.toHaveBeenCalled()
  } finally { menu.remove() }
})

it('fails closed on hidden, inert, zero-sized or partially offscreen viewports', async () => {
  const h = geometry()
  h.mount()
  h.frame.loadUrl({ kind: 'http', url: 'http://localhost:8080/', title: 'localhost' })
  await vi.waitFor(() => { expect(h.bridge.open).toHaveBeenCalledOnce() })
  for (const rect of [new DOMRect(-1, 0, 200, 100), new DOMRect(0, 0, 0, 100),
    new DOMRect(1000, 700, 200, 100), new DOMRect(Number.NaN, 0, 200, 100)]) {
    h.rect(rect)
    h.tick()
    await vi.waitFor(() => { expect(h.bridge.setVisible).toHaveBeenLastCalledWith(h.lease, false) })
  }
  h.rect(new DOMRect(20, 30, 200, 100))
  h.host.setAttribute('inert', '')
  h.tick()
  await vi.waitFor(() => { expect(h.bridge.setVisible).toHaveBeenLastCalledWith(h.lease, false) })
  h.host.removeAttribute('inert')
  h.host.style.visibility = 'hidden'
  h.tick()
  await vi.waitFor(() => { expect(h.bridge.setVisible).toHaveBeenLastCalledWith(h.lease, false) })
})

it('reports geometry transport failures and joins placement on disposal', async () => {
  vi.spyOn(console, 'error').mockImplementation(() => {})
  const h = tauriHarness({ setVisible: vi.fn(async () => { throw new Error('native view gone') }) })
  fixtures.push(h)
  h.mount()
  h.frame.loadUrl({ kind: 'https', url: 'https://example.test/', title: 'Example' })
  await vi.waitFor(() => { expect(h.frame.getSnapshot().error).toBeDefined() })
  await h.frame.dispose()
  expect(h.bridge.release).toHaveBeenCalledOnce()
})

it('refuses an absent physical viewport', () => {
  const h = tauriHarness()
  fixtures.push(h)
  const presentation = new TauriPresentation(h.bridge, vi.fn(), vi.fn())
  expect(() => presentation.mount('missing-native-viewport')).toThrow('viewport is not mounted')
  presentation.dispose()
})
