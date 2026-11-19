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
    previous: "2026-11-16-frame-offload-notice"
    after: "12edaf44a720c36be66769ff425a33238c819e1626fa986f879ff588e2c01326"
    decision: same-version
  - root: "event:developer/message"
    previous: "2026-11-16-frame-offload-notice"
    after: "902b15b30032714c0007111bf052fec90ea4f8664c8c186672a730e97fa786a1"
    decision: same-version
  - root: "event:session/title-llm-request"
    previous: "2026-11-16-frame-offload-notice"
    after: "cfdf0992f293aa0f49892099d675beb9d95e187e4559f0290763af2b92724a3c"
    decision: same-version
  - root: "event:user/message"
    previous: "2026-11-16-frame-offload-notice"
    after: "255a00e63990405d8b65184475ac5757300844072583e7f11f5e268550fa5a31"
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
