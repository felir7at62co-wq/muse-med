---
kind: upgrade-guide
description: Generated-image reads expose task failures independently of image availability.
---

# 生图任务回读

[English](guide.md) | 中文

## 变更

`jubian_asset generated_image` 在接口提供时，以 `generation` 保留供应商任务与结果 ID。生成中、失败及未知任务返回 `image: null` 和分类后的失败信息，不再将缺少 URL 误报为信封错误。成功任务仍返回 `image.url` 和 `image.material_id`。仅含 URL 的旧回复保留原字段。供应商消息不会直接进入模型输入。

KU_AI 在付费提交前拒绝超过五张的参考图。批量生成会检查完全部项目才开始提交。报告失败的已受理任务仍是账本中已受理、已计费的写入；该失败不授权重投结果未知的付费请求。

## 迁移

1. 读取 URL 或材质 ID 前先检查 `image`。图片为空时，用 `generation.status`、`task_id`、`result_id`、`error_code` 和 `max_reference_images` 区分等待中的任务与终止失败。
2. 生成中或未知结果继续读取原任务。保留失败任务回执，修正已确认的原因后再准备新修订。供应商拒绝的内容不要原样重投。
3. KU_AI 参考图数组最多五张，提交前检查完整批次。保留原资产，并在使用合并站位参考图前实际看图审核。
