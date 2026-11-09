---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-11-09-bounded-skill-catalog

English | [中文](2026-11-09-bounded-skill-catalog.zh.md)

## Summary

Distinguish deliberately selected Skill summaries from incomplete discovery in durable catalog messages.

## Table of Contents

- [Declaration](#declaration)
- [Compatibility](#compatibility)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="declaration"></a>
## Declaration

```yaml persistence-change
schemaVersion: 1
id: 2026-11-09-bounded-skill-catalog
baseline: false
changes:
  - root: "event:agent/inbox/spliced"
    previous: "2026-11-05-muse-dsh-source-attribution"
    after: "8e0c8e39545e06b6a40e7f420efcfcd5006f4f4c7a3b3e8b5e00717283121a17"
    decision: same-version
  - root: "event:developer/message"
    previous: "2026-11-05-muse-dsh-source-attribution"
    after: "190cc6b97d8c40f2865c8c81a7584c919610605cdb2954a5b89f39da2bd571b1"
    decision: same-version
  - root: "event:session/title-llm-request"
    previous: "2026-11-05-muse-dsh-source-attribution"
    after: "21cebcb51e989c9ff674a8b07751d45217dc58d657b3199b968dad40f2d7e7ff"
    decision: same-version
  - root: "event:user/message"
    previous: "2026-11-05-muse-dsh-source-attribution"
    after: "5cb9431bc3fbfdcedc2d9d0d12c12fb7f74dd6889f41a8be3a2386525f74ffb4"
    decision: same-version
```

<a id="compatibility"></a>
## Compatibility

Keep Session format 4. The optional bounded field is absent on older complete catalogs; incomplete retains its independent failure meaning. The source entries still contain exactly the logged summaries and the prose identifies a bounded list as selected recommendations, while the owning conditional tool exposes complete permitted metadata. Current readers accept old sources unchanged. Display-only older readers can retain their entry rendering but must not infer that omitted names are unavailable; continuing bounded model interactions requires the query-capable plugin build. Existing Session envelopes, required market release bindings and committed generations remain unchanged.

<a id="verification"></a>
## Verification

Executed 150 focused source tests across ten owners, including real AgentLoop tool admission, independent Agent scopes, concurrent preparations, invocation checks, partial discovery and unload. The normal full build passed all ten gates. Matching built Native and PTC bounded-directory scenarios and three existing market-binding compatibility scenarios passed all five selected replays. Both new TypeScript and Python SDK owners executed one test successfully without skips, retaining complete source, page, cursor and tool-result data. These checks cover the optional catalog field and its discovery behavior; packaged consumer qualification is recorded separately.

<a id="dev-note"></a>
## Dev Note

None.
