---
kind: upgrade-guide
description: "Muse 转写分别报告上传和查询超时，不再把两者归为服务不可用。"
---

# Muse 转写时限

[English](guide.md) | 中文

## 变更

转写状态请求使用较短的账号时限；正数 `wait_seconds` 也会限制正在进行的状态查询。上传除总时限外还设有无进展时限。`audio_transcribe` 返回 `upload-timeout` 或 `query-timeout` 时，同时返回 `status: "uncertain"` 和原收据。请求超时不能确定网关是否已受理。

## 迁移

1. 自动化遇到 `upload-timeout` 或 `query-timeout` 时，先用 `inspect` 和返回的收据回读任务，再决定是否补传。不要创建新的任务 ID。
2. 保留现有收据。用原收据查询时核对任务 ID 一致，并确认已完成任务发布了转写文件。
