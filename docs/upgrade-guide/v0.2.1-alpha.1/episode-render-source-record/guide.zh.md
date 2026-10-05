---
kind: upgrade-guide
description: 分集渲染验证使用明确的来源记录旁文件及检查名。
---

# 分集渲染来源记录

[English](guide.md) | 中文

## 变更

分集渲染写入 `<output>.source-record.json`。验证读取该旁文件，并返回 `output_source_record` 检查。记录保留来源哈希、输出哈希、编码器与验证结果。

## 迁移

重新渲染已有视频，生成当前旁文件后再验证。来源记录消费者应使用返回的 `written` 路径与 `output_source_record` 检查名。已有视频及旧旁文件保持原样；验证器将缺少当前旁文件报告为警告。
