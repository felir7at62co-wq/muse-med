---
kind: upgrade-guide
description: 可编辑草稿水印默认使用 UI 字号 7，非空时间线样式缺少水印时继承项目水印。
---

# 可编辑草稿水印选择

[English](guide.md) | 中文

## 变更

新建的仿真人和旧模式可编辑草稿，在未选择字号时使用水印 UI 字号 7，取代原来的 6。明确指定的 6、8 等字号保持不变。动画继续不添加水印。

非空 `timeline.delivery.draft_style` 缺少 `watermark` 时，现在继承项目的 `project_bible.delivery.draft_style.watermark`。例如项目水印为 8、时间线样式只含字幕时，现在选用水印 8。正文字段仍按原有快照选择及产品强制策略处理。显式整节 `draft_style: {}` 重置全部草稿样式；`watermark: {}` 只将水印重置为新默认。

Windows 原生回读新增 `verification.watermark_font_size`，记录请求／保存的 UI 字号及 matched、mismatch 或 unverified 状态。实际字号缺失、非有限或不一致时，保留候选并添加审阅提示。原有源文件、内容和时间检查继续生效。保存文件的验证不代表编辑器实际外观通过。

## 迁移

1. 保留现有草稿、时间线文件和源媒体；无需自动改写，也不会自动执行改写。
2. 同时检查只含字幕的时间线样式与项目水印节。要保留 UI 字号 6，在选定草稿样式节中明确写入 `"watermark": {"font_size_ui": 6}`。使用 `"watermark": {}` 选择默认 7；仅在需要重置整节时使用 `"draft_style": {}`。
3. 用户要求新候选时，选择唯一 `name_prefix`。读取保存草稿和 `muse-review.json`；Windows 原生输出需查看水印字号状态与提示，不把字号提示当成保存失败。确认外观前在剪映中实际预览。
