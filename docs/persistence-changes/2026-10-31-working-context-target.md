---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-10-31-working-context-target

English | [中文](2026-10-31-working-context-target.zh.md)

## Summary

Adds an optional workingTokenLimit to request/context for the routed compaction target.

## Table of Contents

- [Declaration](#declaration)
- [Compatibility](#compatibility)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="declaration"></a>
## Declaration

```yaml persistence-change
schemaVersion: 1
id: 2026-10-31-working-context-target
baseline: false
changes:
  - root: "event:request/context"
    previous: "2026-09-11-initial"
    after: "6b8aae0eeb37a056c0770d57276b41b3ca1364abc5f9c233906d3f359fda5c6f"
    decision: same-version
```

<a id="compatibility"></a>
## Compatibility

Existing Session generations remain valid because the new field is optional. Missing values retain the model-window display and clear a prior route target. No canonical log or migration generation is replaced.

<a id="verification"></a>
## Verification

Focused context-pressure projection and context-meter tests exercise recorded targets, absent legacy values, target removal and route switching; final results are recorded in the repair report.

<a id="dev-note"></a>
## Dev Note

None.
