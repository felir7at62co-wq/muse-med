---
description: "通过无密钥 PTC 回放验证生产字幕预检与修正后渲染，同时保留已有交付。"
kind: "reference"
---

# 程序化字幕预检

[English](README.md) | 中文

本手工编写场景通过普通 Loader 和随包 Headless profile 使用共享的[字幕预检夹具](../muse-subtitle-visual-preflight/README.zh.md)。原生工具执行已关闭；Node 程序化工具调用（PTC）执行器从 `run_code` 两次调用生产 `drama_render` 工具。

第一次实际分派在正文编码之前拒绝替代字体，并保留已有 MP4 和来源记录。受控字体证据与请求字族匹配后，第二次分派发布不同路径的输出。程序可取得原始结构化工具值；所报告的失败检查和编码镜头列表进入后续模型请求。共享夹具独立校验文件与来源记录哈希，本场景保留自己的 Session、提示词、schema 旁文件和工作区证明。

受控媒体事实不代表实际字形渲染、解码、播放、核听或视觉质量。独立的 episode-render 测试使用真实随包媒体和字体；构建后的 worker 与打包消费者验收有别于本源 profile 回放。
