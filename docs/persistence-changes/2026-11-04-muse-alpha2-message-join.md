---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-11-04-muse-alpha2-message-join

English | [中文](2026-11-04-muse-alpha2-message-join.zh.md)

## Summary

Joins the V4 histories of four message-bearing events after integrating DSH 0.2.1-alpha.2.

## Table of Contents

- [Declaration](#declaration)
- [Compatibility](#compatibility)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="declaration"></a>
## Declaration

```yaml persistence-change
schemaVersion: 2
id: 2026-11-04-muse-alpha2-message-join
baseline: false
changes:
  - root: "event:agent/inbox/spliced"
    previous: ["2026-10-05-working-directory-attribution","2026-10-28-jubian-video-reuse-advisory"]
    after: "86efd0c875c9ca4b27a9990f99b728433c0736d9b0842f90afea5cba423f3ebe"
    decision: same-version
  - root: "event:developer/message"
    previous: ["2026-10-05-working-directory-attribution","2026-10-28-jubian-video-reuse-advisory"]
    after: "13ea55c93a0d3abdb7a0f63e126bb7d14d1a105cdbf5fa9b304641fe21b73865"
    decision: same-version
  - root: "event:session/title-llm-request"
    previous: ["2026-10-07-title-reasoning-effort","2026-10-28-jubian-video-reuse-advisory"]
    after: "da1814ad522146407f02a565bd6b88c5e292d213fbe730b8dd077a35aff7372e"
    decision: same-version
  - root: "event:user/message"
    previous: ["2026-10-05-working-directory-attribution","2026-10-28-jubian-video-reuse-advisory"]
    after: "2960e0622ba6a33314027bd45e0d97edb402184ab22ee5db4dea0dd0f1699906"
    decision: same-version
```

<a id="compatibility"></a>
## Compatibility

The merged reader accepts records from both histories and retains their existing message meaning. The added source kinds carry attribution only. Older V4 readers retain the unknown source and its JSON metadata without interpreting it. Title request reasoning effort remains optional. A record without it has no recorded effort, and older readers can ignore it. The Session writer remains V4.

<a id="verification"></a>
## Verification

Source-derived schemas compared with all eight predecessor schemas show only qualified attribution additions and one optional field addition. The working directory, title LLM and Jubian video reuse suites pass 42 tests.

<a id="dev-note"></a>
## Dev Note

None.
