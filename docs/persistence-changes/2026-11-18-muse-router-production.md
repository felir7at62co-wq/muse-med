---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-11-18-muse-router-production

English | [中文](2026-11-18-muse-router-production.zh.md)

## Summary

Record the local Router introduction and the user's confirmed Jingliu production as attributed notices in the existing message envelope.

## Table of Contents

- [Declaration](#declaration)
- [Compatibility](#compatibility)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="declaration"></a>
## Declaration

```yaml persistence-change
schemaVersion: 1
id: 2026-11-18-muse-router-production
baseline: false
changes:
  - root: "event:agent/inbox/spliced"
    previous: "2026-11-16-frame-offload-notice"
    after: "8554cf1b722e52582f19badc44dd0baf3d07e789247f5223c630e3d808b4e8b4"
    decision: same-version
  - root: "event:developer/message"
    previous: "2026-11-16-frame-offload-notice"
    after: "dc0fbfdb30a76f059e8d2fcfba6c7854c9f2fc6a6625271ade3593e78dd97206"
    decision: same-version
  - root: "event:session/title-llm-request"
    previous: "2026-11-16-frame-offload-notice"
    after: "90e81fcda543d7c3249523608e4128d7004e47f518cbbbc29a3675679679d99b"
    decision: same-version
  - root: "event:user/message"
    previous: "2026-11-16-frame-offload-notice"
    after: "0160ba58fbfc1a805012ea62c8e68aa27afe0f76cce0a47edb4be7391af00bf5"
    decision: same-version
```

<a id="compatibility"></a>
## Compatibility

Both sources carry a notice form, summary and textual content. Existing messages remain readable. Readers that do not recognize either source can display the notice and cannot treat it as direct human routing authority.

<a id="verification"></a>
## Verification

Router and project tests cover an opening turn, human-input requirements, and project isolation between local conversations and studio accounts.

<a id="dev-note"></a>
## Dev Note

None.
