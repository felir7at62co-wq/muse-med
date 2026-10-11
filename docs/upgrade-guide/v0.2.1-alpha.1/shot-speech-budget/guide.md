---
kind: upgrade-guide
description: Shot-script speech estimates use eight effective characters per second, changing new package durations.
---

# Shot-script speech budgets

English | [中文](guide.zh.md)

## Change

`drama_shot` estimates speech at eight effective characters per second instead of nine: `max(1, ceil(effective characters / 8))`. A 17-character line now needs three estimated seconds instead of two. New preview and compilation results can have longer durations and different package divisions. Explicit duration declarations and saved packages keep their existing values; historical Session data and generated videos are unchanged.

When writing short-drama shot scripts, creation and short-drama system prompts recommend 1–4-second shots and faster silent reactions. Visible multi-character scenes require verified positioning references. Shooting times belong to budgeting metadata and generation parameters, not the submitted video prompt. Source dialogue containing time expressions remains intact. The estimate does not establish the generated clip's actual timing.

## Migration

1. Run `drama_shot preview` on scripts to be newly generated, retaining the source dialogue and confirmed assets. Review semantic shot divisions against the system's production requirements.
2. Recompile affected local packages. Use each returned `prompt` for `modelConfig.prompt`, and the corresponding `submit_seconds` and `content_duration_ms` for generation settings. Reconcile any previously submitted tasks before changing a saved storyboard.
3. Read back the saved prompt and duration before preparing video. Check actual generated shot cuts and character identity; do not treat the new estimate as verification of the rendered video.
