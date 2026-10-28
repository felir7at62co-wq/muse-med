---
kind: upgrade-guide
description: Muse 移除 manuscript_work 工具及其任务绑定。
---

# Muse 移除文稿任务绑定

[English](guide.md) | 中文

## 变更

Muse 不再提供 `manuscript_work`，包括 `bind`、场景读取和检查动作。已有会话历史与 `.muse/manuscript-work/` 记录会保留，但不再用于选稿、确定来源优先级或生成采用稿版本提示。`manuscript_revision` 对照工具与普通文件工具仍可使用。

## 迁移

1. 移除调用 `manuscript_work` 的自定义指令或集成。使用普通文件工具读取相关来源和稿件，需要对照返稿时使用 `manuscript_revision`。
2. 如果集成依赖工具列表，启动新会话并检查可用工具。旧会话历史和文稿工作记录不需要手工迁移。
3. 从自定义 `manuscriptRevisions` 设置中移除 `repeatMinCharacters` 和 `actionRepeatMinCharacters`。这两个限额属于已删除的工作稿工具，其他对照和视频证据限额仍可使用。
