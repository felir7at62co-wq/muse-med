---
kind: upgrade-guide
description: "Muse 剧本 Word 导出默认不再让每集另起一页。"
---

# Muse Word 各集连排

[English](guide.md) | 中文

## 变更

`screenplay_export_docx` 此前在第一集之后的每个集标题前分页。现在默认 `episode_layout: continuous`：各集依次连排，标题仍与下一段同页。新导出的 Word 空白页减少；已导出的文件不变。

`screenplay-docx` 插件选项 `episodeLayout` 与 `desktop-office` 插件选项 `docxEpisodeLayout`（`continuous` 或 `page_per_episode`）选择部署默认值，工具的可选参数 `episode_layout` 可对单次导出覆盖。其他取值会被拒绝。

## 迁移

1. 需要每集一页时，每次导出传 `episode_layout: page_per_episode`，或在部署的插件组合中为 `screenplay-docx` 条目设置 `episodeLayout: page_per_episode`（`desktop-office` 使用 `docxEpisodeLayout`）。
2. 已有交付物用新输出路径重新导出；导出器从不覆盖已有文件。
3. 打开新 DOCX 确认：只有 `page_per_episode` 时集标题才另起一页。
