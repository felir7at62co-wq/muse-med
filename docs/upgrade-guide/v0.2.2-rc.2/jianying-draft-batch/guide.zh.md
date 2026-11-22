---
kind: upgrade-guide
description: "jianying_draft 不再必填 request_file 与 drafts_dir，并新增按 episodes 调用的批量形式。"
---

# `jianying_draft` 新增批量形式

[English](guide.md) | 中文

## 变更

`jianying_draft` 工具 schema 此前必填 `request_file` 和 `drafts_dir`。现在两者都可省略：`drafts_dir` 默认取 `drama_draft_dir` 保存的根目录，一次调用要么给 `request_file`（单集，与以前相同），要么给 `source`、`project` 和 `episodes`（批量形式），不能同时给出。批量形式读取 `episode_subtitles` 写出的第 2 版时钟回执，返回 `created`、`existing`、`refused`、`needs_review`、`music_missing` 和 `not_started`，而不是单集结果。请求文件新增可选的 `ending` 和 `watermark` 布尔值；`false` 去掉对应元素。

校验该工具 schema、回放已记录调用或同时传两种形式的调用方受影响。

## 迁移

1. 已有的单集调用保持不变，仍返回生成器结果。不带 `drafts_dir` 的调用现在需要已保存的草稿根目录，用 `drama_draft_dir` 设置。
2. 需要多个本机集时，先运行 `episode_subtitles` 直到报告 `ready`，再以 `source: "local"`、`project` 和 `episodes` 调用 `jianying_draft`。
3. 重复一次批量调用确认：未变化的集返回 `existing`，镜头变化的集返回 `subtitles_stale` 和 `changed_shots`。
