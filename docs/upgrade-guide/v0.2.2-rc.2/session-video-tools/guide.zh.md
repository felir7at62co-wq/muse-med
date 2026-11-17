---
kind: upgrade-guide
description: 自定义会话视频与 Chat 组合需要工具、导航和会话服务。
---

# 会话视频工作区组合

[English](guide.md) | 中文

## 变更

会话视频插件需要 `tools`，并注册 `muse_video`，用于清单、版本绑定的制作元数据和所选区间审阅。创作镜头区间是可选字段，旧视频没有绑定也可继续播放。

视频界面使用原生右侧 Sidebar 工作区，取代原来的文档流内历史播放器。自定义客户端必须提供其导航、资源、Session 与输入框服务。Chat 还需要 `conversation`，才能通过所属输入框报告应用资源导航失败。Muse 内置配置已提供这些服务。

## 迁移

1. 对于 `session-video`，在同一 Agent 作用域内挂载工具注册表及其系统提示依赖。绑定和审阅上限见[媒体服务参考](../../../../packages/drama/session-video/README.zh.md)。
2. 对于 `ui-session-video`，保留规范条目 id，并提供其[Client 入口](../../../../packages/client/ui-session-video/src/client/index.ts)声明的服务。媒体与 Client 条目按[视频工作区组合说明](../../../../packages/client/ui-session-video/README.zh.md#use-this-package)挂载。
3. 对于 `ui-chat`，在已有会话组装服务之外，挂载提供 `conversation` 的 `ui-conversation` 插件。详见 [Chat 参考](../../../../packages/client/ui-chat/README.zh.md)。
4. 确认 Client 条目启用时没有缺失服务警告，从 Session 顶栏打开视频工作区，并通过已有输入框提交所选范围审阅。

已有 Session 文件代际保持不变，私有来源检查点自动重建。
