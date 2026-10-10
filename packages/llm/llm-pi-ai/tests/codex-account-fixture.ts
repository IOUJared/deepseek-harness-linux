/** Public synthetic OAuth and serialized in-memory records; no production vault guarantee. */
import { vi } from 'vitest'
import type { OAuthCredential, Provider } from '@earendil-works/pi-ai'
import type { CredentialKey, CredentialRecord } from '@deepseek-ai/dsh-credentials'
import type { CodexRecordStore } from '../src/codex-grant.ts'
import { catalogProvider } from '../src/catalog.ts'

export function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}

export function publicGrant(id: string): OAuthCredential {
  return { type: 'oauth', access: `PUBLIC-access-${id}`, refresh: `PUBLIC-refresh-${id}`,
    expires: Date.now() + 600_000, accountId: `PUBLIC-issuer-${id}`, extra: { untouched: ['PUBLIC-extra', null] } }
}

export function recordFixture(): CodexRecordStore & { values: Map<CredentialKey, CredentialRecord> } {
  const values = new Map<CredentialKey, CredentialRecord>()
  const pending = new Map<CredentialKey, Promise<unknown>>()
  const serialize = <T>(key: CredentialKey, operation: () => Promise<T>): Promise<T> => {
    const task = (pending.get(key) ?? Promise.resolve()).catch(() => undefined).then(operation)
    pending.set(key, task)
    return task
  }
  return {
    values,
    readRecord: key => Promise.resolve(values.get(key)),
    modifyRecord: (key, mutate) => serialize(key, async () => {
      const next = await mutate(values.get(key))
      if (next !== undefined) values.set(key, next)
      return values.get(key)
    }),
    deleteRecord: key => serialize(key, async () => { values.delete(key) }),
  }
}

export function oauthFixture(): {
  provider: Provider
  login: ReturnType<typeof vi.fn<NonNullable<Provider['auth']['oauth']>['login']>>
  refresh: ReturnType<typeof vi.fn<NonNullable<Provider['auth']['oauth']>['refresh']>>
} {
  const installed = catalogProvider('openai-codex')
  if (installed === undefined) throw new Error('missing pinned Codex provider')
  const login = vi.fn<NonNullable<Provider['auth']['oauth']>['login']>(async () => publicGrant('first'))
  const refresh = vi.fn<NonNullable<Provider['auth']['oauth']>['refresh']>(async credential => ({ ...credential,
    access: `${credential.access}-refreshed`, expires: Date.now() + 600_000 }))
  return { login, refresh, provider: { ...installed, auth: { oauth: {
    name: 'PUBLIC synthetic Codex OAuth', login, refresh, toAuth: async credential => ({ apiKey: credential.access }),
  } } } }
}

export const interaction: import('@deepseek-ai/dsh-authorization').AuthorizationInteraction = {
  notify: vi.fn(),
  prompt: vi.fn(async () => 'PUBLIC-code'),
}
