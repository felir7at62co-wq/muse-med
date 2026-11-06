---
kind: upgrade-guide
description: "新分镜音频编辑须有可持久化的文件名，并拒绝空提示词标签或互相冲突的标签。"
---

# 分镜音频名称与已准备编辑

[English](guide.md) | 中文

## 变更

`jubian_storyboard audio_preview` 现在要求每个新音频引用具备非空 `fileName` 或 `materialName`。冻结预览前，工具从显示名补齐缺失或空白的文件名。模型配置保留 `materialName`，音频关系行使用 `fileName`。这避免把关系行未保存显示名误判为音频绑定丢失，同时保留对文件名、URL、key 与顺序的严格检查。

新音频编辑拒绝空提示词标签和同一 key 的冲突标签。已有卡片和预览文件不会重写。已认领的 key 继续只读对账，包括旧预期字段仍导致 `readback_mismatch` 的预览；未认领的旧预览若因新规范化而改变请求，须重新创建。

## 迁移

1. 新 `audio_references` 行提供非空 `fileName`；文件名缺失或空白时仍接受非空 `materialName`。保留正确的音频 URL、key 与顺序。
2. 将 `@[](voice-key)` 等空标签替换为预期说话人或声线名称。同一 key 的重复引用保持相同标签，并保留 key 的首次出现顺序。
3. 未认领的旧预览若因请求已改变而被拒绝，重新调用 `audio_preview`，使用新返回的 `preview_path`、指纹和匹配 key。不得修改冻结文件。已认领或结果未知的保存继续沿原 key 检查已存卡片，不得再次提交。
4. 只有 `status=applied` 且 `verified_readback=true` 才报告绑定完成。保存被接受但回读不一致或不可用时仍未验证，应检查 `mismatched_fields` 并按 `next` 处理。编辑验证通过后，重新准备视频，并单独核对成品的实际声音。
