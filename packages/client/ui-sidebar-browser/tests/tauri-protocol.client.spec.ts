import { expect, it } from 'vitest'
import type { LinuxBrowserLeaseId } from '../src/types.ts'
import { readLinuxBrowserState } from '../src/client/tauri/protocol.ts'

const lease = 'lease' as LinuxBrowserLeaseId
const state = { lease, sequence: 1, requestId: 1, url: 'https://example.test/', title: 'Example',
  loading: false, canGoBack: true, canGoForward: false, error: null }

it('accepts complete bounded native snapshots and error diagnostics', () => {
  expect(readLinuxBrowserState(state, lease)).toEqual(state)
  expect(readLinuxBrowserState({ ...state, url: null, title: 't'.repeat(4096), sequence: 0,
    error: { code: null, description: 'd'.repeat(4096) } }, lease).error?.code).toBeNull()
  expect(readLinuxBrowserState({ ...state, error: { code: -1, description: 'failed' } }, lease).error?.code).toBe(-1)
})

it.each([
  null, [], 'text', { ...state, lease: 'foreign' }, { ...state, sequence: -1 }, { ...state, sequence: 1.5 },
  { ...state, requestId: Number.MAX_SAFE_INTEGER + 1 }, { ...state, requestId: '1' },
  { ...state, url: 'x'.repeat(16385) }, { ...state, url: undefined }, { ...state, title: 't'.repeat(4097) },
  { ...state, loading: 0 }, { ...state, canGoBack: null }, { ...state, canGoForward: undefined },
  { ...state, error: undefined }, { ...state, error: 'error' }, { ...state, error: { code: 1.2, description: 'error' } },
  { ...state, error: { code: 1, description: 'd'.repeat(4097) } },
])('rejects malformed, oversized and cross-lease native payloads: %j', (value) => {
  expect(() => readLinuxBrowserState(value, lease)).toThrow(/Invalid Linux Browser/)
})
