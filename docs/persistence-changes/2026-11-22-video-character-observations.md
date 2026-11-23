---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-11-22-video-character-observations

English | [中文](2026-11-22-video-character-observations.zh.md)

## Summary

Persists optional character comparisons in the frame observations of video/review start and update events.

## Table of Contents

- [Declaration](#declaration)
- [Compatibility](#compatibility)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="declaration"></a>
## Declaration

```yaml persistence-change
schemaVersion: 1
id: 2026-11-22-video-character-observations
baseline: false
changes:
  - root: "event:video/review"
    previous: "2026-10-29-video-review-follow-up"
    after: "1494cebd6a70f38c07d1b10fbfa12b2e6e373b564b44548772324383f887aacc"
    decision: same-version
```

<a id="compatibility"></a>
## Compatibility

Existing reviews remain readable without character comparisons and retain the existing source checks. Earlier readers can still read the original observation fields and preserve the Session event. They apply their existing evidence and source approval checks, and reject an observation report whose bytes differ from their projected review. Strict selection based on the optional character comparison is available in readers that understand it. The Session envelope and writer version are unchanged.

<a id="verification"></a>
## Verification

The video-inspection tests cover missing optional checks, matching and unresolved comparisons, and rejection after the same Session is restored. Source and built observation snapshots preserve a character finding through an ordinary observation update. The established video observation and review lifecycle snapshots continue to replay.

<a id="dev-note"></a>
## Dev Note

None.
