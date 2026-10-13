---
kind: upgrade-guide
description: 新生成的 Muse 剪映草稿增加可编辑片尾定格与 AI 内容标识轨。
---

# Muse 剪映草稿片尾

[English](guide.md) | 中文

## 变更

新剪映草稿在正文实际解码的最后一帧后追加两秒可编辑定格。同时创建独立、可编辑的“内容由AI生成”文字轨，在右下角全程显示纯白无描边文字，覆盖正文和片尾。此前生成的草稿没有这两条轨道。现有草稿不会被修改或替换。

## 迁移

1. 阅读[草稿输入要求](../../../../packages/drama/skills/skills/tweet-drama-draft-build/references/io-contract.md)，提供原始正文视频；同名 PNG 不能代替视频末帧。
2. 将 `timeline.body_end` 设为正文结束位置。输入已包含两秒片尾时，总时长保持不变，不再追加另一段片尾。
3. 在已配置的草稿根目录中使用新的 `name_prefix` 重新生成。确认片尾图片段从 `body_end` 开始、持续两秒，独立 AI 文字轨覆盖草稿总时长。
