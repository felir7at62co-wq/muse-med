---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-11-18-task-skill-version

English | [中文](2026-11-18-task-skill-version.zh.md)

## Summary

Records an optional SHA-256 of the rendered instructions on explicit task skill invocations.

## Table of Contents

- [Declaration](#declaration)
- [Compatibility](#compatibility)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="declaration"></a>
## Declaration

```yaml persistence-change
schemaVersion: 1
id: 2026-11-18-task-skill-version
baseline: false
changes:
  - root: "event:agent/inbox/spliced"
    previous: "2026-11-18-muse-router-production"
    after: "3ecea67d7461aad0997293128ef9f73b33357d58e128fd3645ad4c1cb20fcb80"
    decision: same-version
  - root: "event:developer/message"
    previous: "2026-11-18-muse-router-production"
    after: "3882ae20f501500f7de29ca4405de601723d3f0b763cb09d7f0d24479a8bfa4f"
    decision: same-version
  - root: "event:session/title-llm-request"
    previous: "2026-11-18-muse-router-production"
    after: "40e2889044487ee7fca767922de15b5d68570afceba27931ef9484a1754fef29"
    decision: same-version
  - root: "event:user/message"
    previous: "2026-11-18-muse-router-production"
    after: "57d7977bf84c7519143fb285f05f0c20acd5c836a4b3437221361b3cb82fce05"
    decision: same-version
```

<a id="compatibility"></a>
## Compatibility

An older reader still sees a complete skill invocation and its original text. A current reader accepts historical invocations without the optional digest and does not infer a task phase from them. The existing message discriminator and Session version remain valid.

<a id="verification"></a>
## Verification

The tool-skill, skill and desktop-host tests exercise unmarked invocations, a real compacted Session, cold JSONL resume, replacement, release and version changes.

<a id="dev-note"></a>
## Dev Note

None.
