/** Decode intercepted SDK requests; Codex SSE can send a zstd-compressed body. */
import { zstdDecompressSync } from 'node:zlib'

/**
 * Read a fake-fetch request without dispatching it or exposing real credentials.
 * @param input - SDK request URL or unconsumed Request.
 * @param init - SDK method, headers and serialized body.
 * @returns decoded public fixture JSON and headers.
 */
export async function providerRequest(
  input: string | URL | Request,
  init?: RequestInit,
): Promise<{ url: string; body: unknown; headers: Headers }> {
  const request = input instanceof Request ? input.clone() : new Request(input, init)
  const bytes = Buffer.from(await request.arrayBuffer())
  const json = request.headers.get('content-encoding') === 'zstd' ? zstdDecompressSync(bytes) : bytes
  return { url: request.url, body: JSON.parse(json.toString('utf8')), headers: request.headers }
}
