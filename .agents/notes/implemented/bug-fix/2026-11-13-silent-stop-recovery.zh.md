# Agent Note: 输出续写中的静默停止恢复

Status: implemented

[English](2026-11-13-silent-stop-recovery.md) | 中文

## Problem

提供方可能以正常 `stop` 结束回答，而回答内容只有隐藏推理。agent 循环在回答没有工具调用时结束轮次，于是轮次完成，用户什么也没看到。在一个通过 OpenAI 兼容网关使用 gemini-3.1-pro 的 Muse 短剧会话里，约二十二个轮次中有七个在模型已经改完文件之后这样结束，用户先后六次索要文件。适配器只把零内容块的 `stop` 归为 `EMPTY_RESPONSE`；[此前的决定](../../archived/bug-fix/2026-07-24-empty-model-response-is-retryable.md)没有把这一归类扩大到只有推理的回答，因为重试会重复同一个请求。

## Decision

回答的流报告 `stop`，且内容既没有工具调用也没有空白以外的文字时，`agent-output-continuation` 将这个已提交的回答视为静默停止。它在 `agent/turn-stopping` 注入一条用户角色指令，沿用已有的 `output-continuation` 来源，使轮次继续。`maxSilentStopRecoveries` 限制每轮的这类请求，与 `maxContinuations` 分开计数：默认一次，零表示停用，Muse Desktop 设为两次。用户消息会恢复额度。指令说明用户没有收到任何内容，只有工具能读写文件或运行代码，最终回复只能陈述工具结果显示的实际情况。

注入的消息来源种类相同，因此恢复沿用续写的输入接纳过滤、用户输入优先，以及取消、空闲和卸载时的撤销。

## Alternatives considered

**在适配器中把只有推理的停止归为 `EMPTY_RESPONSE`** 会按重试策略的上限重发完全相同的请求，没有新的指令，失败的那次回答也不进入模型历史。适配器测试固定了当前归类。

**使用独立来源种类的并列插件** 需要声明持久化类型、确认记录和客户端处理。若改用相同来源种类，现有插件的过期输入过滤会丢弃并列插件排队的输入。

**在 `output-continuation` 来源上增加区分字段** 会改变所有带消息来源的事件的持久化摘要。前一个 assistant 回答已经区分两种触发：它以 `stop` 或 `max-tokens` 结束。

**把缺失的结束原因当作停止** 会从未报告结束原因的提供方推断意图。插件对输出上限同样不作这种推断。

## Consequences

一次静默停止每轮最多多出 `maxSilentStopRecoveries` 个请求，之后照常完成，因此持续返回空内容的提供方不会造成循环。子代理和主会话的轮次得到相同的恢复。另有 `agent/turn-stopping` 监听器处理更窄的情形时，例如 Muse 连续性审校未提交结果，先注册的监听器为该次停止注入指令；较窄策略的请求上限仍然生效。

只在文字里宣称要做而没有做的回答，或把代码当作文字输出的回答，属于可见内容，仍会结束轮次。插件不对它作判断。
