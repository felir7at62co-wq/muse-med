---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-11-15-session-activity-source

English | [中文](2026-11-15-session-activity-source.zh.md)

## Summary

Adds the session-activity user-message source written into a parent Session when it receives a digest of the Sessions it watches.

## Table of Contents

- [Declaration](#declaration)
- [Compatibility](#compatibility)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="declaration"></a>
## Declaration

```yaml persistence-change
schemaVersion: 1
id: 2026-11-15-session-activity-source
baseline: false
changes:
  - root: "event:agent/inbox/spliced"
    previous: "2026-11-12-muse-main-coordinator-attribution-join"
    after: "e8c6fc6673990685c3ccdb4331417519950a67f7e7aeac35d3d815a123410037"
    decision: same-version
  - root: "event:developer/message"
    previous: "2026-11-12-muse-main-coordinator-attribution-join"
    after: "a2d6e48ca336be861ef5878ef441238b10cb5c167492d69ca4331b2c2d56052a"
    decision: same-version
  - root: "event:session/title-llm-request"
    previous: "2026-11-12-muse-main-coordinator-attribution-join"
    after: "b99ed1595d045fbf7d06e0f802343409972a2dd6c2d74cf2ef496d24e55da34f"
    decision: same-version
  - root: "event:user/message"
    previous: "2026-11-12-muse-main-coordinator-attribution-join"
    after: "95221de83f281e153f237219268fb343d48447ff67a31c970d9049ffc7ab0ccd"
    decision: same-version
```

<a id="compatibility"></a>
## Compatibility

The source is a new merge-extensible MessageSourceMap kind with a notice form and summary; older readers fall through unknown kinds and present the message as opaque user content, and the message content is ordinary text. No existing event or source changes, so the Session format version is unchanged.

<a id="verification"></a>
## Verification

pnpm exec vitest run packages/session/session-activity packages/session/session-coordinator/tests/activity.spec.ts

<a id="dev-note"></a>
## Dev Note

None.
