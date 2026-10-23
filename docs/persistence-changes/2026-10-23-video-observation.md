---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-10-23-video-observation

English | [中文](2026-10-23-video-observation.zh.md)

## Summary

Adds required video/review events for complete-episode scans, image admission and grounded per-frame observation progress.

## Table of Contents

- [Declaration](#declaration)
- [Compatibility](#compatibility)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="declaration"></a>
## Declaration

```yaml persistence-change
schemaVersion: 1
id: 2026-10-23-video-observation
baseline: false
changes:
  - root: "event:video/review"
    previous: null
    after: "a51ea1c0eeabeaf78e7339560ea6bd1b776373db63e4831e7eceb73f1e66d489"
    decision: same-version
```

<a id="compatibility"></a>
## Compatibility

Existing events and the Session envelope are unchanged. The new event is required because ignoring it would discard pending delivery checks; older runtimes refuse Sessions containing it. Incremental updates rebuild the Host-only projection after reload.

<a id="verification"></a>
## Verification

Real FFmpeg and actual model-dispatch tests cover full-range cuts, cumulative pan changes, unseen-frame rejection, failed image requests, same-program claims, pending delivery, source changes and plugin reload.

<a id="dev-note"></a>
## Dev Note

None.
