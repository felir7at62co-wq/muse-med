---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-11-09-market-session-binding

English | [中文](2026-11-09-market-session-binding.zh.md)

## Summary

Log each participating Session’s immutable market Skill release set before its first request and reconstruct it through a versioned projection.

## Table of Contents

- [Declaration](#declaration)
- [Compatibility](#compatibility)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="declaration"></a>
## Declaration

```yaml persistence-change
schemaVersion: 1
id: 2026-11-09-market-session-binding
baseline: false
changes:
  - root: "event:muse-market/bound"
    previous: null
    after: "5f1e4fe6e8aa242d8c33ece014004d8082b0429eb4bee69a93c0093c30bcac8f"
    decision: same-version
```

<a id="compatibility"></a>
## Compatibility

Keep Session format 4. The additive muse-market/bound event is required on read, not ignorable: readers with the previous vocabulary refuse it rather than execute current defaults. Existing logs remain readable. The event records exact archive identity, manifest and invocation-neutral candidate facts; projection caches can be discarded and rebuilt. Already-executed logs without the event receive no market releases. Forks preserve the event prefix. The independent private publication ledger migrates explicitly from version 1 to version 2 with an exact backup; this is not a Session-format conversion. Accepted historical records and finalized schemas remain unchanged.

<a id="verification"></a>
## Verification

Executed source Native/PTC lifecycle scenarios through ordinary named profiles and six real Session logs, local migration/provider owners, actual Agent unload and persisted JSONL cold-view owners, a real SessionStore fork and cold projection reconstruction, plus current-vocabulary acceptance and predecessor-vocabulary refusal through the released V4 reader. The aggregate 11 focused owners passed 109 tests without skips. Both new TypeScript and Python SDK owners then passed against the normal built CLI without skips, preserving the required event and complete release identities. These checks establish the log and projection behavior; they do not claim a desktop GUI, cloud publication or an older installed application was exercised.

<a id="dev-note"></a>
## Dev Note

None.
