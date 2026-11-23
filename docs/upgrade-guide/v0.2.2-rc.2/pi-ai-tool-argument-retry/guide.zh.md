---
kind: upgrade-guide
description: "pi-ai 将已完成调用中无效的工具参数报告为可重试的 `INVALID_TOOL_ARGUMENTS`，将在事件中途截断的 Chat Completions 响应体报告为 `TRANSPORT`。"
---

# pi-ai 工具参数与截断流的错误码

[English](guide.md) | 中文

## 变更

此前，pi-ai 回复中已完成调用的工具参数不是有效 JSON 对象时，以 `MALFORMED_RESPONSE` 失败，默认的普通重试策略不重试此错误码。Chat Completions 响应体在某个 SSE 事件中途、尚无终止原因时结束，以 `PI_AI_ERROR` 失败。Muse 账号路由把两者都报告为 `UNKNOWN`，因此都不会重试。

现在第一种失败使用 `INVALID_TOOL_ARGUMENTS`，默认的普通重试策略会以全新请求重试；失败回复中的工具都不会运行。第二种失败使用 `TRANSPORT`，与在事件之间结束且没有终止原因的响应体相同。Muse 账号路由以固定消息保留 `INVALID_TOOL_ARGUMENTS` 和 `MALFORMED_RESPONSE`，桌面版 `muse-account` 策略对 `INVALID_TOOL_ARGUMENTS` 最多连续重试两次。升级后写入的会话日志在 `assistant/attempt`、`llm/retry` 和 `turn/end` 中记录新错误码；此前的日志保留原错误码。

自行提供 pi-ai `retryPolicy.retryableCodes` 或 `muse-account` `modelRetryPolicy.retryableCodes` 列表的读者，以及在日志或自动化中匹配这些错误码的读者受影响。

## 迁移

1. 在 pi-ai 或 `muse-account` 路由自行提供的每个 `retryableCodes` 列表中，凡是为重试无效工具参数而列出 `MALFORMED_RESPONSE` 的地方，都列出 `INVALID_TOOL_ARGUMENTS`；自行提供的列表会替换默认列表。要限制重复次数，按需添加 `consecutiveRetryLimits: { INVALID_TOOL_ARGUMENTS: 2 }`。
2. 对于此前用 `MALFORMED_RESPONSE` 匹配无效工具参数、或用 `PI_AI_ERROR` 匹配截断的 Chat Completions 流的日志查询和自动化，同时匹配 `INVALID_TOOL_ARGUMENTS` 与 `TRANSPORT`。
3. 确认迁移：出现工具参数无效的回复后，会话日志包含一条 `failure.code` 为 `INVALID_TOOL_ARGUMENTS` 的 `llm/retry` 事件，且该回复没有 `tool/call` 事件。
