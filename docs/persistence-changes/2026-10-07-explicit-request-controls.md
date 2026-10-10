---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-10-07-explicit-request-controls

English | [中文](2026-10-07-explicit-request-controls.zh.md)

## Summary

Adds optional explicit serviceTier and textVerbosity to model selections and request-header call configuration, plus agentServiceTier and agentTextVerbosity to subagent descriptors.

## Table of Contents

- [Declaration](#declaration)
- [Compatibility](#compatibility)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="declaration"></a>
## Declaration

```yaml persistence-change
schemaVersion: 1
id: 2026-10-07-explicit-request-controls
baseline: false
changes:
  - root: "event:model/selection"
    previous: "2026-09-11-initial"
    after: "041111caf5b7db48fecf5668f2dbe5e8d9441816353c2f7d8245d2ddaafd8095"
    decision: same-version
  - root: "event:request/header"
    previous: "2026-09-16-session-format-v4"
    after: "e6c1755329990e534502375ac02a6eeb09fff3e9e6b3b7e3f7d21d915c3ef0a6"
    decision: same-version
  - root: "event:subagent/descriptor"
    previous: "2026-09-11-initial"
    after: "010e20432158fda87d1468194248ce13d75dcd1fd97e92a491f0346a6941d375"
    decision: same-version
```

<a id="compatibility"></a>
## Compatibility

All six properties are optional additions. Existing records retain absence and provider behavior; display defaults never materialize these controls or add adapter-default markers. Current restoration preserves explicit controls and rejects invalid scalar values. Historical schemas and committed Session generations remain unchanged; no Session or SQLite writer-version increase is required.

<a id="verification"></a>
## Verification

Focused backend tests pass (59 tests, plus a 49-test durable-parser/projection/control run). The unchanged shipped base+Web Loader composition passes selection acknowledgement, durable projection/header, captured conversation requests, denial before all provider calls or profile writes, same-route changes, restart/restoration and omission. The new request-controls current-format Session refresh and keyless replay pass through the built headless profile; its four headers and route-only notice are fixed-point evidence.

<a id="dev-note"></a>
## Dev Note

None.
