/** Private pi-ai 0.87.1 Codex grant handling; no JWT parsing or public identity inference. */
import type { CredentialStore, OAuthCredential, Provider } from '@earendil-works/pi-ai'
import type { CredentialKey, CredentialProvider, CredentialRecord } from '@deepseek-ai/dsh-credentials'
import { LlmError } from '@deepseek-ai/dsh-llm'
import { createModels } from './models.ts'
import type { PiAiAuthInjection } from './adapter.ts'

/** SDK provider id owned by this private helper. */
export const CODEX_PROVIDER = 'openai-codex'

/** Validate the SDK-owned persisted fields, retaining every opaque extra member. */
function grant(record: CredentialRecord | undefined): OAuthCredential {
  const payload = record?.kind === 'grant' ? record.payload : undefined
  if (typeof payload !== 'object' || payload === null || !('type' in payload) || payload.type !== 'oauth'
    || !('access' in payload) || typeof payload.access !== 'string' || payload.access.length === 0
    || !('refresh' in payload) || typeof payload.refresh !== 'string' || payload.refresh.length === 0
    || !('expires' in payload) || typeof payload.expires !== 'number' || !Number.isFinite(payload.expires)
    || !('accountId' in payload) || typeof payload.accountId !== 'string' || payload.accountId.length === 0) {
    throw new LlmError('Codex account has no valid SDK OAuth grant', 'INVALID_CODEX_GRANT')
  }
  return payload as OAuthCredential
}

/** Private bearer material, only for an injected official observer process owner. */
export interface CodexObserverToken {
  readonly token: string
  readonly chatgptAccountId: string
}

/** The record operations required by the account-owned store. */
export type CodexRecordStore = Pick<CredentialProvider, 'readRecord' | 'modifyRecord' | 'deleteRecord'>

/**
 * Bind Codex permanently to one key; owner checks enclose network refresh under the record lock.
 * @param records - storage whose modify/delete exclusion is externally owned.
 * @param key - immutable random account address, never the legacy provider key.
 * @param assertOwned - checks exclusive owner and account tombstone synchronously.
 * @returns a Codex-only SDK credential store with no fallback.
 */
export function codexBoundStore(records: CodexRecordStore, key: CredentialKey, assertOwned: () => void): CredentialStore {
  const check = (id: string, signal?: AbortSignal): void => {
    if (id !== CODEX_PROVIDER) throw new LlmError('Account store only accepts Codex', 'ACCOUNT_PROVIDER_MISMATCH')
    signal?.throwIfAborted()
    assertOwned()
  }
  return {
    async read(id, options) {
      check(id, options?.signal)
      const record = await records.readRecord(key)
      check(id, options?.signal)
      return record === undefined ? undefined : grant(record)
    },
    async list(options) {
      check(CODEX_PROVIDER, options?.signal)
      const record = await records.readRecord(key)
      check(CODEX_PROVIDER, options?.signal)
      return record === undefined ? [] : [{ providerId: CODEX_PROVIDER, type: 'oauth' }]
    },
    async modify(id, mutate, options) {
      check(id, options?.signal)
      const stored = await records.modifyRecord(key, async (current) => {
        check(id, options?.signal)
        const previous = current === undefined ? undefined : grant(current)
        const next = await mutate(previous)
        check(id, options?.signal)
        if (next === undefined) return undefined
        const record: CredentialRecord = { kind: 'grant', payload: next }
        const valid = grant(record)
        if (previous !== undefined && valid.accountId !== previous.accountId) {
          throw new LlmError('Codex refresh changed the issuer account identity', 'CODEX_ACCOUNT_CHANGED')
        }
        return record
      })
      check(id, options?.signal)
      return stored === undefined ? undefined : grant(stored)
    },
    async delete(id, options) {
      check(id, options?.signal)
      await records.deleteRecord(key)
    },
  }
}

/**
 * Resolve bearer material through public Models.getAuth; forced refresh uses the same bound-key lock.
 * @param provider - installed Codex provider, or a fake provider for keyless tests.
 * @param auth - the selected account's fixed store and auth context.
 * @param signal - owner retirement and caller cancellation.
 * @param force - bypass expiry after the official observer rejects a token.
 * @returns private token and SDK-owned issuer account id; never a public DTO.
 */
export async function codexObserverToken(
  provider: Provider, auth: PiAiAuthInjection, signal: AbortSignal, force: boolean,
): Promise<CodexObserverToken> {
  if (provider.id !== CODEX_PROVIDER || provider.auth.oauth === undefined) {
    throw new LlmError('Codex OAuth provider is unavailable', 'CODEX_OAUTH_UNAVAILABLE')
  }
  if (force) {
    const oauth = provider.auth.oauth
    await auth.credentials.modify(CODEX_PROVIDER, async (current) => {
      const valid = grant(current === undefined ? undefined : { kind: 'grant', payload: current })
      return oauth.refresh(valid, signal)
    }, { signal })
  }
  const models = createModels(auth)
  models.setProvider(provider)
  const resolved = await models.getAuth(CODEX_PROVIDER, { signal })
  const stored = await auth.credentials.read(CODEX_PROVIDER, { signal })
  const valid = grant(stored === undefined ? undefined : { kind: 'grant', payload: stored })
  signal.throwIfAborted()
  const token = resolved?.auth.apiKey
  if (token === undefined || token.length === 0 || typeof valid.accountId !== 'string') {
    throw new LlmError('Codex request token is unavailable', 'INVALID_CODEX_GRANT')
  }
  return { token, chatgptAccountId: valid.accountId }
}
