---
kind: upgrade-guide
description: Supermuse 通过已登录的 Muse 账号调用模型，并移除内置 Codex 订阅提供方。
---

# Supermuse 模型访问

[English](guide.md) | 中文

## 变更

Supermuse 通过已登录的 Muse 账号调用模型。应用安装包排除 Codex 订阅提供方及其子代理运行时。

## 迁移

1. 启动 Supermuse 并登录 Muse。若已保存的模型不可用，请在模型设置中选择 Muse 账号提供的模型。
2. 启动时先备份活动 profile 的 `package.json`，再从 `dsh.profile.bundles` 移除 Codex 订阅 bundle。如果曾在个人 Cordis 补丁中单独添加 Codex 条目，请先移除该条目，再启动应用此补丁的 profile。启动流程会保留单独安装的 npm 依赖及 Session 日志。
