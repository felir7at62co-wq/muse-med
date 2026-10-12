---
kind: upgrade-guide
description: Muse limits new preset selection and adds explicit material identities to compiled shot packages.
---

# Muse preset and shot-package selection

English | [中文](guide.zh.md)

## Change

Muse offers short-drama and editing for new tasks. Other preset definitions remain available for historical recovery. Saved defaults outside `selectablePresets` no longer affect new tasks. Explicit new-task requests for excluded presets fail with `agent-preset/not-selectable`.

The shot compiler writes matched output version 5 with `video_tasks[].material_bindings`. On-screen names resolve exactly; stale or cross-person references fail with `material_reference_mismatch`. Character portraits may explicitly declare `reference_scope: "identity"`; appearance references retain costume checks.

## Migration

1. Use `short-drama` or `editing` for new Muse tasks. Existing sessions require no log migration.
2. Recompile local shot packages with `drama_shot compile`. Do not edit historical Session JSONL or relabel old output as version 5.
3. Use each package's `material_bindings` rows to build selections from `material_key` and `asset_id`; preserve order. Do not zip name and key lists.
4. Keep appearance-specific assets at the default scope. Mark only genuine identity portraits as `identity`, and retain per-character appearance details in the shot script.
5. Confirm repeated references produce one binding per key and changed costumes select the intended version before submitting any generation.
