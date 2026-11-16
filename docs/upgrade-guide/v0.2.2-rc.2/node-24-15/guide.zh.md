---
kind: upgrade-guide
description: 源码安装和 CLI 要求 Node.js 24.x 中的 24.15 或更新版本，或 Node.js 26 及更新版本。
---

# Node.js 24.15 运行时下限

[English](guide.md) | 中文

## 变更

根工作区和 CLI 接受 `^24.15.0 || >=26.0.0`，取代 `>=24.9.0`。插件仓库解析使用 hosted-git-info 10.1.1，其支持范围排除早期 Node 24 和 Node 25。打包的 Muse 应用使用内嵌运行时，不要求更新系统 Node。

## 迁移

1. 从源码安装或更新 CLI 前，选择 Node.js 24.x 中的 24.15 或更新版本，或 Node.js 26 及更新版本。
2. 运行 `node --version`，确认版本符合 `package.json` 中的 `engines.node`。
3. 运行 `pnpm install --frozen-lockfile` 和 `pnpm run build`。自定义 CI 工作流也须使用相同支持范围；仓库通过 Node.js 24.15 检查最低版本。
