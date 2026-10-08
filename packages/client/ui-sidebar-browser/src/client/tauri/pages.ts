/** Assemble native Linux navigation and geometry behind the existing BrowserPage interface. */
import type { LinuxBrowserBridge } from '../../types.ts'
import type { BrowserPage, BrowserPageOptions } from '../browser/BrowserPage.ts'
import { TauriBrowserFrame } from './TauriBrowserFrame.ts'
import { TauriPresentation } from './TauriPresentation.ts'

/**
 * Create an idle native page without an iframe or Tauri JavaScript dependency.
 * @param options - saved checkpoint and source-tab callbacks.
 * @param bridge - trusted-shell-only native Browser bridge.
 * @param workspace - cancellable authoritative workspace resolver.
 * @param applicationOrigin - shell origin excluded from guest navigation.
 * @returns existing carrier-neutral navigation and presentation faces.
 */
export function createTauriPage(options: BrowserPageOptions, bridge: LinuxBrowserBridge,
  workspace: (signal: AbortSignal) => Promise<string>, applicationOrigin: string): BrowserPage {
  const presentation = new TauriPresentation(bridge, () => { frame.attach() }, (error) => { frame.commandFailed(error) })
  const frame = new TauriBrowserFrame(options, bridge, workspace, applicationOrigin, presentation)
  return { frame, presentation }
}
