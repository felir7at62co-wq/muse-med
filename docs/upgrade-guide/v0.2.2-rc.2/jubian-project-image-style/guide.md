---
kind: upgrade-guide
description: "Jubian image generation without an explicit style or leading declaration now inherits the project's saved style before a billable submission."
---

# Jubian image generation inherits the project style

English | [中文](guide.zh.md)

## Change

`jubian_video` methods `image_generate` and `image_generate_batch` used live action when neither an explicit `image_style` nor a leading style declaration selected another style. Such calls now use the saved Jubian project style. Projects with no saved style retain the previous default. If the saved style is unsupported, a new call requires a supported style before it can submit a billable request.

## Migration

1. To keep live action when a project uses another style, set `image_style: "live_action"` on the single request or the relevant batch item. Keep any leading style declaration consistent with that choice.
2. For 3D realism, use a project saved as 3D realism or set `image_style: "realistic_3d"` explicitly. Keep the full style guidance in the prompt. Inspect the result to confirm its appearance. The receipt's `image_style` reports the request selection.
3. Reconcile earlier or uncertain submissions with their original `idempotency_key`. A changed style cannot rewrite a request already recorded under that key.
