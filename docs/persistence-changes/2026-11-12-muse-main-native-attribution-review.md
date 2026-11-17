---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-11-12-muse-main-native-attribution-review

English | [中文](2026-11-12-muse-main-native-attribution-review.zh.md)

## Summary

Reviews the merged retry-control metadata and coordinator attribution against the native generation-notice message history.

## Table of Contents

- [Declaration](#declaration)
- [Compatibility](#compatibility)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="declaration"></a>
## Declaration

```yaml persistence-change
schemaVersion: 1
id: 2026-11-12-muse-main-native-attribution-review
baseline: false
changes:
  - root: "event:agent/inbox/spliced"
    previous: "2026-11-10-native-generation-attribution-join"
    after: "ccdb89d7ba379d888bb0ca854645817db837d41ae747ae0147a4fea622b1ee2a"
    decision: same-version
  - root: "event:developer/message"
    previous: "2026-11-10-native-generation-attribution-join"
    after: "f56413cdaaeb1bef403968875ba34d8a97b9a6780770fc2bedad5ed40f8a1e8b"
    decision: same-version
  - root: "event:session/title-llm-request"
    previous: "2026-11-10-native-generation-attribution-join"
    after: "67228b88c322fdbf06fdd41285d839af5f721013ebf29d505cdcb32cfb5f672a"
    decision: same-version
  - root: "event:user/message"
    previous: "2026-11-10-native-generation-attribution-join"
    after: "85e62d0f19735e3b9b0b37b43dfc8425d1ed23cd10d0594e5db0ca56c1f8cfd5"
    decision: same-version
```

<a id="compatibility"></a>
## Compatibility

Keep Session format 4. The current schemas retain the native predecessor forms and add browser correlation and caller metadata to the retry source union, optional subagent settlement stopReason, and Muse coordination attribution. The retry union and the transitive title-request message union receive explicit same-version review. Existing V4 native source admission preserves any nonempty producer-owned kind except the retired plugin wrapper and retains JSON metadata without installing its producer. Older readers therefore preserve the added metadata and empty retry message even when they provide no manual-retry control. Current readers preserve predecessor forms, including missing settlement stop reasons. Retry input remains subject to existing failed-Session eligibility and empty-content checks; source metadata grants no user authorization, routing, review or generation authority. The [native attribution join](2026-11-10-native-generation-attribution-join.md), its schemas and all committed format generations remain unchanged. Required durable-claim and parked-notice events retain their separate records and refusal rules.

<a id="verification"></a>
## Verification

The native-source-admission, empty-prompt, continuation and continuation-messages suites passed all 102 tests. They cover producer-absent readback with none and zstd compression, unchanged byte prefixes after writer append, retry identity deduplication, refusal of nonempty retry controls and historical settlement without a stop reason. The complete history with this reviewed transition and its integration join passed validatePersistenceHistory in memory before any new file was written. `pnpm --silent run verify-persistence-changes --json` passed: 74 roots match 48 history records.

<a id="dev-note"></a>
## Dev Note

None.
