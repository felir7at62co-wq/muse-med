---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-11-23-video-review-grid

English | [中文](2026-11-23-video-review-grid.zh.md)

## Summary

Persists an optional grid-page image reference on the frames of video/review start and update events.

## Table of Contents

- [Declaration](#declaration)
- [Compatibility](#compatibility)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="declaration"></a>
## Declaration

```yaml persistence-change
schemaVersion: 1
id: 2026-11-23-video-review-grid
baseline: false
changes:
  - root: "event:video/review"
    previous: "2026-11-22-video-character-observations"
    after: "4edcc6a88477ef1bf4c25584f970653cc92e6ba362e08bcd9736239241c4245a"
    decision: same-version
```

<a id="compatibility"></a>
## Compatibility

Existing reviews remain readable without grid references and keep single-image admission. Earlier readers drop the field and keep every recorded image, exposure and observation; they never deliver grid pages themselves. Observation reports omit the field, so report bytes and digests stay the same for every reader. The Session envelope and writer version are unchanged.

<a id="verification"></a>
## Verification

The video-inspection tests cover grid admission after a failed request and a plugin reload, per-frame accounting across grid batches, offload of a shared page and reports without grid references. The established video observation and review lifecycle snapshots continue to replay.

<a id="dev-note"></a>
## Dev Note

None.
