---
kind: upgrade-guide
description: 本地 Skill 发行包需要在 Session 数据之外单独备份其存储。
---

# 本地 Skill 发行包存储

[English](guide.md) | 中文

## 变更

显式部署 `@deepseek-ai/dsh-muse-market` 时，本地发行归档、展开资源和安装记录会存储在独立的绝对路径 `root` 中。Session 备份不包含这份由本包拥有的 version-1 存储。已有文件系统 Skill 不会被移动或启用，Desktop 默认也不挂载这个私有组件。

## 迁移

1. 在具名 `dsh` profile 中挂载组件时，选择绝对路径 `root`，并在现有 Session 数据之外备份该目录的全部内容。归档和记录文件必须一同保留，不要只复制安装账本而遗漏其引用的包。
2. 如需准备平铺 Markdown Skill，请另建只包含 `SKILL.md` 和预期资源的独立目录，注册该目录包后显式选中。在检查导出的 ZIP 之前保留原 Skill。系统不会自动打包共享父目录。
3. 确认再次导入导出的 ZIP 会返回同一 SHA-256 版本标识及 `enabled: false`。这只验证本地发行包存储，不代表已启用、已云端发行或已获准执行。详见[包 README](../../../../packages/host/muse-market/README.zh.md)。
