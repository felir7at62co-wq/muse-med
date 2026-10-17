---
kind: upgrade-guide
description: Muse 限制新会话可选预设，并在镜头包中返回明确的素材身份映射。
---

# Muse 预设与镜头包选源

[English](guide.md) | 中文

## 变更

Muse 新会话只提供一个短剧编导 Agent，统一写作、编辑与视频制作；历史 editing ID 解析到 short-drama，Agent 预设控制、插件管理页面和计划模式控件均隐藏。统一预设不再注册子代理、workflow 或计划模式的工具与提示词段落。其他预设定义仍支持历史恢复。`selectablePresets` 之外的已存默认值不再影响新会话。显式使用被隐藏预设创建新任务会返回 `agent-preset/not-selectable`。

Muse 新会话默认完全权限（`danger-full-access`，审批策略 `never`）。权限选择器、对应设置项与 `/permission` 命令隐藏；已有会话保留日志中的权限。

镜头编译器写出 matched 第 5 版，增加 `video_tasks[].material_bindings`。出镜姓名按完整名称匹配；过期或跨人物引用返回 `material_reference_mismatch`。身份图可明确登记 `reference_scope: "identity"`；专用妆造图保留服装校验。

## 迁移

1. 新 Muse 任务使用默认 short-drama Agent。已有会话无需迁移日志。新建任务即可默认使用完全权限，界面不再显示权限控件。
2. 已有编译器集成使用保留的编译器重建镜头包；Muse 新包直接使用原生分镜工具。不编辑历史 Session JSONL，也不把旧产物重标为第 5 版。
3. 从每包 `material_bindings` 的 `material_key` 和 `asset_id` 构建 selections，保留顺序；不按名称和 key 列表下标配对。
4. 专用妆造资产保持默认参考范围，只有确实是身份母版的图标为 `identity`；镜头脚本仍逐人物写明妆造。
5. 提交生成前确认重复引用每个 key 只有一条映射，换装选择了对应版本。
