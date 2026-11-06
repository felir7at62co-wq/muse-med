---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-11-02-bounded-skill-catalog

English | [中文](2026-11-02-bounded-skill-catalog.zh.md)

## Summary

Adds the optional bounded marker to persisted Skill catalog source metadata. The four affected event roots retain the current Session format through a same-version acknowledgement.

## Table of Contents

- [Declaration](#declaration)
- [Compatibility](#compatibility)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="declaration"></a>
## Declaration

```yaml persistence-change
schemaVersion: 1
id: 2026-11-02-bounded-skill-catalog
baseline: false
changes:
  - root: "event:agent/inbox/spliced"
    previous: "2026-10-28-jubian-video-reuse-advisory"
    after: "4b9599858dc5a5a9d7f120e4b57ea2d0ff3171245b369dd39afa9dabdb475bf5"
    decision: same-version
  - root: "event:developer/message"
    previous: "2026-10-28-jubian-video-reuse-advisory"
    after: "86570a1d97f83ba130d5754ff29bfb9d484d52ec8ce6ea7742c0ccbd9a3455f6"
    decision: same-version
  - root: "event:session/title-llm-request"
    previous: "2026-10-28-jubian-video-reuse-advisory"
    after: "1b4648416a7646623c1af3190cfda7a0e8cdc600440becb2da3d5e314fdc413f"
    decision: same-version
  - root: "event:user/message"
    previous: "2026-10-28-jubian-video-reuse-advisory"
    after: "fcdab486414b444359406acad9066f78a3918325afa9e89f27bd2d07f18211cc"
    decision: same-version
```

<a id="compatibility"></a>
## Compatibility

Existing records remain valid without bounded and retain complete-catalog meaning. New records may set bounded: true to identify source-limited summary exposure; the marker neither grants nor denies Skill invocation. Older readers can ignore the optional marker while replaying the recorded catalog text and entries. The new reader treats an absent marker as the legacy complete catalog. Existing event kinds, required fields and the Session header remain unchanged; no migration or writer-version increase is required.

<a id="verification"></a>
## Verification

The local Vitest run of packages/skill/tool-skill/tests/tool-skill.spec.ts and packages/skill/tool-skill/tests/catalog-selection.spec.ts passed 81 tests: 61 runtime tests and 20 selection-helper tests. Two real Session replacement cases retain still-valid names from the latest durable catalog when no new direct user input exists, without reinjecting Skill bodies after compaction. The two tests in apps/desktop-host/tests/muse-market.spec.ts passed through the local Loader and AgentLoop with a scripted offline adapter. The owner-local expected event projection checks recorded catalog and invocation events; it is not a top-level recorded-session snapshot. No external model or UI acceptance was performed. The persistence classifier reported only optional-property-added at bounded in event:agent/inbox/spliced, event:developer/message, event:session/title-llm-request and event:user/message; every change had requiresVersionBump: false.

<a id="dev-note"></a>
## Dev Note

None.
