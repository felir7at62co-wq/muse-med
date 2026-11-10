---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-11-10-native-generation-inbox-claims

English | [中文](2026-11-10-native-generation-inbox-claims.zh.md)

## Summary

Record opt-in durable inbox claims and explicitly parked generation notices without changing released Session generations.

## Table of Contents

- [Declaration](#declaration)
- [Compatibility](#compatibility)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="declaration"></a>
## Declaration

```yaml persistence-change
schemaVersion: 1
id: 2026-11-10-native-generation-inbox-claims
baseline: false
changes:
  - root: "event:agent/inbox/claim"
    previous: null
    after: "a0e0ccee6eafb5768d3d70a18b770f2e46f0cb433b5166071794f45b7f2aa226"
    decision: same-version
  - root: "event:agent/inbox/claim-filtered"
    previous: null
    after: "5693a3ce83271b322c4f9b90578ea06aebc3188348df9aea477831e0b3057d23"
    decision: same-version
  - root: "event:agent/inbox/claim-settled"
    previous: null
    after: "dd3cf0360eea7a8a61f65b2f6a39b392e388753520aa8692e3f1269397fd4a6b"
    decision: same-version
  - root: "event:jubian/generation-notice-parked"
    previous: null
    after: "982bd7ddda1aaac568bb802815acdb1a2321eedf020858982a4667226dd0bd52"
    decision: same-version
```

<a id="compatibility"></a>
## Compatibility

Keep Session format 4. The three claim events record the original queued message IDs, turn and step, filtering and settlement; the parked-notice event records an automatic input removed before its producer unloads. They are required-on-read: older readers that do not know a new event refuse that log, preventing silent loss or duplicate consumption. Readers of this build continue to accept existing logs without these events; profiles that do not enable durableInboxClaims keep their existing event sequence. Recovery retains unread claimed input with its original ID, discards it only under the documented user-cancel/fork decision, and treats already admitted uncertain input as unknown rather than replaying it. Forked Sessions do not inherit a live claim. No committed format generation, migration input or original JSONL fixture is rewritten.

<a id="verification"></a>
## Verification

The independently reviewed Client/Inbox/real AgentLoop SDK server and TypeScript SDK tests passed 143 cases; Python SDK pass-through tests passed 34. The SDK client fixtures establish event transport, not a full real two-language end-to-end call. Eight real Session/model/Workspace native continuation tests and the original independent unload regression passed using deterministic offline model adapters. Real keyless Web queue replay passed 24 cases with one recording-only skip, and its durable-claim variant preserved human input IDs. Final build, complete recorded SDK output qualification, packaging and full candidate integration remain pending.

<a id="dev-note"></a>
## Dev Note

None.
