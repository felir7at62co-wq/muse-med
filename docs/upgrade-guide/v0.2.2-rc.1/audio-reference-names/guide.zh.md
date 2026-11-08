---
kind: upgrade-guide
description: "新增分镜音频引用须提供持久化名称，并在回读核验后才能报告完成。"
---

# 分镜音频引用名称

[English](guide.md) | 中文

## 变更

`jubian_storyboard audio_preview` 现在要求每项新音频引用提供非空 `fileName` 或 `materialName`。明确提供的非空 `fileName` 原样保留；否则在冻结请求前将 `materialName` 复制为 `fileName`。音频关系表保存 `fileName`，模型配置同时保留提供的 `materialName`。空标签及同一音频 key 的不一致标签会被拒绝。相同显示名不会合并不同 key、URL 或组内位置。

`audio_apply` 返回回读不符的字段。只有 `status=applied` 且 `verified_readback=true` 才确认绑定完成。PUT 被受理不代表完成，绑定核验也不能证明生成声音的试听质量。

## 迁移

1. 更新音频预览调用方，为每项引用提供已核对的非空 `fileName` 或 `materialName`。保留原 key、URL、组内顺序及精确的资产、角色和声线时期关联。
2. 将返回的 `preview_path`、指纹及原 key 用于 `audio_apply`。回读不符或失败后，沿用同一预览及原 key 对账，不自动再次发 PUT 或换 key。
3. 保留现有预览文件。已认领旧预览继续按原快照执行 GET-only 对账，包括缺少名称的预览；旧快照一致不代表已经修复名称。未认领旧预览若不符合当前名称或请求哈希校验，须先创建并审查新的预览，再应用。
4. 确认真正保存的关系表保留 `fileName`、模型配置保留请求名称，并且应用结果核验通过。生成音频须单独审听。
