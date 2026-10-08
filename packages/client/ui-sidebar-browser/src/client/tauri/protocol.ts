/** Validate bounded native observations before publishing them to browser chrome. */
import type { LinuxBrowserLeaseId, LinuxBrowserState } from '../../types.ts'
import { MAX_BROWSER_URL_LENGTH } from '../browser/url.ts'

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function counter(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

function text(value: unknown, limit: number): value is string {
  return typeof value === 'string' && value.length <= limit
}

/**
 * Decode a native state event or query response, rejecting malformed or cross-lease data.
 * @param value - native transport payload.
 * @param lease - expected reservation.
 * @returns validated full observation.
 */
export function readLinuxBrowserState(value: unknown, lease: LinuxBrowserLeaseId): LinuxBrowserState {
  if (!record(value) || value.lease !== lease || !counter(value.sequence) || !counter(value.requestId)
    || !(value.url === null || text(value.url, MAX_BROWSER_URL_LENGTH)) || !text(value.title, 4096)
    || typeof value.loading !== 'boolean' || typeof value.canGoBack !== 'boolean' || typeof value.canGoForward !== 'boolean') {
    throw new Error('Invalid Linux Browser state')
  }
  const result = { lease, sequence: value.sequence, requestId: value.requestId, url: value.url, title: value.title,
    loading: value.loading, canGoBack: value.canGoBack, canGoForward: value.canGoForward }
  const error = value.error
  if (error === null) return { ...result, error: null }
  if (!record(error) || !(error.code === null || (typeof error.code === 'number' && Number.isSafeInteger(error.code)))
    || !text(error.description, 4096)) throw new Error('Invalid Linux Browser error')
  return { ...result, error: { code: error.code, description: error.description } }
}
