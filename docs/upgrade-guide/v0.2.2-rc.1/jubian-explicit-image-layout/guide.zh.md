---
kind: upgrade-guide
description: "剧变生图请求关闭自动资产参考模板，历史生图请求指纹因此改变。"
---

# 显式指定剧变生图版式

[English](guide.md) | 中文

## 变更

`buildImageRequest` 发送 `modelConfig.skipAssetReferenceTemplate: true`，与工作台的显式提示词资产提交一致，保留调用方的提示词和资产类别。旧请求没有该字段，因此重放旧的 `image_generate` 键会在发送另一笔付费请求前报错 `Idempotency key belongs to a different image request`。已记录的受理或未知结果保持不变。

## 迁移

1. 保留历史幂等键与账本文件，读取原记录，并用原任务或资产 ID 调用 `jubian_video method=task` 或 `jubian_asset method=generated_image` 对账。
2. 独立授权的新生成使用新幂等键，并在提示词中明确版式。不要通过换键重试历史未知结果。
3. 核对新请求包含 `modelConfig.skipAssetReferenceTemplate: true`，资产类别与参考图保持正确，并实际看图检查版式。请求成功本身不证明图片质量。
