---
kind: upgrade-guide
description: "Managed native Codex profiles require explicit account selection and do not adopt legacy grants."
---

# Managed native Codex accounts

English | [中文](guide.zh.md)

## Change

The native initializer enables `llm-pi-ai.nativeCodexAccounts` in its isolated editable desktop profile and sets a private `nativeCodexVault`. Existing legacy credentials are not imported or used as fallback. A previously enabled model route does not authorize an unselected managed account. Ordinary profiles retain legacy behavior while managed mode is disabled.

Add stores an unselected account. Selecting or forgetting an account requires the expected selection epoch in native commands; stale requests fail rather than changing the current selection. Local sign-out removes local grants but does not revoke them at the issuer or select another account. Unknown mutation results require an explicit status read, never automatic retry.

## Migration

1. Use a matching alpha backend and native consumer. Keep the installed runtime and other profiles separate.
2. Sign in explicitly through Settings → Codex → Connect ChatGPT. Do not copy legacy credentials into the managed vault. Existing grants remain untouched and unadopted.
3. For additional accounts, use Add and explicitly review/confirm selection. Handle `CODEX_EPOCH_CONFLICT` by reading current status and obtaining a fresh decision.
4. After a lost selection or logout acknowledgement, read account status before another mutation. Do not assume logout revoked issuer credentials or disconnected already-running external clients.

See the [provider reference](../../../../packages/llm/llm-pi-ai/README.md) for configuration, storage ownership and limitations.
