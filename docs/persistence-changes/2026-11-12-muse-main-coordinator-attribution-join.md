---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-11-12-muse-main-coordinator-attribution-join

English | [中文](2026-11-12-muse-main-coordinator-attribution-join.zh.md)

## Summary

Joins the reviewed native generation-notice and rc2 Muse coordinator message-attribution histories.

## Table of Contents

- [Declaration](#declaration)
- [Compatibility](#compatibility)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="declaration"></a>
## Declaration

```yaml persistence-change
schemaVersion: 2
id: 2026-11-12-muse-main-coordinator-attribution-join
baseline: false
changes:
  - root: "event:agent/inbox/spliced"
    previous: ["2026-11-12-muse-main-native-attribution-review","2026-11-12-muse-rc2-message-attribution-join"]
    after: "ccdb89d7ba379d888bb0ca854645817db837d41ae747ae0147a4fea622b1ee2a"
    decision: same-version
  - root: "event:developer/message"
    previous: ["2026-11-12-muse-main-native-attribution-review","2026-11-12-muse-rc2-message-attribution-join"]
    after: "f56413cdaaeb1bef403968875ba34d8a97b9a6780770fc2bedad5ed40f8a1e8b"
    decision: same-version
  - root: "event:session/title-llm-request"
    previous: ["2026-11-12-muse-main-native-attribution-review","2026-11-12-muse-rc2-message-attribution-join"]
    after: "67228b88c322fdbf06fdd41285d839af5f721013ebf29d505cdcb32cfb5f672a"
    decision: same-version
  - root: "event:user/message"
    previous: ["2026-11-12-muse-main-native-attribution-review","2026-11-12-muse-rc2-message-attribution-join"]
    after: "85e62d0f19735e3b9b0b37b43dfc8425d1ed23cd10d0594e5db0ca56c1f8cfd5"
    decision: same-version
```

<a id="compatibility"></a>
## Compatibility

Keep Session format 4. The [native review](2026-11-12-muse-main-native-attribution-review.md) explicitly acknowledges its retry-source union transition. This join retains that reviewed schema and adds only the qualified generation-watch attribution to the [rc2 message join](2026-11-12-muse-rc2-message-attribution-join.md). The current schemas retain both predecessors across inbox splices, developer messages, title requests and user messages. Current readers preserve predecessor forms; readers without a producer preserve text, identity and JSON source metadata. Attribution alone grants no routing, coordination, review or generation authority. Both predecessor records, their after schemas, Session headers, event envelopes, the writer version and committed format generations remain unchanged.

<a id="verification"></a>
## Verification

The native-source-admission, empty-prompt, continuation and continuation-messages suites passed all 102 tests. They cover producer-absent readback with none and zstd compression, unchanged byte prefixes after writer append, retry identity deduplication, refusal of nonempty retry controls and historical settlement without a stop reason. The complete history with this reviewed transition and its integration join passed validatePersistenceHistory in memory before any new file was written. `pnpm --silent run verify-persistence-changes --json` passed: 74 roots match 48 history records.

<a id="dev-note"></a>
## Dev Note

None.
