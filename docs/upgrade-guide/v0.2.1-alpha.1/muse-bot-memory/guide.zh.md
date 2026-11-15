---
kind: upgrade-guide
description: "Muse Desktop 移除 Hindsight 插件，保留原记忆文件且不加载替代 Bot 服务。"
---
# Muse Desktop 停用记忆服务

[English](guide.md) | 中文

## 变更

Muse Desktop 不再导出 `@deepseek-ai/dsh-desktop-host/hindsight`，也不再注册 `muse-hindsight` 和 `hindsight_memory`。内置 Bot 服务与记忆界面同样停用，产品入口为[普通会话](../muse-session-product/guide.zh.md)。已有 Bot 笔记原样保留。Hindsight 连接文件、服务配置和已有记忆不会被读取、删除或自动导入。

## 迁移

1. 从自定义 `cordis.yml` 补丁中移除 `muse-hindsight` 配置项及 `@deepseek-ai/dsh-desktop-host/hindsight` 导入，从自定义工具固定列表与提示词中移除 `hindsight_memory`。
2. 将 Bot 与 Hindsight 记忆文件及原配置一起保留，普通会话不会自动导入。需要使用时，仅将明确选择并审阅的信息复制到项目文件。
3. 打开普通会话并确认原有会话历史仍可读取。产品无需 Hindsight 后台服务。独立安装的服务及其数据仍由所有者管理。
