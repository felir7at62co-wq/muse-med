---
kind: upgrade-guide
description: Generated-image reads expose task failures independently of image availability.
---

# Image task readback

English | [中文](guide.zh.md)

## Change

`jubian_asset generated_image` preserves provider task/result IDs in `generation` when available. Pending, failed and unknown tasks return `image: null` with classified failure information instead of a missing-URL envelope error. Successful tasks retain `image.url` and `image.material_id`. URL-only legacy responses keep their existing fields. Provider messages are not copied into model input.

KU_AI generation refuses more than five reference images before paid submission. Batch generation validates all items before submitting any. An accepted task that reports failure remains an accepted, charged write in the ledger; the failure does not authorize replaying an unknown paid outcome.

## Migration

1. Check `image` before reading its URL or material ID. For null images, use `generation.status`, `task_id`, `result_id`, `error_code` and `max_reference_images` to distinguish pending work from a terminal failure.
2. Continue reading the original task for pending or unknown outcomes. Preserve failed task receipts; correct the confirmed cause before preparing a new revision. Do not repeat content refused by the provider unchanged.
3. Limit KU_AI reference arrays to five images and validate the complete batch before submission. Preserve source assets and review any combined positioning reference before using it.
