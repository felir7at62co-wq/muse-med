---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-10-31-working-context-target

English | [中文](2026-10-31-working-context-target.zh.md)

## Summary

Adds optional workingTokenLimit and workingContextTokens to request/context for the compaction target and calibrated prepared-request estimate.

## Table of Contents

- [Declaration](#declaration)
- [Compatibility](#compatibility)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="declaration"></a>
## Declaration

```yaml persistence-change
schemaVersion: 1
id: 2026-10-31-working-context-target
baseline: false
changes:
  - root: "event:request/context"
    previous: "2026-09-11-initial"
    after: "e6880c6e32739d438c181803047edba233b56f4392753f40217b96b2c1595fe9"
    decision: same-version
```

<a id="compatibility"></a>
## Compatibility

Existing Session generations remain valid because both fields are optional. Missing values retain legacy model-window display and clear prior recorded values. Context-pressure state version 6 discards older version-5 caches and refolds the unchanged durable log. No canonical log or migration generation is replaced.

<a id="verification"></a>
## Verification

72 focused token-pressure, context-meter and request-reconstruction tests passed, covering paired estimates, legacy absence, stale cache refolding, target removal, route switching and prepared-request metadata clearing.

<a id="dev-note"></a>
## Dev Note

None.
