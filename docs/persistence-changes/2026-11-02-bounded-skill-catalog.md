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
    previous: "2026-10-17-session-video-selection"
    after: "d783e4bfec72bfad83f262d92e1d431e56f9930b93181660450bf12be0fba124"
    decision: same-version
  - root: "event:developer/message"
    previous: "2026-10-17-session-video-selection"
    after: "4240ae41f06913ba37d6491731b6f113432c99940902f8c7e2446dcfd0b00eb2"
    decision: same-version
  - root: "event:session/title-llm-request"
    previous: "2026-10-17-session-video-selection"
    after: "73fd2f6986c45fe0500def883230c05301e8bc1b2e99d77274a61dca6914b240"
    decision: same-version
  - root: "event:user/message"
    previous: "2026-10-17-session-video-selection"
    after: "1ac10cecc0b7cf1e71a4ad08b7159e0adfaefac1da281ddebd607d109f7c18e8"
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
