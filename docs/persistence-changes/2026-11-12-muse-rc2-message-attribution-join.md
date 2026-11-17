---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-11-12-muse-rc2-message-attribution-join

English | [中文](2026-11-12-muse-rc2-message-attribution-join.zh.md)

## Summary

Joins the retry-control and Muse Session-coordination message-attribution histories using the current merged declarations.

## Table of Contents

- [Declaration](#declaration)
- [Compatibility](#compatibility)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="declaration"></a>
## Declaration

```yaml persistence-change
schemaVersion: 2
id: 2026-11-12-muse-rc2-message-attribution-join
baseline: false
changes:
  - root: "event:agent/inbox/spliced"
    previous: ["2026-11-12-muse-rc2-coordination-attribution-review","2026-11-12-muse-rc2-retry-attribution-review"]
    after: "20aa4dc56feb4c842f717fbb80f4dd6e62add01b34e82dc099e79f73511c54d0"
    decision: same-version
  - root: "event:developer/message"
    previous: ["2026-11-12-muse-rc2-coordination-attribution-review","2026-11-12-muse-rc2-retry-attribution-review"]
    after: "50d2dd6a64f0f38a80d30e7e9c1604ad2b7e7b7714affe74d4e01334d7e2ca77"
    decision: same-version
  - root: "event:session/title-llm-request"
    previous: ["2026-11-12-muse-rc2-coordination-attribution-review","2026-11-12-muse-rc2-retry-attribution-review"]
    after: "5d25d2c02fdde40c58d77c42c5207fb6f60f079020535647c63c039d32794cc8"
    decision: same-version
  - root: "event:user/message"
    previous: ["2026-11-12-muse-rc2-coordination-attribution-review","2026-11-12-muse-rc2-retry-attribution-review"]
    after: "775923a37d6fa613ba733d996523b819af4cb2fbb7529455dee6000841366d00"
    decision: same-version
```

<a id="compatibility"></a>
## Compatibility

The [retry-control review](2026-11-12-muse-rc2-retry-attribution-review.md) and [coordination review](2026-11-12-muse-rc2-coordination-attribution-review.md) acknowledge each branch's union differences. This join records their identical current schemas. The four existing event roots retain every declaration from both predecessors. The current source accepts retry control metadata and muse-coordination relays and receipts on existing UserMessage content, including inbox, developer-message and title-request references. These additions do not introduce a required event discriminator or change Session headers, envelopes, generation names or the writer version. Earlier readers retain extensible message attribution and ordinary content; they may present an unfamiliar attribution generically. Current readers continue to read the predecessors without interpreting attribution as new user authorization. The join classifier checks the generated after schemas against each retained predecessor; the original records and schema snapshots remain unchanged.

<a id="verification"></a>
## Verification

The Session coordinator, external-activation and parked-wait suites passed 49 tests; continuation-message attribution and full-result preservation passed 16 tests. Two keyless retained-input owners, model-switch-compaction and deepseek-messages-system-prompt, passed after updating only current-writer oracles, and their canonical input hashes remained unchanged. The persistence history and historical-format owner checks validate this join separately.

<a id="dev-note"></a>
## Dev Note

None.
