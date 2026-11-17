---
kind: upgrade-guide
description: "未指定模型的剧变转高清改用 MediaKit 而非 SeedVR2，jubian-api 的转高清模型常量和构造器默认值随之替换。"
---

# 剧变转高清默认使用 MediaKit

[English](guide.md) | 中文

## 变更

`jubian_video` 的 `method: upscale` 未传 `model_id` 时，此前提交 SeedVR2（`RUNNING_HUB` 上的 `2074071626416742401`）。现在从实时 taskType 20 目录按请求的分辨率（默认 1080p）解析 MediaKit（`AI_MEDIA_KIT` 上的 `AI MediaKit`）。只有 `model_id` 指名 SeedVR2 时才使用它。目录中没有 MediaKit 时，默认请求直接失败，不退回 SeedVR2。

MediaKit 的定价单位是 `元/分钟(1系数)`。预算预留以该价格乘以所选规格的 `height` 值（1080p 为 4，720p 为 2），再乘以源片开始计费的每一分钟，因此 13.5 秒的 1080p 片段预留 1.50 CNY，而 SeedVR2 预留 1.00 CNY。

`@deepseek-ai/dsh-jubian-api` 不再导出 `VIDEO_UPSCALE_MODEL`；`MEDIAKIT_UPSCALE_MODEL` 给出 MediaKit 的 `modelId` 与 `platformId`。`buildVideoUpscaleRequest()` 必须传入 `model` 参数。`VideoSubtask` 新增 `upscale_model_id`；经过 SeedVR2 以外任何模型处理后，低于目标的来源行由 `needsUpscale()` 返回 `null`。

## 迁移

1. 要继续使用 SeedVR2，向 `jubian_video` `upscale` 传 `model_id: "2074071626416742401"` 与 `platform_id: "RUNNING_HUB"`，或在请求转高清的提示词和技能中指名它。
2. 把 `VIDEO_UPSCALE_MODEL` 的导入换成 `MEDIAKIT_UPSCALE_MODEL`，或换成上面的 SeedVR2 标识。用 `resolvePostProcessModel(catalogue, { modelId, platformId, resolution })` 解析选择字段，再把结果传给 `buildVideoUpscaleRequest(input, model)`。
3. `needsUpscale()` 的调用方传入 `readSubtaskPage()` 返回的行，或在 `resolution` 与 `upscaled` 之外同时提供 `model_id` 和 `upscale_model_id`。
4. 用不带 `model_id` 的 `jubian_video` `method: upscale` 确认：账本记录显示 `quote_standard_id: 27`，提交的请求体带 `modelId: "AI MediaKit"`。
