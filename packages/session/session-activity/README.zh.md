---
description: "为组合派发型父会话的维护者提供会话栏式的会话状态行，以及被关注会话的状态摘要。"
kind: "package-reference"
---

# @deepseek-ai/dsh-session-activity

[English](README.md) | 中文

## 概述

本包让父会话像人看会话栏一样看其他会话：运行中、空闲、在等回答或审批、上一轮失败，以及最近用的工具和还在跑的作业、子代理。Muse 协调器等使用方可以按需读取某个会话的状态行，也可以登记关注，让状态变化以一条有上限的摘要送进父会话收件箱。等待输入、轮次失败和停滞会唤醒空闲的父会话；其他变化等父会话下一步时带入。

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

在 Host 中与会话存储、投影注册表和 Agent 注册表一起挂载。插件提供 `ctx.sessionActivity`；使用方通过 `ctx.get('sessionActivity')` 读取，并将其视为可选。Host 挂载了 Typert 网关时，从网关读取待回答的问题和待审批的请求；还在跑的作业、子代理和定时任务来自 `workspace/session-activity` 提供方。Muse 桌面 Host 在会话协调器之前挂载本插件。

```yaml
- name: '@deepseek-ai/dsh-session-activity'
  config:
    maxLines: 8
    maxChars: 1200
    stallMs: 600000
    coalesceMs: 1000
```

| 字段 | 含义 |
|---|---|
| `maxLines` | 每条摘要列出的被关注会话数；其余有变化的会话只计数 |
| `maxChars` | 完整摘要文本的字符数 |
| `stallMs` | 被关注会话运行中超过此时长没有新事件时唤醒父会话一次；`0` 关闭 |
| `coalesceMs` | 把一串事件合并为一次评估的延迟 |

### 状态行

`describe(sessionId)` 返回一行，例如 `running for 12 min · last tool video_inspect · job: ffmpeg cut, asr · subagent: ep001-writer`。状态按以下优先级判断：

| 状态 | 来源 |
|---|---|
| `waiting for an answer in its own chat` | 该会话有待回答的 `user-questions/request` |
| `waiting for an approval in its own chat` | 该会话有待审批的 `approval/request` |
| `running` | 存活的 Agent 正在运行 |
| `not open` | 没有存活的 Agent |
| `last turn failed` | 最近一轮以错误结束；状态行附上错误文本 |
| `idle` | 其他情况 |

运行和等待状态的时长从当前轮开始时算起，其他状态从最近一轮结束时算起。作业和子代理标签截断到 40 个字符，每类最多三个。

### 关注与摘要

`watch(parent, child, label)` 返回释放函数。重复关注同一对会话会增加引用并替换标签；所有引用释放后关注结束，结束前再评估一次，投递合并延迟尚未覆盖的变化。

- 摘要列出状态行（不计时长）有变化的被关注会话。尚未打开的会话不出现在第一条摘要中。
- 不含需要父会话处理的状态的摘要以注入方式投递：在父会话收件箱中等到其下一步，自身不会开启轮次。
- 摘要仍在等待时，更新的摘要原位替换它。
- 进入等待或失败状态、或出现停滞时，摘要增加 `Needs your attention` 段落并唤醒空闲的父会话。同一状态在改变前只唤醒一次。
- 父会话日志记录该摘要后，其中的状态行成为下一条摘要的基线。

### 失败与恢复

没有存活的父会话 Agent 时插件跳过投递并保留基线。状态读取失败会记录日志并跳过，之后的评估照常进行。基线、待投递摘要标识和停滞计时器只存在于本进程：重启后第一条摘要会重新列出每个被关注会话，被关注会话提交新事件前不会因停滞唤醒父会话。卸载插件会清除所有关注和计时器；已在收件箱中的摘要保持不变。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

### 源码地图

| 文件 | 作用 |
|---|---|
| [`src/index.ts`](src/index.ts) | `SessionActivityDigests` 服务：状态读取、关注、合并与投递 |
| [`src/projection.ts`](src/projection.ts) | 仅 Host 的 `sessionActivity` 单元及其状态 schema |
| [`src/digest.ts`](src/digest.ts) | 纯函数状态行、摘要与唤醒判断 |
| [`src/types.ts`](src/types.ts) | 服务键、`session-activity` 消息来源与公开状态类型 |

### 数据模型

单元把 `turn/start`、`turn/end` 和 `tool/call` 折叠为当前轮及其开始时间、最近一次工具调用及截断参数、最近一轮结束及错误文本。状态行的其余内容在渲染时实时读取。

### 投递状态

服务为每个父会话保存被关注子会话的引用计数、标签、已记录的状态键、最近发出的状态和停滞计时器，仍在等待的摘要标识与状态键，以及串行化评估和释放的 Promise 链。父会话日志出现带该标识的 `user/message` 时，捕获的状态键成为基线。需要唤醒的摘要会移除等待中的摘要，并以后续轮次排入自身。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [会话协调器](../session-coordinator/README.zh.md)——关注执行中执行会话、并在会话搜索结果中附上状态行的 Muse 使用方。
- [会话投影注册表](../session-projection/README.zh.md)——折叠仅 Host 单元的注册表。
- [后台作业工具](../../jobs/tool-jobs/README.zh.md)——本包投递规则所参照的完成通知。

-----

<a id="model-experience"></a>
## 模型体验

### 状态摘要

#### 模型可见内容

父会话模型收到来源为 `session-activity`、形式为 `notice` 的用户消息。正文以 `Status of the Sessions you dispatched, as the session list shows it (read a Session for details):` 开头，随后每个有变化的会话一行，例如 `- episode 1 [session-…] running for 12 min · last tool video_inspect · job: ffmpeg cut`。需要父会话处理时，`Needs your attention:` 段落写明等待状态及最近一次工具调用、失败轮次的错误或停滞时长。插件不注册工具，也不添加系统提示词段落；使用方在自己的工具结果中呈现 `describe` 状态行。

#### Token 影响

每条记录的摘要最多 `maxChars` 个字符，默认约 600 token。替换机制保证每个父会话最多一条等待中的摘要，不含等待、失败或停滞会话的摘要不会发起模型请求。一次唤醒发起一次父会话请求。

#### KV Cache 影响

摘要作为普通的已记录用户消息追加；之前的消息、系统提示词和工具 schema 不变。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- **基线只在本进程** — 重启后第一条摘要会重新列出每个被关注会话，停滞检测要等到下一个被关注事件。
- **等待状态依赖网关** — 没有 Typert 网关时，在等回答的会话显示为空闲或运行中。
- **未打开的会话** 没有最近工具和轮次结束信息，状态行显示 `not open`。
- **尚未关注子代理** — 协调器关注其执行会话；把子代理状态投递给其父 Agent 属于后续计划。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作背景——点击展开</summary>

设计讨论与分阶段计划（P0 协调器执行会话、P2 子代理、P1 只读 harness 工具）记录在仓库外 2026-11-15 的 Muse 设计笔记中。

</details>
