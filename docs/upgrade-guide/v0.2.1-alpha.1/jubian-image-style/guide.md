---
kind: upgrade-guide
description: Jubian asset images preserve declared anime media and expose an explicit image style choice.
---

# Jubian image medium

English | [中文](guide.zh.md)

## Change

`jubian_video image_generate` and each `image_generate_batch.items` request accept `image_style: "anime" | "live_action"`; a top-level batch `image_style` is rejected. `ImageRequestInput.imageStyle` exposes the same choice to builder callers. Anime requests use provider `style: 1`, including 3D animation described by the full prompt; live action uses `style: 0`. Omitted choices recognize a leading positive medium declaration, optionally preceded by the exact `项目风格:` or `项目风格：` prefix; unmarked legacy prompts retain live action. Explicit choices conflicting with that declaration fail before billing. Receipts echo the resolved medium, not visual quality.

## Migration

1. Set `image_style: "anime"` for confirmed 2D/3D animation or `"live_action"` for confirmed live action, including each batch item individually. Keep the full custom style, 3D substyle and material description in `prompt`; do not substitute the selector for these words or use a top-level batch default.
2. For builder callers, set `ImageRequestInput.imageStyle`; use `resolveImageStyle` when resolving optional request intent.
3. Reconcile already-submitted keys through the original ledger and asset. A request body whose corrected medium differs cannot reuse its old key for another paid submission. Create an explicitly authorized revision only after its old outcome is known; never automatically charge again on an uncertain submission.
4. Read the saved asset and inspect the generated image before accepting its medium or quality. No existing image or casting is automatically replaced.
