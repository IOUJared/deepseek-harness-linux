---
name: harness-verification
description: >-
  Use when developing or reviewing native-client/TypeScript Harness integration,
  frontend/backend protocols, cancellation, persistence or verification coverage.
  Route each failure to production tests and separate source, built-artifact,
  real-composition and live-provider evidence.
---

# Native frontend/backend verification

Apply impeccable-rust's risk-to-verifier and honest-evidence method without imposing Rust tooling on TypeScript. For Rust work, also load `impeccable-rust` when available; its complete pinned resources are installed in the native repository and shared local agent skill directory.

## Procedure

1. Read repository `AGENTS.md`, `docs/testing.md`, the affected package instructions and current package scripts. For lifecycle or teardown work also read `docs/defensive-patterns.md`.
2. Identify the production owner and a named failure: stale/canceled work, malformed wire/file input, inconsistent projection, unacknowledged mutation, interrupted persistence, disposal leakage or artifact resolution. Identify the existing test that would fail for the regression before adding another verifier.
3. Keep identifiers and states typed; validate parser/process/file/wire inputs, not values already guaranteed by typed same-process interfaces. Cross-language edits update both producers and consumers and run real serialization/conformance cases.
4. Run focused production behavior tests and typed-consumer checks. Use real Loader/preset composition for registrations, disposal and model-visible tools; retain the shipping pipeline while mocking only external/nondeterministic services. Test built exports separately from source-path tests.
5. Apply the existing snapshot policy for changed model/user output. Never rewrite released session generations or normalize away regressions. A replay is not live model evidence.
6. Keep verification economical: do not install a prover, duplicate a reducer/model, run the whole backend suite or add a dependency without a named verification gap. A second model needs an executed production conformance link; bounds remain part of the claim.
7. For optimization, retain a reference oracle and freeze benchmark work, toolchain/features and shipped build flags. Measure equal release work repeatedly, including latency, full process-tree memory and CPU. A changed benchmark requires a new baseline, not a claimed win.

## Evidence

Report exact commands actually run, version/features, outcomes, input/schedule bounds and remaining blind spots. Keep failures, timeouts and source drift visible. Separate unit, recorded replay, real Loader, built launch, native paint, physical pointer/IME, OAuth and live provider checks. Green unit tests, high line coverage, pinned sources and bounded model checks are not proofs or full desktop parity.

The current RC process and native alpha process have distinct API/artifact versions. Inspect and test the target runtime; never infer alpha compatibility from installed RC inspection. Do not change user profiles, credentials, authorization or runtime installation to make a development check pass.
