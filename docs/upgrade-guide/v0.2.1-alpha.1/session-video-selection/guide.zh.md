---
kind: upgrade-guide
description: "明确选择过视频模型的会话需要使用认识新选择事件的构建读取。"
---

# 会话视频模型选择

[English](guide.md) | 中文

## 变更

Muse 将配置的初始值或用户明确选择的视频模型和分辨率记录为必读的 `jubian/video-selection` 会话事件。不认识该事件的旧构建拒绝读取这些日志。没有该事件的已有会话仍可读取。该选择独立于对话模型和剧变项目默认值；变化的模型上下文追加到会话中。

## 迁移

1. 打开选择过视频模型的会话时，使用支持该事件的构建。不要删除事件来让旧构建读取。
2. 启用 `sessionVideoSelection` 的部署中，可选 `defaultVideoModel` 在核对实时目录后为未保存选择的会话初始化默认值；Muse 使用 Seedance 2.5、480p。未配置默认值时，生成前在聊天框选择，或回答 `jubian_video_model`。读取项目不会替用户选择模型。
3. 切换后为新提交重新准备预览。已记录的操作继续使用原 key 和预览对账。确认恢复会话后模型与分辨率仍为原选择。

[持久化确认记录](../../../persistence-changes/2026-10-17-session-video-selection.zh.md)说明兼容性分类。
