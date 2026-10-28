---
kind: upgrade-guide
description: "Muse 创作配乐推荐需要剧本原文及绑定视频版本的实际画面记录。"
---

# 用真实依据支持生产配乐推荐

[English](guide.md) | 中文

## 变更

Muse 创作和短剧预设开启 `requireStoryEvidence`。缺少当前剧本与画面观察依据的剧情请求不再返回生产选曲候选。通用部署仍默认 false。曲库浏览保留，返回 `selection_status: reference_only`；下载和分析方法不变。

## 迁移

1. 阅读对应剧本段落并检查当前采用的原视频。在项目 JSON 保存实际观察，包含 video、video_sha256、observations，使用真实文件摘要。视频换版须重看，不能只改摘要。
2. 添加 story.evidence 的 script 和 visual_review 两类条目，提供项目内 file 路径及真实原文 quotes。无对白时可引用动作描写，额外 transcript 不能代替剧本。
3. 重查 bgm_match，按 needs_source_evidence 或 needs_source_correction 返回的具体缺项修正路径或真实引用。evidence_matched 只确认引用与视频身份；Agent 仍须判断情节、对白含义、实际动作及所选音乐片段。
4. 保留已有认可媒体和旧记录。重选使用当前依据，不能为迁就旧曲编造原文。
