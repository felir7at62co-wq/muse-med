---
kind: upgrade-guide
description: Native video preparation preserves outer prompt whitespace, making unsubmitted previews with trimmed prompts stale.
---

# Native video exact prompts

English | [中文](guide.zh.md)

## Change

Native video preparation preserves the complete saved `modelConfig.prompt`, including outer whitespace and CRLF line endings. Earlier preparation trimmed outer whitespace. A card containing that whitespace now has a different frozen payload and fingerprint, so an unsubmitted preview prepared with the trimmed text can be stale.

Recorded trimmed, compacted or images-then-audio keys remain evidence for read-only reconciliation. A matching old key prevents a new reservation or paid PUT, even when its preview file or remote task is missing. The returned `outcome` belongs to the old key and does not establish that the new exact-format request generated a video. Preview and budget files do not grant submission authorization.

## Migration

1. Retain every original preview and submission key in `video_tasks`; do not rewrite Session logs or ledger records.
2. For an unsubmitted preview with no recorded charge intent, read back the current card and call `prepare_video` again. Confirm that the new preview's `payload.modelConfig` contains the complete saved prompt, then continue only within the latest user request.
3. If a key has an accepted, unknown or pending ledger record, keep its original preview and use the original key for read-only reconciliation. When a new preview reports `original_idempotency_key`, reconcile that old key; this result sends no paid PUT and claims no new task.
4. Restore a missing original preview from its retained copy or investigate the existing receipt and remote task. A missing file or task does not authorize another key or charge. A preview-only request ends by displaying its result.
