---
kind: upgrade-guide
description: "Jubian upscaling without a named model now uses MediaKit instead of SeedVR2, and the jubian-api upscale model constant and builder default are replaced."
---

# Jubian upscaling defaults to MediaKit

English | [中文](guide.zh.md)

## Change

`jubian_video` `method: upscale` without `model_id` used to submit SeedVR2 (`2074071626416742401` on `RUNNING_HUB`). It now resolves MediaKit (`AI MediaKit` on `AI_MEDIA_KIT`) at the requested resolution, 1080p by default, from the live taskType 20 catalogue. SeedVR2 runs only when `model_id` names it. A catalogue without MediaKit fails the default request instead of falling back to SeedVR2.

MediaKit is priced in `元/分钟(1系数)`. The budget reservation multiplies that price by the selected standard's `height` value (4 for 1080p, 2 for 720p) and by every started minute of the source, so a 13.5-second clip at 1080p reserves 1.50 CNY where SeedVR2 reserved 1.00 CNY.

`@deepseek-ai/dsh-jubian-api` no longer exports `VIDEO_UPSCALE_MODEL`; `MEDIAKIT_UPSCALE_MODEL` carries MediaKit's `modelId` and `platformId`. `buildVideoUpscaleRequest()` requires its `model` argument. `VideoSubtask` adds `upscale_model_id`, and `needsUpscale()` returns `null` for a source row below the target after a pass by any model other than SeedVR2.

## Migration

1. To keep SeedVR2, pass `model_id: "2074071626416742401"` and `platform_id: "RUNNING_HUB"` to `jubian_video` `upscale`, or name it in prompts and skills that request upscaling.
2. Replace `VIDEO_UPSCALE_MODEL` imports with `MEDIAKIT_UPSCALE_MODEL`, or with the SeedVR2 identifiers above. Resolve selectors with `resolvePostProcessModel(catalogue, { modelId, platformId, resolution })` and pass the result to `buildVideoUpscaleRequest(input, model)`.
3. Callers of `needsUpscale()` pass rows from `readSubtaskPage()`, or supply `model_id` and `upscale_model_id` with `resolution` and `upscaled`.
4. Confirm with `jubian_video` `method: upscale` without `model_id`: the ledger record shows `quote_standard_id: 27` and the submitted body carries `modelId: "AI MediaKit"`.
