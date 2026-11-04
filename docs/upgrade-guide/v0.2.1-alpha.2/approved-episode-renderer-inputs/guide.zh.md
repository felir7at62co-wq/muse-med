---
kind: upgrade-guide
description: "已审核整集渲染器接收输入哈希，并将结果写到私有候选路径。"
---

# 已审核整集渲染器的输入

[English](guide.md) | 中文

## 变更

内置 Desktop 渲染器无需更改配置。自定义 `approvedEpisodeRenderer` 提供方在 `ApprovedEpisodeRenderer.render` 中接收 `inputHashes` 字段。Host 通过 `outputPath` 指定私有候选路径，并发布通过核验的结果。渲染器不再直接写入公开导出路径。

## 迁移

1. 调整 `ApprovedEpisodeRenderer.render` 的自定义调用方，传入项目配置、时间线、SRT、混音配置和可选背景音乐的 SHA-256 哈希。每个镜头已带有审核通过的哈希。
2. 在自定义提供方中，先按哈希校验私有副本，再从这些副本渲染，只将候选成片写入 `outputPath`。编码时响应取消信号。
3. 确认一次交付发布一个 MP4 和一份回执。如果 Host 在成片发布后、保存回执前停止，保持选中同一项目并重启 Host，确认现有 MP4 补上回执。
