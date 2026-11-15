---
kind: upgrade-guide
description: "启用 subtitle_visual 的渲染现在会在正文编码前拒绝不合规显示文本、未测得或超限宽度，以及未确认的请求字体。"
---

# 字幕视觉检查可能停止交付

[English](guide.md) | 中文

## 变更

启用 `subtitle_visual` 的渲染此前不强制执行排版诊断。现在，显示文本不合规、宽度未测得或超限、请求字体未获确认，都会在整集正文编码前返回失败检查。发生这类失败时，已有 MP4 及其来源记录会保留。未启用视觉目标的渲染仍保持旧版行为。是否启用目标由解析后的部署策略决定；Muse 的竖版强制策略仍然适用。

独立调用 `subtitle_layout` 仍用于诊断。启用视觉目标时，`verify` 重新测量调用方提供的确切 SRT 并写出独立排版证据，不做显示归一或拆分。它不改写视频或 SRT，也不证明视频实际烧录了哪些文字。

## 迁移

1. 保留原 SRT 和实测字词时间证据。没有 `subtitle_plan` 时，使用 `prepare` 的 `render_preview.subtitle.path` 作为最终显示候选。有已审核覆盖计划时，`render` 仍须使用原 SRT 及与其哈希绑定的 `subtitle_plan`；独立 `verify` 或可编辑草稿使用 `subtitle_overlay.resolved_srt`。
2. 使用该时间线、最终显示 SRT 和交付配置检查 `subtitle_layout`。让配置的 `fontsDir` 能提供报告中的 `requested_font`，并查看各条目的 `fontselect_trace`；不要依赖替代字体。
3. 使用预期的渲染器 `config.normalizeSubtitleText` 并复核生成的显示 SRT。需要将普通标点或 ASS 换行标记变为空格时，开启该配置并重跑 `prepare`。长句超宽时，提供完整同源 `speech_transcripts`，让 `prepare` 按实测字词起点拆分。不要编造词时或覆盖原 SRT。
4. 重新运行 `render` 并查看检查项。之后调用 `verify` 时，提供你声明已烧录的确切 SRT；通过的报告测量这项声明，不识别视频中的文字像素。参见[渲染器参考](../../../../packages/drama/tool-episode-render/README.zh.md#use-this-package)。
