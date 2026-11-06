---
kind: upgrade-guide
description: "启用字幕视觉配置后，渲染或验证通过前必须实测单行显示宽度并确认实际选中的交付字体。"
---

# 启用字幕视觉配置后必须通过显示检查

[English](guide.md) | 中文

## 变更

此前 `drama_render` 即使启用 `subtitle_visual`，也只将字形测量作为建议。现在 `render` 和 `verify` 对强制换行、普通标点、超宽、无法测量或实际选中字族未确认返回失败检查。渲染前检不通过时，在整集编码前返回 `ok: false` 与空 `output`，保留旧成片。未启用视觉配置的部署保留原行为；独立 `subtitle_layout` 仍用于诊断。

## 迁移

1. 启用 `normalizeSubtitleText`，处理普通对话标点、实际换行和字面 ASS `\N`／`\n` 换行。读取 `render_preview.subtitle.path`，将同一最终显示 SRT 用于渲染和可编辑草稿。原 SRT 与字幕时码不变，保留有意义的数字分隔符。
2. 确保配置的字体已安装且可从 `fontsDir` 读取。Muse 直出保留随包朱雀仿宋。检查 `subtitle_display_font` 与保存的 libass 日志，不以系统替代字体交付。
3. 使用实际同源字词时间解决 `subtitle_display_width`。证据不完整时保留文字和时码待复核，不缩字号、不换字族、不按字数均分时间。
4. 重新渲染，并用声称实际烧录的准确显示 SRT 验证已有 MP4。验证不会规范化该输入或改写 MP4。确认 `ok: true` 且 `subtitle_display_*` 检查通过后，另行核对同步和重新打开的可编辑草稿。
