---
kind: upgrade-guide
description: 自定义会话视频组合需要工具注册表，以支持绑定和限定审阅。
---

# 会话视频工具

[English](guide.md) | 中文

## 变更

会话视频插件需要 `tools`，并注册 `muse_video`，用于清单、版本绑定的制作元数据和所选区间审阅。Muse 内置配置已提供工具注册表。创作镜头区间是可选字段，旧视频没有绑定也可继续播放。

## 迁移

挂载 `session-video` 的自定义组合也必须挂载工具注册表及其系统提示依赖。注册保持在同一 Agent 作用域。已有 Session 文件代际保持不变，私有来源检查点自动重建。绑定和审阅上限见[包参考](../../../../packages/drama/session-video/README.zh.md)。
