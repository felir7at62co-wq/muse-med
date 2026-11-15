---
description: "为组合派发型父会话的维护者提供被关注会话的精简进展摘要。"
kind: "package-reference"
---

# @deepseek-ai/dsh-session-activity

[English](README.md) | 中文

## 概述

本包让父会话无需轮询即可跟进它派出的会话的进展。Muse 协调器等使用方登记关注后，插件折叠每个被关注会话的工具调用、失败、图片输入、声明的交付文件、所属作业和 token 用量，并向父会话收件箱放入一条有上限的摘要。提问、轮次失败和停滞会唤醒空闲的父会话；其他进展等父会话下一步时一并带入。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

在 Host 中与会话存储、投影注册表和 Agent 注册表一起挂载。插件提供 `ctx.sessionActivity`；使用方通过 `ctx.get('sessionActivity')` 读取，并将其视为可选。Muse 桌面 Host 在会话协调器之前挂载本插件，协调器为每个执行中任务的主会话关注该任务的执行会话。

```yaml
- name: '@deepseek-ai/dsh-session-activity'
  config:
    wakeTools: [ask_user_question]
    maxLines: 8
    maxChars: 1200
    stallMs: 600000
    coalesceMs: 1000
```

| 字段 | 含义 |
|---|---|
| `wakeTools` | 被关注会话新调用这些工具时唤醒父会话；引用调用参数，截断到 160 个字符 |
| `maxLines` | 每条摘要列出的被关注会话数；其余有变化的会话只计数 |
| `maxChars` | 完整摘要文本的字符数 |
| `stallMs` | 被关注会话运行中超过此时长没有新事件时唤醒父会话一次；`0` 关闭 |
| `coalesceMs` | 把一串事件合并为一次评估的延迟 |

`watch(parent, child, label)` 返回释放函数。重复关注同一对会话会增加引用并替换标签；所有引用释放后关注结束，结束前再评估一次，投递合并延迟尚未覆盖的变化。新关注的会话在提交第一个计数事件后才出现。

### 投递

- 摘要每行列出一个有变化的被关注会话：运行或空闲、调用最多的四个工具、图片数、最近四个交付文件名、作业计数、失败数及最近一次失败文本、最近上下文大小和累计输入 token。
- 只报告进展的摘要以注入方式投递：在父会话收件箱中等到其下一步，自身不会开启轮次。
- 摘要仍在等待时，更新的摘要原位替换它，因此父会话只收到一条带最新统计的摘要。
- 新调用 `wakeTools` 中的工具、轮次以错误结束或出现停滞时，摘要增加 `Needs your attention` 段落并唤醒空闲的父会话。
- 父会话日志记录该摘要后，其中的统计成为基线；之后有变化的会话才出现在下一条摘要中。

### 失败与恢复

没有存活的父会话 Agent 时插件跳过投递并保留基线。基线、待投递摘要标识和停滞计时器只存在于本进程：重启后第一条摘要会列出每个有变化的被关注会话，被关注会话提交新事件前不会因停滞唤醒父会话。卸载插件会清除所有关注和计时器；已在收件箱中的摘要保持不变。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

### 源码地图

| 文件 | 作用 |
|---|---|
| [`src/index.ts`](src/index.ts) | `SessionActivityDigests` 服务：投影注册、关注、合并与投递 |
| [`src/projection.ts`](src/projection.ts) | 仅 Host 的 `sessionActivity` 单元及其状态 schema |
| [`src/digest.ts`](src/digest.ts) | 纯函数摘要渲染与唤醒判断 |
| [`src/types.ts`](src/types.ts) | 服务键、`session-activity` 消息来源与公开状态类型 |

### 数据模型

单元折叠 `turn/start`、`turn/end`、`tool/call`、`tool/result`、`user/message`、`assistant/message`、`deliverables/presented`、`job/registered` 和 `job/settled`。每个工具的统计保留调用数、失败数、最近一次调用序号及其截断参数。图片块以图片形式送达模型时计数；卸载后的占位不计数。没有结果的调用在 `turn/end` 时丢弃。记录查找只读自有键，因此 `constructor` 等提供方生成的标识不会解析到继承成员。状态大小随不同工具名和声明的交付路径增长。

### 投递状态

服务为每个父会话保存被关注子会话的引用计数、标签、已投递基线和停滞计时器，以及仍在等待的摘要标识和其捕获的统计。父会话日志出现带该标识的 `user/message` 时，捕获的统计成为基线。需要唤醒的摘要会移除等待中的摘要，并以后续轮次排入自身。唤醒原因按最近一次发出（已记录或仍在等待）的统计判断，因此同一个提问或停滞只唤醒父会话一次。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [会话协调器](../session-coordinator/README.zh.md)——关注执行中执行会话的 Muse 使用方。
- [会话投影注册表](../session-projection/README.zh.md)——折叠仅 Host 单元的注册表。
- [后台作业工具](../../jobs/tool-jobs/README.zh.md)——本包投递规则所参照的完成通知。

-----

<a id="model-experience"></a>
## 模型体验

### 进展摘要

#### 模型可见内容

父会话模型收到来源为 `session-activity`、形式为 `notice` 的用户消息。正文以 `Activity of the Sessions you dispatched (running totals; read a Session for details):` 开头，随后每个有变化的会话一行，例如 `- episode 1 [session-…] running turn 3 · tools bash 35, video_inspect 2 · images 8 · delivered ep001.md · jobs 2 running/12 done/1 failed · errors 1 (last: …) · context 21k tokens, input total 2.1M`。需要父会话处理时，`Needs your attention:` 段落引用提问工具的参数、失败轮次的错误或停滞时长。插件不注册工具，也不添加系统提示词段落。

#### Token 影响

每条记录的摘要最多 `maxChars` 个字符，默认约 600 token。替换机制保证每个父会话最多一条等待中的摘要，只报告进展的摘要不会发起模型请求。一次唤醒发起一次父会话请求。

#### KV Cache 影响

摘要作为普通的已记录用户消息追加；之前的消息、系统提示词和工具 schema 不变。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- **基线只在本进程** — 重启后第一条摘要会重复未变化的统计，停滞检测要等到下一个被关注事件。
- **交付文件而非所有写入文件** — 只有被关注会话通过 `present` 声明的文件才会列出；shell 命令写入的文件只计为工具调用。
- **不含金额** — 只显示 token 统计；本包不知道各模型价格。
- **尚未关注子代理** — 协调器关注其执行会话；把子代理和作业的进展投递给其父 Agent 属于后续计划。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作背景——点击展开</summary>

设计讨论与分阶段计划（P0 协调器执行会话、P2 子代理、P1 只读 harness 工具）记录在仓库外 2026-11-15 的 Muse 设计笔记中。

</details>
