---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-09-30-muse-v4-request-header-join

English | [中文](2026-09-30-muse-v4-request-header-join.zh.md)

## Summary

Joins the two acknowledged request-header histories while retaining the V4 reserved system field, deferred tool loading, and optional response-format configuration.

## Table of Contents

- [Declaration](#declaration)
- [Compatibility](#compatibility)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="declaration"></a>
## Declaration

```yaml persistence-change
schemaVersion: 2
id: 2026-09-30-muse-v4-request-header-join
baseline: false
changes:
  - root: "event:request/header"
    previous: ["2026-09-16-session-format-v4","2026-09-27-workflow-agent-settlement-identity"]
    after: "a17b7c32461547b1546b59e8adfa07159a369204c52fd0c9f016a0061e3cd8d8"
    decision: same-version
```

<a id="compatibility"></a>
## Compatibility

The request/header after schema retains both predecessor schemas. Relative to the V4 acknowledgement, only optional config.responseFormat is added. Relative to the workflow settlement acknowledgement, only optional tools[].deferLoading and the forbidden system field declaration are added. Existing request headers remain readable; an absent response format or deferred-loading marker preserves their meaning. The reserved system property remains optional never and native readers still refuse a JSON value. Older readers may ignore optional configuration they do not use. This same-version join retains the accepted V4 header transition, both original machine declarations and snapshots, and every committed Session generation; it introduces no writer-version change or migration. The workflow agent-end acknowledgement remains unchanged on its independent root.

<a id="verification"></a>
## Verification

node node_modules/vitest/vitest.mjs run scripts/persistence-changes.spec.ts --maxWorkers=1 passes 80 tests. Join cases check both retained predecessor declarations, merged optional fields, missing or repeated predecessors, unjoined terminal branches, removal and type changes of either parent's field, paired record generation, and finalization checkpoint reconstruction. The record generator compares the current source-derived schema separately against each predecessor and finds no breaking difference.

<a id="dev-note"></a>
## Dev Note

None.
