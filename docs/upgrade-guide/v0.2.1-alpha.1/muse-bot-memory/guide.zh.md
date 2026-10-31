---
kind: upgrade-guide
description: "Muse Desktop 移除 Hindsight 插件与工具，使用内置 Bot 记忆。"
---
# Muse Desktop 使用内置 Bot 记忆

[English](guide.md) | 中文

## 变更

Muse Desktop 不再导出 `@deepseek-ai/dsh-desktop-host/hindsight`，也不再注册 `muse-hindsight` 和 `hindsight_memory`。Muse Bot 使用内置记忆，无需另行安装服务。已有 Bot 笔记原样保留。Hindsight 连接文件、服务配置和已有记忆不会被读取、删除或自动导入。

## 迁移

1. 从自定义 `cordis.yml` 补丁中移除 `muse-hindsight` 配置项及 `@deepseek-ai/dsh-desktop-host/hindsight` 导入，从自定义工具固定列表与提示词中移除 `hindsight_memory`。
2. 使用 Muse Bot 的记忆面板或 `remember`、`recall`、`forget` 工具保存长期笔记。只存在于 Hindsight 的偏好须经确认后再加入相应 Bot 或团队记忆，不自动转换。
3. 打开新的 Bot 会话，确认已有笔记可用。内置记忆不需要 Hindsight 连接文件或服务。独立安装的 Hindsight 服务及其数据仍由所有者管理。
