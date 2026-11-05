---
kind: upgrade-guide
description: "Muse delegated scheduling restrictions move from removed subagent tool configuration to a preset-owned creation policy."
---

# Muse delegated scheduling

English | [中文](guide.zh.md)

## Change

The updated `@deepseek-ai/dsh-tool-subagent` rejects `config.toolFilter`. Muse presets now mount `@deepseek-ai/dsh-desktop-host/delegation-policy` beside the delegation tools. Its awaited `agent/created` listener restricts `schedule_create`, `schedule_edit`, `schedule_list` and `schedule_view` in each actual live child's own tool scope before queued work starts. The restriction covers existing and later registrations, model schemas, discovery, native execution and PTC subcalls. Root conversations retain their scheduling tools. The policy also denies later registrations under the historical `schedule_delete` and `schedule_update` names.

This preserves the previous product restriction without changing child persona inheritance or automatically creating another preset. Runtime parent ownership determines a child; an old delegated Session separately restored as a live root remains a root. Session records are not rewritten.

## Migration

1. Upgrade the Desktop application and its bundled Host together. The shipped Standard, PTC, Cordis, Short-drama and historical recovery compositions already declare the new policy.
2. If you maintain a copied Muse preset, remove `toolFilter` from its spawn and fork tool configuration. Add a sibling row with `id: delegation-policy` and `name: '@deepseek-ai/dsh-desktop-host/delegation-policy'` in the delegation group. Do not remove the old filter without an equivalent child-scoped policy.
3. Keep an independent preset's tools explicit. The new policy denies scheduling even when the child's own composition registers those four tools. It grants no other tool or filesystem authority.
4. Confirm that a parent conversation can list its schedules, while an actual delegated child cannot discover or execute any of the four tools through native or PTC execution. Check the child's first request; a policy activation failure must stop creation rather than permit unrestricted execution.
