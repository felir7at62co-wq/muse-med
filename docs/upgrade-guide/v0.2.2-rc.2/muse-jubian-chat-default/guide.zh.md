---
kind: upgrade-guide
description: "Muse Desktop 确认剧变 DeepSeek V4 Flash 可用后，为每个配置应用一次默认模型切换。"
---

# Muse Desktop 默认对话模型使用剧变

[English](guide.md) | 中文

## 变更

Muse Desktop 以前保留仍可用的已保存默认值，并根据账号目录初始化新配置。升级后，登录并确认目录提供 `jubian/deepseek-v4-flash` 时，桌面配置会切换默认值一次。之后新建的会话默认使用 **Muse · 剧变 → DeepSeek V4 Flash**。打开已保存模型的会话时，Muse 读取该会话自己的选择。

如果账号目录暂时没有这款模型，Muse 先按现有默认选择规则继续工作，等目录刷新并返回这款模型后再切换。

## 迁移

1. 更新 Muse Desktop，打开**设置 → MUSE 账号**刷新共享模型目录。若出现登录提示，先登录。
2. 新建会话，在对话模型菜单里确认 **Muse · 剧变** 下的 **DeepSeek V4 Flash** 已选中。如果该组没有这款模型，请让网关管理员检查账号目录里的 `jubian/deepseek-v4-flash`，然后刷新目录。
3. 切换完成后，如果你希望以后新开的会话默认使用其他模型，可在对话模型菜单里重新选择。
