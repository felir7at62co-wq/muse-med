---
kind: upgrade-guide
description: Muse 桌面端移除内置 Ponytail 插件、命令及其六个技能。
---

# 桌面端移除 Ponytail

[English](guide.md) | 中文

## 变更

Muse 桌面端不再分发或自动启用 `@mengyuly/dsh-ponytail`。内置环境不再提供其编码人格、`/ponytail` 命令和六个 `ponytail*` 技能。其他社区插件与短剧技能继续保留。

## 迁移

1. 启动更新后的桌面应用。启动流程先备份活动 profile 的 `package.json`，再从 `dsh.profile.bundles` 移除已退役的包；用户自行安装的其他 bundle 保持原顺序。
2. 如果自己曾在个人 `cordis.patch.yml` 或自定义组合中添加 Ponytail 条目，请移除这些条目。迁移不会编辑这些个人条目，也不会卸载单独安装的 npm 依赖。
3. 确认 profile 可以启动，且内置插件清单不再包含 Ponytail。已有 Session 日志及此前导出的文档保持原样。
