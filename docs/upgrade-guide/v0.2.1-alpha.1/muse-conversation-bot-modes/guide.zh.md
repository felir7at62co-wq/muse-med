---
kind: upgrade-guide
description: Muse 移除会话／Bot 模式切换，直接打开普通会话。
---

# 使用普通会话入口

[English](guide.md) | 中文

## 变更

Muse 直接打开普通会话，不再提供会话／Bot 模式切换或 Bot 登记设置。新工作使用 `short-drama`，不加载归档的 Bot 界面及手机入口。完整的受影响功能与 profile 备份说明见[普通会话](../muse-session-product/guide.zh.md)。

已有 Bot（包括旧版自动登记的条目）保留保存的文件。会话日志、记忆文件及默认模型不做迁移或删除。其底层会话仍可从原生历史读取，不会重新启用 Bot 归属或编排。

## 迁移

1. 使用普通会话入口。采用 Muse 内置配置的用户无需手动迁移会话数据。
2. 从原生历史打开已有底层会话。产品不再提供 Bot 登记或将会话转换为 Bot 的操作。
3. 保留源码归档与旧 Bot 数据。单独维护的归档部署须使用自己的 profile，Desktop 专用 profile 拒绝重新启用已停用 bundle。
4. 确认新建会话没有 Bot 切换入口，原有原生历史与保存的模型选择仍可读取。
