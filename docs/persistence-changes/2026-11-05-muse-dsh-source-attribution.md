---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-11-05-muse-dsh-source-attribution

English | [中文](2026-11-05-muse-dsh-source-attribution.zh.md)

## Summary

Joins the released DSH source-attribution declarations with Muse task and video source fields while retaining both predecessor acknowledgements.

## Table of Contents

- [Declaration](#declaration)
- [Compatibility](#compatibility)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="declaration"></a>
## Declaration

```yaml persistence-change
schemaVersion: 2
id: 2026-11-05-muse-dsh-source-attribution
baseline: false
changes:
  - root: "event:agent/inbox/spliced"
    previous: ["2026-10-13-liveshare-share-viewer-principal","2026-10-28-jubian-video-reuse-advisory"]
    after: "ea0842855309e9d6bb36eea0033afd968e975b6586b39c632c7e7d2701a611fe"
    decision: same-version
  - root: "event:developer/message"
    previous: ["2026-10-13-liveshare-share-viewer-principal","2026-10-28-jubian-video-reuse-advisory"]
    after: "e0b2e1b8723ec2b6217030dfe54154befd1fb185016e418367f26195911a56d0"
    decision: same-version
  - root: "event:session/title-llm-request"
    previous: ["2026-10-13-liveshare-share-viewer-principal","2026-10-28-jubian-video-reuse-advisory"]
    after: "e144f096969e45aa427adea3655bea0a17b496c34b556b63d0353e90d55e3798"
    decision: same-version
  - root: "event:user/message"
    previous: ["2026-10-13-liveshare-share-viewer-principal","2026-10-28-jubian-video-reuse-advisory"]
    after: "a55a45812f47702b2a328e2cf8f1edc611b264e15092a8d8ed9459ddebb8b2f6"
    decision: same-version
```

<a id="compatibility"></a>
## Compatibility

The four ordinary event roots retain both parent declarations. New source variants preserve attribution through the declared unknown-source policy; additional task and video fields remain optional. Session header, envelope and writer format remain unchanged. Existing acknowledgement schemas and canonical Session generations remain intact.

<a id="verification"></a>
## Verification

The persistence history tests cover both predecessor additions and reject a join that removes or changes a parent field. Inline acknowledgement graphs pass the same digest and node-reference validation as node-table graphs. The source-derived check validates the joined schemas against the current event declarations.

<a id="dev-note"></a>
## Dev Note

None.
