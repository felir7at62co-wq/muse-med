---
kind: upgrade-guide
description: "Jubian image requests opt out of automatic asset-reference templates, changing historical image request fingerprints."
---

# Explicit Jubian image layouts

English | [中文](guide.zh.md)

## Change

`buildImageRequest` sends `modelConfig.skipAssetReferenceTemplate: true`, matching the workbench's explicit-prompt asset submission. The caller's prompt and asset category are preserved. Earlier requests omitted the field. Replaying an earlier `image_generate` key therefore fails with `Idempotency key belongs to a different image request` before another paid request is sent. Recorded accepted or unknown outcomes remain unchanged.

## Migration

1. Keep historical idempotency keys and ledger files unchanged. Read the recorded outcome and use `jubian_video method=task` or `jubian_asset method=generated_image` with the recorded task or asset ID to reconcile it.
2. For an independently authorized new generation, use a new idempotency key and state the desired layout in the prompt. Do not use a new key to retry an unknown historical result.
3. Confirm that the new request contains `modelConfig.skipAssetReferenceTemplate: true`, preserves its asset category and references, and produces the requested layout on visual inspection. A successful request alone does not verify image quality.
