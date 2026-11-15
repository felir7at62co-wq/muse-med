---
kind: upgrade-guide
description: Muse 竖屏直出字幕改用更小的默认字号和更细的描边。
---

# Muse 竖屏字幕校准

[English](guide.md) | 中文

## 变更

Muse 打包桌面版及 `creation`、`short-drama` 预设，把竖屏直出字幕默认值从 480×854 参考画布上的 48px 字号、2px 黑色描边改为 46px 字号、1.25px 描边。输出字形按交付画面高度缩放。随包朱雀字体、中心位置和可用宽度保持不变。

原有竖屏强制样式策略继续忽略已存项目或时间线的字幕样式覆盖。横屏和方形交付沿用原有样式选择。这次校准不改变剪映 UI 的字号或描边单位、字词时间、文本规范化或片尾适配行为。现有导出文件不会被改写。

## 迁移

1. 保留现有项目、时间线、字幕、Session 和导出文件，无需改写存储数据。
2. 用户要求新竖屏导出时，用更新后的 Muse 构建渲染到新输出路径。通过 `drama_render` 的 `subtitle_layout` 方法检查实际字体选择和测宽证据，再查看导出结果中的画面帧。
3. 维护独立部署组合时，检查其 `tool-episode-render` 配置中的 `defaultSubtitleVisual.font_size_px` 和 `outline_px`。随包默认值位于 `apps/desktop-host/presets/creation/agent.cordis.yml` 和 `apps/desktop-host/presets/short-drama/agent.cordis.yml`；打包桌面版通过 `MUSE_DEFAULT_SUBTITLE_VISUAL` 提供相同数值。保留明确的样式强制策略。
