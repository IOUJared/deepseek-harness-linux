---
kind: upgrade-guide
description: "Forwarded Host event queues and pending questions now fail explicitly when configured count or JSON byte limits are exceeded."
---

# Bounded forwarded Host events

English | [中文](guide.zh.md)

## Change

Forwarded event backlogs and pending scoped invocations were unbounded. Gateway now limits the built-in source and each Client backlog independently to 128 items and 262144 UTF-8 JSON bytes by default; pending invocations have separate limits with the same defaults. Overflow reports `gateway/event-overflow` instead of silently dropping or delegating questions. Source overflow ends the registration; Client overflow revokes only that generation, preserving other Clients' deliveries.

The source factory receives a second argument, `TypertRemoteEventBuffer`. Existing single-argument factories remain type-compatible but own their producer-side buffering unless they use it. Wire event fields and Session formats are unchanged.

## Migration

1. Review the Gateway plugin's `config` in `cordis.yml`. Set positive safe integers for `remoteEventBufferItems`, `remoteEventBufferBytes`, `remoteEventPendingItems` and `remoteEventPendingBytes` if the defaults do not cover your deployment. Byte accounting includes JSON metadata, not process-local capabilities or socket framing; see [the owning limits](../../../../packages/api/gateway/README.md#forwarded-event-buffers).
2. Custom source providers can use `buffer.push(dispatch)` and return `buffer.iterate(disposeListeners)`; attach cleanup before publishing data. Providers that ignore the supplied buffer must bound their own queues.
3. Confirm normal delivery and that overload produces an explicit failure, not `next()`. After source overflow, correct load or capacity and explicitly re-register the source; stream retries alone do not recreate it. Restore notification-dependent state through owner queries or opening baselines.
