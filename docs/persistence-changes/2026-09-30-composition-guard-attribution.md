---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-09-30-composition-guard-attribution

English | [中文](2026-09-30-composition-guard-attribution.zh.md)

## Summary

Records composition-guard as qualified attribution for logged user and developer message sources, including inbox and auxiliary title-request messages.

## Table of Contents

- [Declaration](#declaration)
- [Compatibility](#compatibility)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="declaration"></a>
## Declaration

```yaml persistence-change
schemaVersion: 1
id: 2026-09-30-composition-guard-attribution
baseline: false
changes:
  - root: "event:agent/inbox/spliced"
    previous: "2026-09-21-user-question-reply"
    after: "dc8960018e69c0820980ac5f43df7d64473d3549e52c67973fc58019ee4a2829"
    decision: same-version
  - root: "event:developer/message"
    previous: "2026-09-21-user-question-reply"
    after: "949bae661f6e9f3e961a1ec974d06923d79ec4b141b3c6c8e427206793d703ae"
    decision: same-version
  - root: "event:session/title-llm-request"
    previous: "2026-09-21-user-question-reply"
    after: "49ece5a41cb4d3856f4ac01090e19d1a834587637027bd98dcde3d4154777aa3"
    decision: same-version
  - root: "event:user/message"
    previous: "2026-09-21-user-question-reply"
    after: "61ab6f6e21398c16fb9492b4f8ea7b87c94847a3c51e85661e4deeee0d16f70e"
    decision: same-version
```

<a id="compatibility"></a>
## Compatibility

Every before schema already carries the source-attribution preservation policy. The new composition-guard kind is absent from those snapshots and qualifies under that existing policy. Its notice form and summary describe transcript presentation; the recorded content carries the model-visible warning. The guard does not read this source to decide tool availability, baseline validity or duplicate suppression: those decisions use the runtime record set and live registry. Native and detached readers preserve the source's own JSON fields and derive the message without the producer. The new qualification retains the complete form and summary declarations, introduces no new validation or authority requirement, and changes no existing kind group. Existing V4 records and all historical declarations, snapshots and generations remain unchanged; no migration or writer-version bump is required.

<a id="verification"></a>
## Verification

The focused run of `scripts/persistence-changes.spec.ts`, `scripts/persistence-formats.spec.ts`, `packages/guard/composition-guard/tests/composition-guard.spec.ts`, and `packages/session/session-format-v3-to-v4/tests/attribution.spec.ts` passes 196 tests across four files. The native attribution cases encode and decode composition-guard notices for both user and developer roles, restore them through detached Session adoption without the producer, derive their complete recorded content and source metadata, and reproduce the same physical rows. The guard suite exercises registry withdrawal, baseline checks and report suppression. Source review finds no guard consumer of the notice source.

<a id="dev-note"></a>
## Dev Note

None.
