---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-10-07-prompt-admission-fingerprint

English | [中文](2026-10-07-prompt-admission-fingerprint.zh.md)

## Summary

Adds optional promptFingerprint metadata to the persisted user-RPC message source for payload-correct prompt admission recovery.

## Table of Contents

- [Declaration](#declaration)
- [Compatibility](#compatibility)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="declaration"></a>
## Declaration

```yaml persistence-change
schemaVersion: 1
id: 2026-10-07-prompt-admission-fingerprint
baseline: false
changes:
  - root: "event:agent/inbox/spliced"
    previous: "2026-09-21-user-question-reply"
    after: "12f008526af9325e3b8cf94ca322ead42f8e894a8b9d5469f29a39776ea9b682"
    decision: same-version
  - root: "event:developer/message"
    previous: "2026-09-21-user-question-reply"
    after: "22fa7e4c6fe2667c61e9a71c5479a5d1d3cbca383f9493bd5f9fb095f428924f"
    decision: same-version
  - root: "event:session/title-llm-request"
    previous: "2026-09-21-user-question-reply"
    after: "50dc9b41724896e1c50ed723e1b7d6799fb1e64a59b1cd0df492fefbbcf36d90"
    decision: same-version
  - root: "event:user/message"
    previous: "2026-09-21-user-question-reply"
    after: "3b55b762020d64cb76a51148b48edf5e7aaddbff7e7f816280aa7a1d5b3a42b2"
    decision: same-version
```

<a id="compatibility"></a>
## Compatibility

Existing records remain valid without the field. The Host writes a versioned SHA-256 digest of the original declared request; it never changes message content or derived model input. Older readers can ignore this optional source metadata and retain the recorded messages. Missing, malformed or unsupported digests do not establish payload equality: legacy request-ID reuse is refused while a nonmutating status read can still report positive existing admission evidence. No Session header, envelope, writer version or SQLite schema changes.

<a id="verification"></a>
## Verification

The persistence classifier identifies optional additions in agent/inbox/spliced, developer/message, session/title-llm-request and user/message, with no version increase required. Focused Session command and admission regressions passed 53 tests; real Loader and SDK replay qualification are recorded separately rather than implied by this acknowledgement.

<a id="dev-note"></a>
## Dev Note

None.
