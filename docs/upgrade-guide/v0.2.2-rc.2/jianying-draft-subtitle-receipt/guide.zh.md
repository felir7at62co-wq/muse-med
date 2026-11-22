---
kind: upgrade-guide
description: "剪映草稿请求的 SRT 没有时钟回执时，除非声明 subtitle_source: manual，否则被拒绝。"
---

# 剪映草稿需要字幕时钟回执或 `subtitle_source: "manual"`

[English](guide.md) | 中文

## 变更

`jianying_draft` 的请求文件，以及其后的 `generate_draft_request.py` 与 `windows_aa_draft.py` 生成器，此前接受旁边没有 `.clock.json` 回执的 `subtitle_srt`，并跳过字幕核对。现在这样的请求会被拒绝，除非声明 `"subtitle_source": "manual"`。`subtitle_source` 的其他取值也会被拒绝。

生成字幕照常可用：仍接受第 1 版回执，新的第 2 版回执增加逐镜记录。第 2 版回执与素材或切点不再一致时，错误会写出变化的镜头，生成器的 JSON 结果带 `changed_shots`。声明人工字幕不会跳过已有的回执。

为人工制作或外部导入的 SRT 编写草稿请求的 Agent 与脚本受影响。

## 迁移

1. 由 `episode_subtitles` 或 `drama_render subtitles` 生成的字幕，把 `.clock.json` 留在 SRT 旁边，请求无需改动。
2. 人工制作或外部导入的 SRT，在请求 JSON 中加入 `"subtitle_source": "manual"`。
3. 运行请求确认：缺回执且未声明时报 `缺少时钟回执`，声明后的请求照常生成草稿。
