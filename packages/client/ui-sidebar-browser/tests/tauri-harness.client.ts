/** Native transport fixture; the production page still uses its real frame and presentation. */
import { vi } from 'vitest'
import type { LinuxBrowserBridge, LinuxBrowserLeaseId, LinuxBrowserOpenRequest, LinuxBrowserState } from '../src/types.ts'
import { createTauriPage } from '../src/client/tauri/pages.ts'
import { TauriBrowserFrame } from '../src/client/tauri/TauriBrowserFrame.ts'
import type { BrowserPageOptions } from '../src/client/browser/BrowserPage.ts'

export function tauriHarness(overrides: Partial<LinuxBrowserBridge> = {}, initial?: BrowserPageOptions['initial']) {
  const lease = 'native-lease' as LinuxBrowserLeaseId
  let listener: ((state: LinuxBrowserState) => void) | undefined
  let popup: ((request: LinuxBrowserOpenRequest) => void) | undefined
  const baseline: LinuxBrowserState = { lease, sequence: 0, requestId: 0, url: null, title: '',
    loading: false, canGoBack: false, canGoForward: false, error: null }
  const stopState = vi.fn(() => { listener = undefined })
  const stopPopup = vi.fn(() => { popup = undefined })
  const bridge: LinuxBrowserBridge = {
    protocolVersion: 1, acquire: vi.fn(async () => ({ lease })), release: vi.fn(async () => {}),
    open: vi.fn(async () => {}), navigate: vi.fn(async () => {}), setBounds: vi.fn(async () => {}),
    setVisible: vi.fn(async () => {}), getState: vi.fn(async () => baseline),
    onState: vi.fn<LinuxBrowserBridge['onState']>((_lease, value) => { listener = value; return stopState }),
    onOpenRequested: vi.fn<LinuxBrowserBridge['onOpenRequested']>((_lease, value) => { popup = value; return stopPopup }), ...overrides,
  }
  const persist = vi.fn()
  const openRequested = vi.fn()
  const workspace = vi.fn(async (signal: AbortSignal) => { signal.throwIfAborted(); return 'cwd:/workspace' })
  const page = createTauriPage({ initial, persist, openRequested }, bridge, workspace, 'https://shell.example')
  if (!(page.frame instanceof TauriBrowserFrame)) throw new Error('Expected native frame')
  const frame = page.frame
  const host = document.createElement('div')
  host.id = `native-browser-${Math.random()}`
  document.body.append(host)
  return { frame, page, bridge, host, lease, persist, workspace, stopState, stopPopup, openRequested,
    emit: (patch: Partial<LinuxBrowserState>) => { listener?.({ ...baseline, requestId: 1, sequence: 1,
      url: 'https://example.test/', title: 'Example', ...patch }) },
    popup: (url: string, source = lease) => { popup?.({ lease: source, url }) },
    mount: () => page.presentation.mount(host.id),
    dispose: async () => { await frame.dispose(); host.remove() },
  }
}
