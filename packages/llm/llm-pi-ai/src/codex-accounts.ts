/** Host-only Codex account API; no remote methods, credentials, or inferred JWT identity. */
import { Context, Service } from '@deepseek-ai/cordis'
import type { AuthorizationInteraction } from '@deepseek-ai/dsh-authorization'
import type { CodexAccountId } from './account-binding.ts'

/** Public, non-secret account metadata. Unknown issuer facts stay null. */
export interface CodexModelAccount {
  readonly opaqueId: CodexAccountId
  readonly label: string
  readonly email: string | null
  readonly plan: string | null
}

/** Committed selection; quota is absent until an official same-account observer exists. */
export interface CodexAccountsDescription {
  readonly accounts: readonly CodexModelAccount[]
  readonly selected: CodexAccountId | null
  readonly epoch: number
  readonly legacy: 'unadopted' | 'absent'
}

/** Inputs for one new staging-key sign-in, never replacement of the selected grant. */
export interface CodexAccountLogin {
  readonly label: string
  readonly interaction: AuthorizationInteraction
  readonly signal?: AbortSignal
  /** Native callers guard selection before OAuth and again at the Add commit. */
  readonly expectedEpoch?: number
}

/** Exact account-add commit receipt; later reads cannot change its selection epoch. */
export interface CodexAccountLoginResult {
  readonly account: CodexModelAccount
  readonly epoch: number
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    codexAccounts: CodexAccounts
  }
}

/** Host-only service for an explicitly mounted native account owner. */
export abstract class CodexAccounts extends Service {
  constructor(ctx: Context) { super(ctx, 'codexAccounts') }

  /** Describe accounts without grant contents.
   * @returns committed public metadata.
   */
  abstract describe(): Promise<CodexAccountsDescription>
  /** Add a new account without replacing selection.
   * @param request - human-authorized sign-in interaction.
   * @returns newly added unselected account and the exact committed selection epoch.
   */
  abstract beginLogin(request: CodexAccountLogin): Promise<CodexAccountLoginResult>
  /** Cancel the active login. @returns after sign-in and staging-key cleanup settle. */
  abstract cancelLogin(): Promise<void>
  /** Select one account only after retiring the previous epoch.
   * @param id - account explicitly selected by the human.
   * @param expectedEpoch - optional committed selection epoch; native commands must supply it.
   * @returns after old SDK work drains and selection commits.
   */
  abstract select(id: CodexAccountId, expectedEpoch?: number): Promise<void>
  /** Forget an account without selecting another.
   * @param id - account to tombstone and forget.
   * @param expectedEpoch - optional committed selection epoch; native commands must supply it.
   * @returns after drainage and local deletion, not issuer revocation.
   */
  abstract signOut(id: CodexAccountId, expectedEpoch?: number): Promise<void>
  /** Forget managed accounts.
   * @param expectedEpoch - optional committed selection epoch; native commands must supply it.
   * @returns after local deletion; legacy remains untouched and issuer grants are not revoked.
   */
  abstract signOutAll(expectedEpoch?: number): Promise<void>
}
