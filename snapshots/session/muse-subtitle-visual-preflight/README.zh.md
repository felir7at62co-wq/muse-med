---
description: "通过无密钥原生工具回放验证字幕预检拒绝、交付文件保留与修正后渲染。"
kind: "reference"
---

# 字幕视觉预检

[English](README.md) | 中文

本手工编写场景通过普通 Loader 和随包 Headless profile 加载生产 `drama_render` 工具。原生执行器先使用受控的外部字体选择证据请求渲染，证据指向替代字体。实际预检在任何正文编码命令之前返回 `ok: false` 和 `subtitle_display_font`。

断言逐字节保留已有 MP4 及其有效来源记录，设备号和 inode 均不变。第二次调用使用匹配的受控字体选择证据和不同输出路径；生产渲染器发布输出及来源记录，记录中的哈希与实际写入字节一致。两次实际结果均进入后续模型请求，`workspace.expected/subtitle-preflight-proof.json` 记录经过校验的观察事实。源 SRT 始终保持不变。

[PTC 相邻场景](../muse-subtitle-visual-preflight-ptc/README.zh.md) 通过程序化工具调用执行相同断言。媒体执行、字形边界和字体选择行使用受控夹具输入，不代表真实解码、字形、编码或视觉质量证据。独立的 episode-render 测试使用固定的随包 FFmpeg、朱雀和 Noto 字体进行这些技术检查。私有项目文件位于忽略的 `.dsh` 工作区内；规范 Session 及其提示词、schema 旁文件属于本场景。
