---
description: "配置并诊断一个防护插件：智能体回复没有调用工具、且供应商报告的提示 token 远低于实际发出的请求时，丢弃这条回复，由该路由的重试策略决定是否重发。"
kind: "package-reference"
---

# @deepseek-ai/dsh-prompt-usage

[English](README.md) | 中文

## 概述

供应商报告的提示 token 同时低于工具定义和上下文的阈值时，防护会丢弃未调用工具的 `stop` 回复。主循环提交前会收到 `PROMPT_USAGE_SHORTFALL`。用量偏低可能源于请求内容缺失，也可能是供应商上报有误。是否重发由路由的重试策略决定。防护只判定列出的供应商和模型组合，且报告的提示 token 必须为正数。

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

通过 Cordis 配置项挂载插件；它不是可安装的配置组合包。需要 `llm`、`sessions` 和 `tokenMeter` 服务。

### 何时选择

当某条路由的用量报告有时与实际发送的上下文不符、未调用工具的回复可能不宜提交时，可为该路由挂载防护。Muse 列出了 `muse-cloud-yunying`/`gemini-3.1-pro`。该中转曾在已生成文本的回复中上报异常低的提示 token 以及零补全 token。防护认为这类零补全报告不可靠，会保留相应回复。

### 最小配置

```yaml
- id: prompt-usage-guard
  name: '@deepseek-ai/dsh-prompt-usage'
  config:
    routes:
      - { provider: muse-cloud-yunying, model: gemini-3.1-pro, minToolSchemaRatio: 1.0, minEstimateRatio: 0.5 }
```

| 字段 | 默认值 | 含义 |
|---|---|---|
| `routes` | 必填 | 非空的受防护路由列表；供应商与模型组合重复或出现未知键时，加载即失败 |
| `routes[].provider` | 必填 | 主循环发送请求时使用的逻辑供应商 id，须完全一致 |
| `routes[].model` | 必填 | 主循环发送请求时使用的逻辑模型 id，须完全一致 |
| `routes[].minToolSchemaRatio` | 必填 | 大于 0 的有限数：报告的提示 token 至少要达到请求工具定义估算的这个倍数 |
| `routes[].minEstimateRatio` | 必填 | 大于 0 且小于 1 的有限数：报告的提示 token 至少要达到上下文估算的这个比例 |

本包没有默认路由，也没有默认阈值。只有用量把缓存命中的提示 token 计入提示（`prompt_tokens` 的口径）的路由才适用；否则命中缓存的正常回复会显得过小。

### 必需的重试配置

不配置重试时，第一次丢弃回复就会以 `PROMPT_USAGE_SHORTFALL` 结束本轮。要在该路由的重试策略里列出这个代码；自行提供的 `retryableCodes` 会替换默认列表，所以要把默认代码一并写上：

```yaml
modelRetryPolicy:
  mode: normal
  maxRetries: 8
  retryableCodes: [EMPTY_RESPONSE, INVALID_TOOL_ARGUMENTS, RATE_LIMIT, SERVER, TIMEOUT, TRANSPORT, PROMPT_USAGE_SHORTFALL]
  consecutiveRetryLimits: { PROMPT_USAGE_SHORTFALL: 1 }
  backoff: { initialDelayMs: 2000, maxDelayMs: 60000 }
```

在常规模式下，`consecutiveRetryLimits` 在步骤的总预算内限制同一错误码的连续重试次数。示例允许用量异常后重试一次。若连续第二次报告同一异常，本轮以该错误结束。Muse 的 `muse-account` 策略包含这一限制。目标自动续跑只处理配置中的暂时性错误，遇到持续的用量异常会停止。重试由路由策略决定。`always` 模式忽略连续次数限制。

### 选择阈值

