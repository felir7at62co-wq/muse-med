---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-11-10-native-generation-attribution-join

English | [中文](2026-11-10-native-generation-attribution-join.zh.md)

## Summary

Retain the independently recorded bounded Skill catalog and generation-notice attribution in one Session reader vocabulary.

## Table of Contents

- [Declaration](#declaration)
- [Compatibility](#compatibility)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="declaration"></a>
## Declaration

```yaml persistence-change
schemaVersion: 2
id: 2026-11-10-native-generation-attribution-join
baseline: false
changes:
  - root: "event:agent/inbox/spliced"
    previous: ["2026-11-06-generation-watch-attribution","2026-11-09-bounded-skill-catalog"]
    after: "0da2bc98d93287c3cd9dc67c6179bc79f69a0b3dbfe8702aa6b1f7da7a7e58a5"
    decision: same-version
  - root: "event:developer/message"
    previous: ["2026-11-06-generation-watch-attribution","2026-11-09-bounded-skill-catalog"]
    after: "a3ace94fa9010ad4fe4d45afa59957cac6e8ab6b10e3c89b1abf502bea409d8c"
    decision: same-version
  - root: "event:session/title-llm-request"
    previous: ["2026-11-06-generation-watch-attribution","2026-11-09-bounded-skill-catalog"]
    after: "4896470c2ca4757968191be32548102b56f12718391b06ef9e0cb570ef2a3944"
    decision: same-version
  - root: "event:user/message"
    previous: ["2026-11-06-generation-watch-attribution","2026-11-09-bounded-skill-catalog"]
    after: "c07728572cd84036fe0a8103ac1fd8b921faf914c38c67fd8e165fc8ceb397b4"
    decision: same-version
```

<a id="compatibility"></a>
## Compatibility

Keep format 4 and both predecessor records unchanged. The merged message sources retain every predecessor field and its declared attribution-only policy. Current readers accept either older source form; display readers without the producer preserve text and message identity. Attribution does not authorize routing, generation or review. This Desktop composition keeps DS Bot archived and holds legacy group notices for review. Required durable-claim and parked-notice events are acknowledged separately; readers that do not know those events refuse them rather than silently dropping input.

<a id="verification"></a>
## Verification

The producer-absent real JSONL readback test preserves notification text, identity and model history. Native ordinary-Session recovery tests pass in the isolated candidate. The final real Loader, native resume and native binding combination passed 25 tests after correcting four obsolete owner fixtures; the initial failures and diagnoses remain in the repair report. Final build, full keyless and packaging verification remain incomplete.

<a id="dev-note"></a>
## Dev Note

None.
