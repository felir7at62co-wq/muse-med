---
description: "在同一 agent 轮次中自动续写达到输出上限的回答，保留取消与重复检测。"
kind: "package-reference"
---

# @deepseek-ai/dsh-agent-output-continuation

[English](README.md) | 中文

## 概述

提供方报告 `max-tokens` 时自动继续回答。每次续写都经过正常的 agent 输入、请求准备和上下文压缩。后续正常停止会使轮次完成；原始截断请求仍保留在会话日志中。

## 目录

- [使用此包](#use-this-package)
- [模型体验](#model-experience)
- [已知限制与延后工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

<a id="use-this-package"></a>
## 使用此包

将此函数插件与 agent 注册表和循环一起挂载。Muse Desktop 默认挂载；其他 profile 通过补丁启用。

```yaml
- insert:
    - id: agent-output-continuation
      name: '@deepseek-ai/dsh-agent-output-continuation'
      config:
        maxContinuations: null
        maxNoProgressResponses: 2
        repeatWindowChars: 16384
```

`maxContinuations` 是正整数或 `null`；默认 `null` 不限制有进展续写的次数。`maxNoProgressResponses` 在连续空白或重复的截断回答达到指定次数时停止，默认二次。重复检测比较整段回答哈希及其是否包含于最近 `repeatWindowChars` 个回答字符中，该字段默认 16384。`continuationTailChars` 限制续写指令中的精确回答尾部，默认 1024 个字符，保留尾部空白。`{responseEndJSON}` 是该尾部编码后的 JSON 字符串。激活时拒绝零、负数、小数和不安全整数。要停用该行为，将插件行补丁设置为 `disabled: true`。

只有当前轮次已提交的截断回答才能预留续写。排队中的用户输入优先。取消、卸载插件、新建实时 agent 或进入空闲都会撤销排队续写。输入接纳拒绝过期预留并保留其他 pre-step 策略。恢复会话不会授权自动继续旧的截断回答。

仅在续写输入已接纳且后续回答正常停止后，插件才通过 `agent/output-limit-recovered` 报告恢复。错误、取消和策略拒绝保留各自结果。现有 assembler 丢弃截断的工具调用；重新发出的完整调用经过正常工具流程，其结果仍需要后续模型步骤。每段请求各自遵守不变的输出上限。

<a id="model-experience"></a>
## 模型体验

### 已提交的截断回答之后续写

#### 模型看到什么

之前已提交的回答前缀，以及一条新的用户角色输入。其日志来源 `output-continuation` 标识本插件；相邻步骤事件标识所属轮次及前一个回答。文本如下：

##### 续写指令原文

```markdown
Your previous response was cut off before it finished. Continue exactly from where it stopped. Do not repeat the previous text or restart the answer. Complete the original request. If the response ended mid-sentence or mid-line, write only its missing suffix first; do not skip the unfinished item. If a tool call was cut off, issue the complete call again before claiming its action happened. Stop normally when the answer or required work is complete.

Exact end of the interrupted response (JSON string): {responseEndJSON}
```

#### Token 影响

每次续写将指令和模型回答追加到历史，以相同输出上限创建独立模型请求；正常请求压缩可以摘要较早的历史。空白或重复回答会消耗请求，直到配置的进展检测停止续写。

#### KV Cache 影响

指令追加在已有历史之后，在其他插件压缩或改写历史之前保留可复用前缀。缓存是否可用由提供方决定。

<a id="known-limitations-and-deferred-work"></a>
## 已知限制与延后工作

- 提供方正常 `stop` 不能证明已写出全部要求。本插件响应提供方报告的输出上限，不判断回答完整性。
- 提供方额度、请求错误、取消和重复检测仍可能使回答提前结束。续写不能突破提供方单次请求容量，也不能修复未报告结束原因的提供方。
- 进展检测只比较文本；即使提供方将两次截断请求用于隐藏推理，连续两次空白仍会停止。输出上限应为可见回答保留空间。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文 — 点击展开</summary>

无。

</details>
