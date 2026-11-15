---
description: "通过无密钥 Loader 回放验证 ASS 字面换行、源时码保留及后续模型请求。"
kind: "reference"
---

# 字幕显示与源时码

[English](README.md) | 中文

本手工编写场景通过普通 Loader 和随包 Headless profile 加载生产 `drama_render` 工具。其 `prepare` 调用读取选定的源 SRT 和已有的源绑定识别文件，创建显示 SRT，并将经过实际校验的摘要返回到下一次模型请求。

断言检查生成显示中的字面 `\N` 和 `\n` 已替换为空格，字幕端点仍为 1.000–1.700 秒，原始 SRT、媒体、收据和字词时间字节均保持不变。只有实际后续请求包含成功工具结果时，才将这些事实写入 `workspace.expected/subtitle-ass-ms-proof.json`。私有项目位于忽略的 `.dsh` 工作区内；规范 Session 及提示词、schema 旁文件属于本场景。

外部媒体探测和音频合成使用受控夹具输入。本场景不测量字形、不编码视频、不识别语音，也不代表核听、视觉质量、FFmpeg 或 Windows 验收。episode-render 单元测试另行检查归档 EP26 的字词端点、精确 SRT 毫秒取整，以及拒绝序列化后零时长的切分。
