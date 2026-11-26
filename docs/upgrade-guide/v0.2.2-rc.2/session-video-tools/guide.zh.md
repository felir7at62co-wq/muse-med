---
kind: upgrade-guide
description: 自定义会话视频与 Chat 组合需要工具、导航和会话服务，视频工具失败新增结构化身份。
---

# 会话视频工作区组合

[English](guide.md) | 中文

## 变更

会话视频插件需要 `tools`，并注册 `muse_video`，用于清单、版本绑定的制作元数据和所选区间审阅。创作镜头区间是可选字段，旧视频没有绑定也可继续播放。

视频界面使用原生右侧 Sidebar 工作区，取代原来的文档流内历史播放器。自定义客户端必须提供其导航、资源、Session 与输入框服务。建议链接可携带有界的 `suggestion`，为相同来源、版本和所选区间准备未发送的修改请求。Chat 还需要 `conversation`，才能通过所属输入框报告应用资源导航失败。Muse 内置配置已提供这些服务。

`muse_video` 中原本仅含消息的失败，现在在错误工具结果中带有 `error.info.name` 和 `error.info.code`。缺少 Agent 上下文使用 `ToolContextUnavailableError`（`TOOL_CONTEXT_UNAVAILABLE`）；额外的参数检查使用 `ToolArgsError`（`INVALID_ARGS`）；视频领域失败使用 `SessionVideoError`。原本依赖消息文本区分失败的消费者须改用这些身份。已有错误码保留原名。

## 迁移

1. 对于 `session-video`，在同一 Agent 作用域内挂载工具注册表及其系统提示依赖。绑定和审阅上限见[媒体服务参考](../../../../packages/drama/session-video/README.zh.md)。
2. 对于 `ui-session-video`，保留规范条目 id，并提供其[Client 入口](../../../../packages/client/ui-session-video/src/client/index.ts)声明的服务。媒体与 Client 条目按[视频工作区组合说明](../../../../packages/client/ui-session-video/README.zh.md#use-this-package)挂载。
3. 对于 `ui-chat`，在已有会话组装服务之外，挂载提供 `conversation` 的 `ui-conversation` 插件。详见 [Chat 参考](../../../../packages/client/ui-chat/README.zh.md)。
4. 对于处理 `muse_video` 失败的消费者，按 `error.info.name` 和 `error.info.code` 分流，替代解析消息文本。遵循[工具失败恢复说明](../../../../packages/drama/session-video/README.zh.md#tool-failures)。
5. 确认 Client 条目启用时没有缺失服务警告，从 Session 顶栏打开视频工作区，并通过已有输入框提交所选范围审阅。将一条建议带入草稿，确认原有文字和精确视频引用仍然保留，并且没有发送。确认失败的工具调用保留结构化身份。

已有 Session 文件代际保持不变，私有来源检查点自动重建。
