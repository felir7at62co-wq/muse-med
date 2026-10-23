---
description: "配置并诊断同一 JSON 对象成员在流式工具参数中重复时的本地停止行为，不自动重试或重放工具。"
kind: "package-reference"
---

# @deepseek-ai/dsh-argument-loop

[English](README.md) | 中文

## 概述

当一个 JSON 对象的同名成员达到显式配置的次数时，停止本次模型响应。此前已完成的工作保持不变；失败响应中的工具一律不执行，包括同一响应中位于异常调用前的完整调用。现有原始尝试记录和结构化 `TOOL_ARGUMENT_LOOP` 轮次错误说明停止原因。本包从不自动重试、续接或重放工具。它不修复模型推理，也不检测所有循环。

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
```

| 字段 | 默认值 | 含义 |
|---|---|---|
| `repeatedPropertyLimit` | 必填 | ≥ 2 的安全整数：同一对象中解码后的同名成员出现多少次时停止响应 |

本包没有隐式阈值。Muse 显式选择 64：现场问题中 `page_num` 重复约 18,000 次，而同一对象里同名成员出现 64 次无法推进该普通工具调用。这是保守止损，不是普遍保证。[配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-argument-loop) 是全部可接受字段的参考。

### 停止之后

检查保留的 `assistant/attempt`、`turn/end` 错误、已完成工具结果及项目产物。守卫抛出本地 `LlmError`，而不是提供方的错误结束分片，因此即使提供方使用 `retryPolicy: always`，输出续接和已激活的 Goal Round 也不会重启它。之后的人工指令属于新操作：先核对现有远端任务 ID、写入和费用记录；不能因为整个轮次失败，就重复此前已成功或状态不明的付费操作。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内部细节——点击展开</summary>

`llm/stream` 监听器只包装 agent loop（智能体循环）标记的请求。增量词法状态按每个嵌套对象及工具调用索引独立统计解码后的键，不保留值字符串。它遵循组装器的首次 block-end 约定，单独检查权威完整参数，不把它再次拼到分片后重复计数。结构化异常前会先交出原样触发分片；循环保留该分片，未正常结算的响应不能派发工具。消费方拥有取消操作，迭代器返回会等待上游清理完成；插件 dispose（资源释放）移除注册，不产生游离工作。

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

无，因为本包停止本地响应，不增加模型工具、提示词或恢复请求。

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
