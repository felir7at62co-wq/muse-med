---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-10-17-session-video-selection

English | [中文](2026-10-17-session-video-selection.zh.md)

## Summary

Records explicit conversation video-model and resolution choices and their appended context notices.

## Table of Contents

- [Declaration](#declaration)
- [Compatibility](#compatibility)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="declaration"></a>
## Declaration

```yaml persistence-change
schemaVersion: 1
id: 2026-10-17-session-video-selection
baseline: false
changes:
  - root: "event:agent/inbox/spliced"
    previous: "2026-10-10-screenplay-self-check-read"
    after: "f085dd54110dec859015f00be03b3cca9f89ee4453f13c15475ed4d29b355bad"
    decision: same-version
  - root: "event:developer/message"
    previous: "2026-10-10-screenplay-self-check-read"
    after: "8a6b94a4953dffa0e75b7719513e3723c0120a05ccf19d2bdb24002e97407c6a"
    decision: same-version
  - root: "event:jubian/video-selection"
    previous: null
    after: "5d51147a01535f1aa01a7c6cd9d2a27ba2f9262c6f51e81d59c90de0dfa7128b"
    decision: same-version
  - root: "event:session/title-llm-request"
    previous: "2026-10-10-screenplay-self-check-read"
    after: "31f3c9d54f3f5607a53c45aad9ef7120b4f1ed7707f6ec607dee674664aafab4"
    decision: same-version
  - root: "event:user/message"
    previous: "2026-10-10-screenplay-self-check-read"
    after: "c7c997c0ccfa257322588cf64eac056323ce2826d9a3f9263b97e82e83377ec9"
    decision: same-version
```

<a id="compatibility"></a>
## Compatibility

Existing sessions remain readable. The required jubian/video-selection event preserves the user's choice across reload, forks and compaction; builds without that event refuse these new logs rather than reconstruct a different generation setting. Video model changes do not replace the system prompt or modify submitted provider tasks.

<a id="verification"></a>
## Verification

The video-session and video-selector focused tests pass, including 25-second packages under a 15-second model, explicit model choice, stale-preview refusal, card synchronization and original-key reconciliation.

<a id="dev-note"></a>
## Dev Note

None.
