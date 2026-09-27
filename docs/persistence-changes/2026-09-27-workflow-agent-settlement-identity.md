---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-09-27-workflow-agent-settlement-identity

English | [中文](2026-09-27-workflow-agent-settlement-identity.zh.md)

## Summary

Record which child a workflow member settled, and why it failed, on the durable workflow member settlement record.

## Table of Contents

- [Declaration](#declaration)
- [Compatibility](#compatibility)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="declaration"></a>
## Declaration

```yaml persistence-change
schemaVersion: 1
id: 2026-09-27-workflow-agent-settlement-identity
baseline: false
changes:
  - root: "event:request/header"
    previous: "2026-09-11-initial"
    after: "86d346e960ae99afd17e93e196fd21ec4af124c9291e9a8dfdb120b21e2b2b61"
    decision: same-version
  - root: "event:tool-workflow/agent-end"
    previous: "2026-09-11-initial"
    after: "97f28ee66b90659375a15144c1629b784d4f4a70978d0b414e6bdde2e20d5da0"
    decision: same-version
```

<a id="compatibility"></a>
## Compatibility

The three `tool-workflow/agent-end` members are optional additions to an existing payload, so every log written before them stays readable and keeps its current meaning: `label` and `childId` repeat what `tool-workflow/agent-start` already records for the same run and sequence, and an absent `reason` was already the state of every earlier settlement. A reader that ignores all three still reconstructs the run, its members, and their outcomes exactly as before, and the adjacent v0-to-v1 validator admits each member when present and validates its type. The Session format version, the event envelope, and the event vocabulary are unchanged. The `event:request/header` entry also recorded here acknowledges the optional `config.responseFormat` member that concurrent work in this tree added to the same payload root; its own compatibility argument is that an absent response format leaves every earlier request reading as it did.

<a id="verification"></a>
## Verification

`packages/workflow/tool-workflow/tests/invariant.spec.ts` covers the added checks on both live append and cold history: a `failed` settlement without a reason, an unrecognized reason kind, an empty structured-output detail, a reason on a completed member, a member identity diverging from its start, and an empty child id all fail the durable-record invariant, while a settlement that omits the repeated identity stays readable. `packages/workflow/tool-workflow/tests/tool-workflow.spec.ts` pins the recorded payload of a completed member. `packages/session/session-format-v0-to-v1/tests/` exercises the released payload validator that admits the three optional members. Both focused runs pass.

<a id="dev-note"></a>
## Dev Note

None.
