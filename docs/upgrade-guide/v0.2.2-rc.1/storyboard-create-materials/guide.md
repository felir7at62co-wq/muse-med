---
kind: upgrade-guide
description: "Storyboard creation rejects supplied material bindings until official project selection verifies them."
---

# Create storyboards before selecting materials

English | [中文](guide.zh.md)

## Change

`jubian_storyboard` methods `create` and `create_batch` reject nonempty or malformed `storyboardMaterialList` and `modelConfig.materialList` fields before sending any creation request. This includes JSON-encoded lists, `body_path` files and a later invalid batch item. Previously these fields could write unverified names, identities and URLs into a new card. Omitted fields, null and empty arrays remain accepted; creation still forces `isGenerate=0`.

Explicit `select_assets` now refreshes existing `assetName` and `materialName` aliases from the selected official row while preserving unrelated provider fields. Existing cards are not changed automatically.

## Migration

1. In each new storyboard body or `body_path` JSON file, omit both material lists or set them to `[]`. Keep the intended prompt and model settings; do not copy an existing card ID or its material bindings.
2. Call `create` or `create_batch`, read back each returned storyboard ID, then call `select_assets` with the ordered prompt keys and confirmed parent asset IDs from the same project. Bind uploaded audio through `audio_preview` and `audio_apply`.
3. Read back the saved card and verify identity, URL, names and order before `prepare_video`. Creation and selection do not authorize video generation; existing authorization and submission checks still apply.
4. If creation returns `UNVERIFIED_STORYBOARD_MATERIALS`, correct the body before retrying. No creation POST was sent for that single call or batch. For an earlier ambiguous request, reconcile its original idempotency key instead of creating another card.
