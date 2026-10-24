---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-10-24-video-event-groups

English | [中文](2026-10-24-video-event-groups.zh.md)

## Summary

Adds optional model-authored visual event groups and a revision-bound saved ASR reference to video reviews.

## Table of Contents

- [Declaration](#declaration)
- [Compatibility](#compatibility)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="declaration"></a>
## Declaration

```yaml persistence-change
schemaVersion: 1
id: 2026-10-24-video-event-groups
baseline: false
changes:
  - root: "event:video/review"
    previous: "2026-10-23-video-observation"
    after: "3a7a2a0ae101f700a0b05dd7d4d008406f51689f5a215eb106ce578e299d8c43"
    decision: same-version
```

<a id="compatibility"></a>
## Compatibility

Existing video/review records and projection snapshots remain readable without event_groups or transcript_reference. Both fields are optional in start and update records; absence retains the prior value and a new video revision inherits neither. Events bind to observation digests without establishing semantic correctness. The ASR reference retains path, filesystem version and SHA256; implicit reread failure returns advisory diagnostics without blocking event notes or delivery. Observation completion and delivery conditions are unchanged.

<a id="verification"></a>
## Verification

Focused video and manuscript behavior tests, recorded-session replay and both SDK projections exercise optional events and saved ASR references alongside legacy reviews without them. Event evidence is model-authored; these checks do not establish screenplay quality.

<a id="dev-note"></a>
## Dev Note

None.
