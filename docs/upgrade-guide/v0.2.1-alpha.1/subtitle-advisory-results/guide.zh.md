---
kind: upgrade-guide
description: 字幕质量发现不再拒绝渲染，也不再使旧严格对齐命令失败退出。
---

# 字幕对齐采用提示结果

[English](guide.md) | 中文

## 变更

Muse 将对齐、字幕可读性和可选草稿轨道问题作为建议返回。随包 `align_subtitles.py --strict` 保留旧参数，但不再因这些质量发现失败退出。无效输入文件、不可用时间码、写入错误和现有收费操作检查仍会失败。`drama_render subtitles` 存在待核项时另写 `.draft.srt`，保留原 SRT 并记录 `.review.txt`；旧 `.blocked` 文件只作提醒。已有整理素材目录会保留，工具可能返回新的候选目录。保存草稿或 `ok: true` 不等于创作验收通过。

## 迁移

1. 读取完整对齐报告和 `drama_render` 提醒，不再用 `--strict` 退出码判断质量。选择字幕候选前查看返回的 `written` 路径。
2. 使用 `DraftGenerator.prepare_materials` 实际返回的目录，再读取 `muse-review.json` 和草稿的实际可编辑轨道。不能由保存成功推断可选字幕或 BGM 已导入。
3. 用缺少对齐或长字幕的样本确认工具返回建议和可读候选，同时保留已有原稿与字幕字节。继续处理技术错误；不新增审批要求，也不要求提醒清零。
