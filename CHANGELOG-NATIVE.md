# Native Linux companion changelog

## 2026.10.10-r1

October 10, 2026, America/Chicago. GitHub release identity only: the backend CLI/npm workspace remains **0.2.1-alpha.1** and Python SDK/runtime source development versions stay unchanged. This is not an npm or PyPI publication. Use matching rebuilt native/backend consumers, not the installed RC. [Native release](https://github.com/IOUJared/deepseek-harness-native/releases/tag/v2026.10.10-r1).

### Accounts

- Opt-in managed native Codex multiaccount owner and private v1 grant vault; lifetime POSIX flock, exclusive path/inode/permission checks, atomic fsync-backed storage and recovery.
- Explicit Add/select/local forget, optimistic selection epochs and stale-request conflicts. No legacy grant adoption, implicit fallback or issuer revocation; ordinary profiles retain legacy behavior.
- Immutable account/epoch bindings isolate SDK session/cache ownership. Switch/delete aborts and drains old streams/auth work. Account API is Host-only/value-free, not a Remote token interface.

### Model request controls

- Optional service tier `default|priority` and output detail `low|medium|high` across LLM/model defaults, runtime request headers, Session Controller catalog/projections, TS/Python SDK initialize, ACP, subagents, replay and generated Cordis APIs.
- Exact effective endpoint/protocol/documented-model allowlist. Unsupported controls reject before credential/provider I/O; omission retains upstream behavior. Same-route effort edits preserve controls; route changes clear them. Do not invent model-switch messages for control-only edits.
- Priority requests may cost more or be downgraded; requested tier is not verified entitlement/actual processing tier.

### Prompt admission and forwarded events

- Reserve `(sessionId, requestId)` before asynchronous intake; identical concurrent submissions share admission, changed raw payload conflicts, missing predecessor digest stays unverifiable.
- Bounded 128-entry receipt ledger with safe fixed errors and shutdown drainage. Nonactivating read-only status reports pending/accepted/rejected/unknown from memory/journal; positive historical Inbox insertions cover claimed-before-user-message gaps. Admission is not completion/fsync; unknown never authorizes automatic resend.
- Immutable JSON event snapshots with independent source/client/pending count and UTF-8 byte budgets (defaults 128 / 262144) and explicit `gateway/event-overflow` errors. Source overflow unregisters source; Client overflow ends only that generation. Preserve cleanup/cancellation/results and old one-argument factory typing; custom producers still own their limits.

### Optional browser and verification

- Lazy HMR: no recurring bundle scans/timers without SSE consumers, catch-up before opening, one shared poller and silent stale queued callbacks/disposal. Preserve Web composition; no whole-process idle/performance claim.
- Add focused negative/lifecycle and real Loader tests, authored current-v4 headless/TS SDK/Python request-control recordings, bilingual README/catalog updates, type equivalence, persistence acknowledgement pairs, three upgrade guides and verification guidance.
- Release checks fix branded Settings event fixtures, dispatch JSDoc and generated Cordis API freshness; current admission-aware Web replay uses a separately named expectation owner instead of overwriting historical logs.
- Session writer remains v4; SQLite version and old committed generations are unchanged. Added optional controls and prompt fingerprints require matching consumers; old missing fingerprints cannot verify a repeated payload.

### Limits

- Local grants are permission-protected plaintext, not encryption, issuer identity/entitlement verification or legacy migration. No real OAuth/provider/live quota/reset/alerts/retry qualification.
- Source tests, Loader composition, recorded replay, built launch, native paint and physical input are separate evidence. Web durable replay changes and publication checks must be assessed on the combined release—not inferred from older agent results.
- Backend/Node/system dependencies remain external to the native download. No self-contained Host, Windows/macOS parity, general Linux portability, complete redistribution-license or performance certificate. Private vaults/profiles/evidence are not published.
