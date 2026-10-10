---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-10-10-screenplay-self-check-read

English | [中文](2026-10-10-screenplay-self-check-read.zh.md)

## Summary

Adds an attribution-only screenplay-project-read source for canonical self-check rereads forwarded into subsequent model requests.

## Table of Contents

- [Declaration](#declaration)
- [Compatibility](#compatibility)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="declaration"></a>
## Declaration

```yaml persistence-change
schemaVersion: 1
id: 2026-10-10-screenplay-self-check-read
baseline: false
changes:
  - root: "event:agent/inbox/spliced"
    previous: "2026-10-08-output-continuation"
    after: "43c9631e85711dc95bc3890c95c52354323a0a8436896702132bc3b486e19938"
    decision: same-version
  - root: "event:developer/message"
    previous: "2026-10-08-output-continuation"
    after: "6bf8a9fa142947d06dee146cf90c146adc26650e3b617dbaf73b2fe793d8b7c8"
    decision: same-version
  - root: "event:session/title-llm-request"
    previous: "2026-10-08-output-continuation"
    after: "decd24e81bfba1a30dacbb0985809f6c08df3ed9fa0713aad0c2df54c28f9bb8"
    decision: same-version
  - root: "event:user/message"
    previous: "2026-10-08-output-continuation"
    after: "397bd8bdd7463f4f0eb2d16e80903cae955732238a1839c56ca7b87e594696a3"
    decision: same-version
```

<a id="compatibility"></a>
## Compatibility

Existing Session events remain valid and retain their meaning. Readers preserve unknown user/developer source attribution, so no Session writer-version increase is required. Live read evidence is host-owned and expires on restart; an attribution label alone never authorizes self-check. The separate screenplay project artifact adds optional self-check mode, creation-step, review and withdrawal evidence fields; omitted fields keep historical independent-review semantics and original actors.

<a id="verification"></a>
## Verification

The screenplay-project focused suite passed 189 tests, including real Headless PTC steps, canonical text and image content in actual Adapter requests, unprinted rereads, same-step different root calls, failed outer programs, AbortSignal interruption, post-policy denial and value/content replacement, two-process cold resume, digest/revision rejection, historical independent replay, fork recovery and self-check withdrawal repair.

<a id="dev-note"></a>
## Dev Note

None.
