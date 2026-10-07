---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-10-08-output-continuation

English | [中文](2026-10-08-output-continuation.zh.md)

## Summary

Adds the producer-owned output-continuation source to logged user-role input.

## Table of Contents

- [Declaration](#declaration)
- [Compatibility](#compatibility)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="declaration"></a>
## Declaration

```yaml persistence-change
schemaVersion: 1
id: 2026-10-08-output-continuation
baseline: false
changes:
  - root: "event:agent/inbox/spliced"
    previous: "2026-09-30-composition-guard-attribution"
    after: "38b41de66ce068ed4f34146e46b2d2bacc489e87baf8ec2b238f24e7dbc1d81c"
    decision: same-version
  - root: "event:developer/message"
    previous: "2026-09-30-composition-guard-attribution"
    after: "18497142905a51d3d0cdc72ca4f015bf271532ff534654de7358904c321c41dd"
    decision: same-version
  - root: "event:session/title-llm-request"
    previous: "2026-09-30-composition-guard-attribution"
    after: "8eb9f501473d8d167b979409fc71e36d4d5b61e7dcc887ba6882bfde871b2df3"
    decision: same-version
  - root: "event:user/message"
    previous: "2026-09-30-composition-guard-attribution"
    after: "7ffbd33ebbc58c33886896a3b4f8eb5e332bb53872f05cc48130cd88bc73f69d"
    decision: same-version
```

<a id="compatibility"></a>
## Compatibility

Existing session generations remain unchanged and valid. New records attribute automatic input to the continuation plugin; adjacent step events identify the turn and preceding response. generic source readers retain unknown producer metadata. The source grants no automatic resumption authority after restart.

<a id="verification"></a>
## Verification

Production loop and continuation tests: 463 passed with 100% statement, branch, function and line coverage on affected runtime files. The new SDK recorded session completes three response segments in one turn; the legacy manual continuation scenario remains unchanged.

<a id="dev-note"></a>
## Dev Note

None.
