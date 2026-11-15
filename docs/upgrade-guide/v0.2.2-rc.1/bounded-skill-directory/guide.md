---
kind: upgrade-guide
description: Skill catalog consumers must distinguish selected summaries from the complete permitted directory.
---

# Selected Skill catalogs

English | [中文](guide.zh.md)

## Change

Desktop creation advertises at most twelve model-invocable `muse-market` summaries. Other sources remain unchanged. An intentionally shortened `skill-catalog` message carries optional `bounded: true`; `incomplete: true` still means discovery failed. Names absent from selected summaries can remain permitted and discoverable.

The owning loader conditionally exposes metadata-only `skill_catalog` for full query and pagination. It does not grant instruction-loading or user-invocation permissions. Untrimmed catalogs preserve their previous text and admitted tool set. Custom profiles default to no source limits.

## Migration

1. Consumers of catalog `entries` must inspect `bounded`. Present selected summaries without treating omitted names as unavailable. Retain `incomplete` independently; failed discovery is not deliberate selection. See the [tool package](../../../../packages/skill/tool-skill/README.md).
2. Custom profiles can configure `catalogSourceLimits` and `catalogPageSize` on their `tool-skill` row. A limited source needs the same scoped loader's `skill_catalog` tool to be admitted. Keep its normal invocation restrictions. To inspect step availability in code, resolve the step with `tools.resolve(context)` and pass the returned set to `tools.schemas(agent, set)`; dispose the set afterwards.
3. Pass `nextCursor` unchanged with the same Session and query. A foreign, stale or invalid cursor is refused; start a new metadata query rather than changing its identity or offset. Full Skill bodies still load through `skill` with an exact permitted name.
4. Verify that a source exceeding its configured limit emits `bounded: true`, offers the metadata query tool, and can discover and load an omitted permitted Skill. A directory below its limits must keep its complete summaries and previous admitted tools. Session envelopes and previously stored generations are unchanged; the [type acknowledgement](../../../persistence-changes/2026-11-09-bounded-skill-catalog.md) records the optional source field.
