---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-11-14-market-preset-portrait

English | [中文](2026-11-14-market-preset-portrait.zh.md)

## Summary

Preserves the optional presetPortrait asset key in the manifest recorded by a market Session binding.

## Table of Contents

- [Declaration](#declaration)
- [Compatibility](#compatibility)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="declaration"></a>
## Declaration

```yaml persistence-change
schemaVersion: 1
id: 2026-11-14-market-preset-portrait
baseline: false
changes:
  - root: "event:muse-market/bound"
    previous: "2026-11-09-market-session-binding"
    after: "40e3ad89ce197a959664a6b2bf0d3de17f76d285b1187e0a778474b856f24552"
    decision: same-version
```

<a id="compatibility"></a>
## Compatibility

Existing bindings without the key keep their original meaning. Current and preceding binding projections preserve the optional presentation value without changing the recorded archive SHA, Skill path, invocation settings or release selection. The preceding cloud parser refuses portrait-bearing metadata instead of installing another release; its manifest codec omits the field, so strict local archive comparison can refuse the resulting mismatch. This change neither rewrites committed Session generations nor changes the Session header or envelope.

Author metadata accepts the same optional field. Preparing an upload for a package without a portrait creates a separate immutable archive; existing archives, bound Sessions and activation defaults retain their original selections. Moving the field to the shared metadata interface does not change its stored manifest representation.

<a id="verification"></a>
## Verification

The cloud-values, cloud-transport and package suites passed 70 tests, covering published portrait metadata, invalid asset keys, unknown cloud fields and exact archive round trips. The binding-projection suite passed four tests covering forks, cold restoration and refusal of inconsistent bindings. An executed current-versus-preceding reader comparison retained a portrait-bearing binding in both projections, confirmed current cloud admission and preceding cloud refusal, and confirmed the preceding codec omits the optional field.

The local service and package suites passed 37 tests, covering author metadata retention, immutable upload preparation, resource-byte preservation, repeated requests, unchanged defaults, invalid keys and modified-source refusal. The focused generated Remote test passed for the upload-preparation request and returned portrait metadata.

<a id="dev-note"></a>
## Dev Note

None.
