---
kind: upgrade-guide
description: Muse 限制新会话可选预设，并在镜头包中返回明确的素材身份映射。
---

# Muse 预设与镜头包选源

[English](guide.md) | 中文

## 变更

Muse 新会话只提供短剧模式和编辑模式，其他预设定义仍支持历史恢复。`selectablePresets` 之外的已存默认值不再影响新会话。显式使用被隐藏预设创建新任务会返回 `agent-preset/not-selectable`。

镜头编译器写出 matched 第 5 版，增加 `video_tasks[].material_bindings`。出镜姓名按完整名称匹配；过期或跨人物引用返回 `material_reference_mismatch`。身份图可明确登记 `reference_scope: "identity"`；专用妆造图保留服装校验。

## 迁移

1. 新 Muse 任务使用 `short-drama` 或 `editing`。已有会话无需迁移日志。
2. 用 `drama_shot compile` 重新编译本地镜头包。不编辑历史 Session JSONL，也不把旧产物重标为第 5 版。
3. 从每包 `material_bindings` 的 `material_key` 和 `asset_id` 构建 selections，保留顺序；不按名称和 key 列表下标配对。
4. 专用妆造资产保持默认参考范围，只有确实是身份母版的图标为 `identity`；镜头脚本仍逐人物写明妆造。
5. 提交生成前确认重复引用每个 key 只有一条映射，换装选择了对应版本。
