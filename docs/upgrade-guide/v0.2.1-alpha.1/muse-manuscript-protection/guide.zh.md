---
kind: upgrade-guide
description: Muse 归档内置剧本写作技能，并将返稿保护改为差异提示。
---

# Muse 剧本指导

[English](guide.md) | 中文

## 变更

Muse 在系统提示词中提供简短分场格式与返稿说明。内置编辑、改编、精修、分集、审稿与剧本格式技能入口已归档。默认写作入口不再挂载 `screenplay_project` 或可选来源审校的保存提醒。`manuscript_revision` 返回差异，不拒绝写入、导出或交付；已有本地返稿记录仍可读取。

## 迁移

1. 移除要求加载已归档写作技能的自定义指令，直接说明任务与期望格式。
2. 需要对照时，用 `manuscript_revision` 传入真实上一稿与返稿。缺少上一稿时，以最新稿为准并说明无法识别历史修改。
3. Word 交付使用 `office-docx` 和 `screenplay_export_docx`。转写、媒体、计费及视频制作能力保留各自的工具要求。
