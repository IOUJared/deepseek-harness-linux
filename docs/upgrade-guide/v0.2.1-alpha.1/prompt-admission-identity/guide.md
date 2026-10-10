---
kind: upgrade-guide
description: "Prompt request identity now rejects changed or unverifiable same-ID resends."
---

# Prompt admission identity

English | [中文](guide.zh.md)

## Change

Session RPC consumers can no longer reuse `(sessionId, requestId)` with different prompt content or delivery metadata and receive an acceptance acknowledgement. The Host reserves identity before asynchronous admission; retained identical requests share the original promise and outcome, while changed payload returns `session/prompt-conflict` with `PAYLOAD_CHANGED`. An existing predecessor admission without its original request digest returns `PAYLOAD_UNVERIFIABLE` instead of establishing payload equality. Historical inbox insertions remain positive admission evidence after claim or removal, before `user/message` exists. Generic admission failures expose fixed `PROMPT_ADMISSION_FAILED` rather than raw exception reasons.

The new read-only `session.promptAdmission` endpoint distinguishes positive acceptance, pending admission, retained definite pre-dispatch rejection, and unknown. It never activates a cold Agent or retries a write. Acceptance is not provider completion or an fsync acknowledgement. The optional `user-rpc.promptFingerprint` metadata uses existing events; no Session-history rewrite or mandatory format migration is required.

## Migration

1. Give each new immutable intent its own `SessionPromptRequest.requestId`. Keep its original mode, ordered text/images/files, image metadata, file receipt identifiers and raw timezone unchanged while admission is uncertain. Do not reuse its identity for edits.
2. After a lost acknowledgement, call `session.promptAdmission({sessionId, requestId})` on the same Session. Do not automatically replay the prompt, change its payload or mint another identity to recover an uncertain write. `unknown`, missing evidence, lookup failure and lost process-local receipts do not permit resend.
3. Handle `session/prompt-conflict`, `session/prompt-capacity` and `session/prompt-closed`. Do not classify an admission as rejected solely from the original exception code: a failure after inbox dispatch can still have positive acceptance evidence.
4. Confirm concurrent identical requests cause one admission, changed same-ID requests conflict, and a cold status query does not create an Agent. For legacy records, confirm status can report accepted while payload-equivalent resend remains unverifiable. See the [Session Controller reference](../../../../packages/api/session-controller/README.md) for status and retention semantics.
