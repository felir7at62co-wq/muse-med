---
kind: upgrade-guide
description: "红果 8.0 引擎启动的下载任务需要使用该引擎续传。"
---

# 红果下载任务跨版本升级

[English](guide.md) | 中文

## 变更

`muse-hongguo-download` 0.2.3 使用 8.2 引擎。用 8.0 引擎发起的任务记录该引擎的标识，续传时要求标识匹配。切到 8.2 时保留原任务和文件，用 8.2 续传会返回 `task_source_changed`。

## 迁移

1. CLI profile 用 `dsh --profile hongguo jobs --json` 查看未完成的任务。Muse 用户从原会话查看任务。
2. 用原引擎完成任务，或在原 profile 保留该版本用于续传。保留任务所在工作区、已校验文件和回执。
3. 用 8.2 发起新请求。核对任务回执中的片源标识对应 8.2 引擎。
