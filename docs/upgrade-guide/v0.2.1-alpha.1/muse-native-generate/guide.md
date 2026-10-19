---
kind: upgrade-guide
description: Jubian generate calls now prepare a native preview before paid submission instead of using the direct legacy generation path.
---

# Use the native video flow for generate

English | [中文](guide.zh.md)

## Change

Callers of `jubian_storyboard generate` no longer submit a new paid request directly from a saved card. A new call without `preview_path` requires `storyboard_id` and a bound `project_dir`; it runs the free `prepare_video` operation and returns the real preview and fingerprint. Optional `content_duration_ms` only cross-checks the saved duration under native rules. The separate 4–14-second, 9:16 and 720p restrictions do not apply.

A call with `preview_path` is a compatibility alias for `submit_video`, including its original fingerprint key, budget, task evidence, material identity and conversation-selection checks. Where conversation selection is enabled, its model and resolution are authoritative; synchronization preserves the saved ratio, prompt, materials and duration. Storyboard deletion inspection and its refusal of active generation remain in force.

An original key already recorded as `storyboard_generate` returns saved ledger facts without resubmitting or claiming fresh remote verification. It needs only `method: generate` and the original `idempotency_key`; no storyboard, duration or project arguments are required. Unknown outcomes remain unresolved until reconciled and do not authorize a new key.

## Migration

1. For a new request, call `prepare_video`, or keep `generate` and supply `storyboard_id` plus `project_dir` containing the correct `project_config.json`. When retaining `generate`, confirm `canonical_method: prepare_video`; review the actual returned preview, selected settings, materials and duration. Confirm preparation created no generation task or charge; a free conversation-model synchronization may save the existing card with `isGenerate=0`.
2. Submit the reviewed `preview_path` with its returned `idempotencyKey` (the unchanged preview fingerprint) as `idempotency_key`, through `submit_video` or `generate`. Do not substitute an arbitrary key or bypass the native checks. Confirm the returned task evidence before reporting generation as submitted.
3. Preserve original keys and receipts. For a recorded `storyboard_generate` key, call `generate` with that same key and confirm `canonical_method: legacy_generate_replay` and inspect its ledger result; it must not send another generation request. Do not treat `outcome: unknown`, a timeout or missing task evidence as permission to create a new key. See the [native video reference](../../../../packages/jubian/tool-jubian/README.md) for submission and reconciliation verdicts.
