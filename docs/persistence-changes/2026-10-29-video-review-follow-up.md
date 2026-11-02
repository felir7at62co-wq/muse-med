---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-10-29-video-review-follow-up

English | [中文](2026-10-29-video-review-follow-up.zh.md)

## Summary

Adds optional per-video follow-up activity to saved observation starts and updates.

## Table of Contents

- [Declaration](#declaration)
- [Compatibility](#compatibility)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="declaration"></a>
## Declaration

```yaml persistence-change
schemaVersion: 1
id: 2026-10-29-video-review-follow-up
baseline: false
changes:
  - root: "event:video/review"
    previous: "2026-10-24-video-event-groups"
    after: "5781c389fbe44583fcaa6b8e6e8194163bc90a27b241f5cb0efc1c7af428bdbd"
    decision: same-version
```

<a id="compatibility"></a>
## Compatibility

Existing video/review events remain readable and missing follow_up means active. Closed activity preserves all source revisions, cached frames, scan progress and observations; reopening verifies the unchanged source. No Session envelope or writer version changes.

<a id="verification"></a>
## Verification

Keyless review tests cover preserved evidence gaps, repeated close/reopen, unchanged-source resume, changed-source rejection, missing-source closure, cold projection restore, and legacy results without follow_up.

<a id="dev-note"></a>
## Dev Note

None.
