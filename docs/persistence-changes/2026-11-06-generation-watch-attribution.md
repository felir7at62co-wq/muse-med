---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-11-06-generation-watch-attribution

English | [中文](2026-11-06-generation-watch-attribution.zh.md)

## Summary

Records generation-watch notifications as additive producer attribution with independently persisted group handoffs.

## Table of Contents

- [Declaration](#declaration)
- [Compatibility](#compatibility)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="declaration"></a>
## Declaration

```yaml persistence-change
schemaVersion: 1
id: 2026-11-06-generation-watch-attribution
baseline: false
changes:
  - root: "event:agent/inbox/spliced"
    previous: "2026-10-28-jubian-video-reuse-advisory"
    after: "6c37a088618b135bd4c0abb19be92614188d624c53e08eaccdbe589d59506296"
    decision: same-version
  - root: "event:developer/message"
    previous: "2026-10-28-jubian-video-reuse-advisory"
    after: "e227a3a9ea5ff1ee20967f7a6bb3f7209138142ff57328b1bdeb6fe7b2c84a0e"
    decision: same-version
  - root: "event:session/title-llm-request"
    previous: "2026-10-28-jubian-video-reuse-advisory"
    after: "0b01cb0d38b2c5bd015a193722ecb3b9e7eb5d82ce577e4dc16aad30a29db7cc"
    decision: same-version
  - root: "event:user/message"
    previous: "2026-10-28-jubian-video-reuse-advisory"
    after: "328787366ef0ced90e9b84802d060418f88be8d79465489b7bc0ca3aa902aa7b"
    decision: same-version
```

<a id="compatibility"></a>
## Compatibility

Existing V4 events remain readable. Readers without the producer retain notification text, identity and source metadata without interpreting group fields. Group routing derives only from a separately saved handoff matching the worker, notice and receipt IDs. Creating a missing handoff requires the original bot/room assignment in the worker Session history; source metadata cannot create or redirect one. A notification without that evidence remains readable and reports group delivery for review. Existing valid handoffs retain restart, deduplication and pause behavior. No Session header or event-envelope change is required.

<a id="verification"></a>
## Verification

37 generation-watch Loader/native source admission tests and 64 group-work tests passed. Coverage includes producer-absent readback with complete group metadata and unchanged model history, valid assignment reconstruction, missing assignment refusal, source requester tampering, mismatched worker/notice identities, restart, requester receipt deduplication and parked handoff recovery. Fresh extraction classifies four affected roots as same-version attribution additions.

<a id="dev-note"></a>
## Dev Note

None.
