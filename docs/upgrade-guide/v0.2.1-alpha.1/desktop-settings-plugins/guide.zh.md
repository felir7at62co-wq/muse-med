---
kind: upgrade-guide
description: "Muse 从桌面组合中移除 Codex 订阅与 Agent 笔记。"
---
# 桌面设置插件移除

[English](guide.md) | 中文

## 变更

Muse 默认不再构建、打包或加载 Codex 订阅。已有桌面配置在备份清单后移除退役的订阅 bundle 条目。产品覆盖停用 Agent 笔记设置页及对应 Host API，笔记文件与订阅凭据保留在磁盘上；Muse 账号访问与知识库工具继续提供。

## 迁移

1. 重新构建并启动 Muse 桌面实例，加载更新后的组合。
2. 使用 Muse 账号模型或另行配置的原生提供方，Codex 订阅设置入口不再提供。
3. 使用文件编辑器访问已有工程笔记，Agent 笔记设置入口不再提供。