用该路由的日志确定阈值。报告的提示 token 取本次尝试或消息用量中的 `inputTokens + cacheReadTokens + cacheWriteTokens`。工具定义估算是 `request/header` 里非延迟加载工具的启发式估价。上下文估算是挂载了工作预算时的 `request/context.workingContextTokens`；每条被丢弃回复的失败消息也会写明这三个数。Muse 的取值基于 124 个本机会话：推断为坏回复的 8 条报告的提示 token 是工具定义估算的 0.19–0.73、上下文估算的 0.09–0.25；所有模型的正常回复都不低于工具定义估算的 1.53 倍，未被标为坏回复的 Gemini 回复最低为上下文估算的 0.56。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节 — 点击展开</summary>

`llm/stream` 监听器以 `prepend` 注册，只判定主循环标记过、没有辅助 `purpose`、指向一个在线 Session、且供应商与模型组合在列表中的请求。流开始时、拉取适配器之前，它测量请求中非延迟加载工具的工具定义估算，以及 token meter 对该 Session 的上下文估算；两者描述的都正是这次发出的请求。每个分块都实时转发。到结束分块时，它判定没有任何工具调用分块、且报告了正数提示 token 的 `stop` 回复。回复流出了非空文本或推理、`outputTokens` 却报告为 0，说明用量与回复自相矛盾，防护不再判定它的提示 token 并保留这条回复；没有生成内容且输出 token 为 0 的回复仍会被判定。两个阈值都没达到时，它退出循环，内层流随之关闭，内层监听器不会看到已完成的 `stop`，然后改为输出一个错误结束。只没达到其中一个阈值时，保留回复并记录一条带用量和估算值的告警。

主循环将被丢弃的回复记录为仅入日志的 `assistant/attempt`。路由策略允许重试时，会记录 `llm/retry`，并沿用同一份已记录的上下文重发。被丢弃回复的用量不会成为 token meter 的锚点，后续估算仍按正常回复校准。卸载后，已在运行的流会转发原来的结束原因。

| 文件 | 作用 |
|---|---|
| [`src/index.ts`](src/index.ts) | 显式路由、请求筛选、测量时机与错误结束 |
| [`src/assess.ts`](src/assess.ts) | 路由校验与纯函数的双阈值判定 |
| [`tests/loader-composition.spec.ts`](tests/loader-composition.spec.ts) | 真实应用与 Loader，加载桌面版正式配置项，配合模拟的丢失线路 |

</details>

-----

<a id="further-exploration"></a>
## 深入阅读

- [LLM 子系统](../../../docs/subsystems/llm-streaming.zh.md) — 流式中间件，以及重新发送被丢弃回复的重试策略。
- [Token meter](../../llm/token-meter/README.zh.md) — 上下文估算与共用的工具定义估算函数。
- [Guard 分组](../README.zh.md) — 相邻的流式与工具防护。
- [决策记录](../../../.agents/notes/implemented/bug-fix/2026-11-14-prompt-usage-shortfall-guard.zh.md) — 证据、阈值与被否决的方案。

<a id="model-experience"></a>
## Model Experience

无，因为本防护检查上报用量，而策略允许重试时会沿用同一份已记录的上下文再次请求模型。

#### KV Cache effect

不改变请求前缀；被丢弃的回复是仅入日志的尝试记录，重新发送的请求沿用同一前缀。

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

本防护只凭用量识别一类很窄的故障。

- 不报告用量或报告零用量的线路抓不到，对含有文本的回复报告输出 token 为 0 的线路也抓不到（这种报告的提示 token 不可靠）；以 `max-tokens` 结束或调用了工具的坏回复也抓不到。
- 工具集较小时，防护灵敏度会降低。报告的用量达到任一阈值时，回复仍会被保留。
- 同一请求如果再次出现相同的用量报告，误判仍可能重现。仅凭用量测量无法确认上游是否收到了完整请求。
- 被丢弃的文本会先实时显示再撤下，上下文用量会短暂显示那次很小的提示 token，重试用尽的对话轮次没有“继续”按钮。
- 失败消息是英文主机文本，与 Muse 其他模型失败消息一致。
- Muse 的阈值基于 8 条推断的坏回复和 171 条带估算记录的 Gemini 回复；网关日志无法逐条确认这些标注。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文 — 点击展开</summary>

无。

</details>
