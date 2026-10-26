---
description: "配置并诊断同一 JSON 对象成员在流式工具参数中重复时的本地停止行为，支持有界的可选响应恢复，不重放工具。"
kind: "package-reference"
---

# @deepseek-ai/dsh-argument-loop

[English](README.md) | 中文

## 概述

当一个 JSON 对象的同名成员达到显式配置的次数时，停止本次模型响应。此前已完成的工作保持不变；失败响应中的工具一律不执行，包括同一响应中位于异常调用前的完整调用。现有原始尝试记录和结构化 `TOOL_ARGUMENT_LOOP` 轮次错误说明停止原因。可选 `recoveryAttempts` 在单轮上限内重新生成尚未结算的响应，不重放已完成工具。它不修复模型推理，也不检测所有循环。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [深入阅读](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

通过 Cordis 配置项挂载插件；它不是可安装的配置组合包。

### 何时选择

需要在输出预算耗尽前，停止同一流式工具参数对象中的成员名重复时，选择本包。若需要针对已执行的相同调用发出建议，使用 [repeat-tool-reminder](../repeat-tool-reminder/README.zh.md)。普通正文、字符串值、辅助模型请求及数组中不同对象里的重复键不属于本守卫的检测目标。

### 最小配置

```yaml
- id: tool-argument-loop
  name: '@deepseek-ai/dsh-argument-loop'
  config:
    repeatedPropertyLimit: 64
    recoveryAttempts: 1
```

| 字段 | 默认值 | 含义 |
|---|---|---|
| `repeatedPropertyLimit` | 必填 | ≥ 2 的安全整数：同一对象中解码后的同名成员出现多少次时停止响应 |
| `recoveryAttempts` | `0` | 非负安全整数：单轮中遇到本地工具参数循环时，最多重新生成多少次响应 |

本包没有隐式阈值。Muse 显式选择 64：现场问题中 `page_num` 重复约 18,000 次，而同一对象里同名成员出现 64 次无法推进该普通工具调用。Muse 还显式允许每轮恢复一次响应。这是保守止损，不是普遍保证。[配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-argument-loop) 是全部可接受字段的参考。

### 停止之后

启用恢复时，守卫先关闭失败流，循环再保留原始 `assistant/attempt` 并重新生成当前请求的响应。此前已完成的工具结果继续保留在历史中，失败响应的部分调用和完整调用均不执行。恢复额度覆盖整轮，期间成功执行其他步骤也不会补充额度。取消和界面暂停会停止恢复；卸载会取消并等待尚未完成的恢复。不会修改指令、模型设置、目标修订或内容安全策略。

禁用恢复或额度耗尽时，守卫在提供方重试机制之外抛出本地 `LlmError`，即使 `retryPolicy: always` 也不能重启它。其他提供方错误（包括内容安全失败）保留原有策略。之后经人工授权重新启动前，应检查原始尝试、已完成结果、远端任务 ID、写入和费用记录；不能因为整个轮次失败，就重复此前已成功或状态不明的付费操作。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内部细节——点击展开</summary>

`llm/stream` 监听器只包装 agent loop（智能体循环）标记的请求。增量词法状态按每个嵌套对象及工具调用索引独立统计解码后的键，不保留值字符串。它遵循组装器的首次 block-end 约定，单独检查权威完整参数，不把它再次拼到分片后重复计数。有界恢复结束分片或终止异常之前会先保留原样触发分片，未正常结算的响应不能派发工具。只有守卫实际检测到且绑定当前轮次取消信号的本地失败，才可通过 `agent/request-error` 恢复；提供方自行返回相同错误码不符合条件。迭代器返回会等待上游清理完成；卸载会先等待待恢复操作结束，再移除监听器。

| 文件 | 用途 |
|---|---|
| [`src/index.ts`](src/index.ts) | 显式策略、请求选择、本地失败及流生命周期 |
| [`src/detector.ts`](src/detector.ts) | 有界增量 JSON 前缀扫描器 |
| [`tests/loader-composition.spec.ts`](tests/loader-composition.spec.ts) | 真实应用/Loader、始终重试的提供方及 Goal Round 与本地副作用计数 |

</details>

-----

<a id="further-exploration"></a>
## 深入阅读

- [LLM 子系统](../../../docs/subsystems/llm-streaming.zh.md)——流中间件及提供方边界。
- [输出续接](../../core/agent-output-continuation/README.zh.md)——正常输出上限恢复保持不变。
- [守卫分组](../README.zh.md)——相邻策略与建议型提醒。

<a id="model-experience"></a>
## Model Experience

无新增提示词或工具定义；可选恢复会重发保留的历史，并重新生成模型响应、正常消耗 token。

#### KV Cache effect

不改写请求前缀；原始失败尝试属于诊断证据，不是新注入的模型消息。

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

本守卫刻意只识别一类狭窄故障。

- 只验证已收到的 JSON 前缀直至重复键的冒号，不验证未来字节或全部参数语义；遇到格式错误或含糊前缀时停用扫描，不编造格式错误。
- 超过防御性状态预算时停止扫描而不判定循环：128 层嵌套、4,096 个保留的不同键、65,536 个保留键字符或单键 1,024 字符。不保存值。这些是扫描器容量，不是额外的模型质量阈值。
- 仍可能出现正文重复、不同键重复、跨请求循环及低于显式阈值的重复。本包不提供模型修复或付费操作自动恢复。
- 18,000 成员的合成回归模拟所报告的故障类型；它不是 EP23 原始私有日志的精确回放，也不证明所有提供方的分片相同。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文——点击展开</summary>

无。

</details>
