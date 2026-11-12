---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-11-10-muse-session-coordination

English | [中文](2026-11-10-muse-session-coordination.zh.md)

## Summary

Adds muse-coordination attribution for original task relays and durable worker receipts.

## Table of Contents

- [Declaration](#declaration)
- [Compatibility](#compatibility)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="declaration"></a>
## Declaration

```yaml persistence-change
schemaVersion: 1
id: 2026-11-10-muse-session-coordination
baseline: false
changes:
  - root: "event:agent/inbox/spliced"
    previous: "2026-11-09-bounded-skill-catalog"
    after: "78c1bfd071f366299851eb956debf7aec6060c336c963e232ef705c254e5abce"
    decision: same-version
  - root: "event:developer/message"
    previous: "2026-11-09-bounded-skill-catalog"
    after: "b0bc35050a0d87821c0f8387ab35aac642d429f124f4b42d069bf1e45faa1cd6"
    decision: same-version
  - root: "event:session/title-llm-request"
    previous: "2026-11-09-bounded-skill-catalog"
    after: "e65d27076fb62bdb29f7594eb88945023656e112ba9a3a469615638abbe3efc7"
    decision: same-version
  - root: "event:user/message"
    previous: "2026-11-09-bounded-skill-catalog"
    after: "360c8dfde0769908bc6b076b88f420ea56717492d5c5887f6026e6e6a3948912"
    decision: same-version
```

<a id="compatibility"></a>
## Compatibility

The new source kind is attribution-only. Existing message fields, Session framing and generation names remain unchanged. Readers retain unknown message attribution and preserve its ordinary message content; no new required Session event is introduced. The separate task ledger has its own validated storage domain.

<a id="verification"></a>
## Verification

Native AgentLoop routing and task-card regressions exercise logged assignment inputs, explicit reports, idempotent delivery and cancellation. The keyless muse-main-session-role scenario boots the shipped headless profile and verifies business-tool denial without creating its attempted output file.

<a id="dev-note"></a>
## Dev Note

None.
