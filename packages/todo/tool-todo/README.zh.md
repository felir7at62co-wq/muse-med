---
description: "单一会话拥有的任务列表，支持整表创建、增量状态更新与进度恢复，供选择、配置或排查工具的用户与维护者阅读。"
kind: "package-reference"
---

# @deepseek-ai/dsh-tool-todo

[English](README.md) | 中文

## 概述

`dsh-tool-todo` 让 agent（智能体）创建任务列表、更新单项任务，并在后续轮次或重新打开会话后继续已保存的进度。用 `todo_write` 修改计划，用 `todo_update` 改变单项状态，无需重复发送其他任务。拥有列表的 agent 判断实际结果是否满足任务；生成成功不代表后续剪辑、检查或交付完成。一个必填配置开关决定是否允许多个任务同时进行。

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

当你希望 agent 在工作时维护一份可见的任务列表时使用本包：规划多步工作、展示当前进行中的任务、记录完成情况。挂载它并设置并行开关是唯一的配置步骤；此后每次计划变化，agent 都会通过它自己的规划工具更新列表。

### 何时选择

当某个 agent 会话应当拥有计划，并随工作推进更新单项任务状态时选择它。需要添加、删除、重命名或重排任务时使用整表替换。多个 agent 必须共享同一份列表时不要选择它。从不运行 agent 的纯自动化入口无法使用这些工具。

### 最小配置

`allowParallelInProgress` 是必填项、没有默认值：省略它的组合会在加载时失败，非布尔值也会被拒绝。可能并发运行工作的 agent（subagent、后台命令、工作流扇出）设为 `true`，需要单活跃项纪律的设为 `false`。

```yaml
- name: '@deepseek-ai/dsh-tool-todo'
  config:
    allowParallelInProgress: true
```

| 字段 | 默认值 | 含义 |
|---|---|---|
| `allowParallelInProgress` | 必填 | 是否允许多个 todo 同时处于 `in_progress`；同时选择模型描述中的活跃状态条款 |

生成的[配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-tool-todo)是每个受支持字段的穷尽式真源。

### 每次调用做什么

`todo_write` 接收完整的替换列表。每个条目包含非空且唯一的任务描述，以及 `pending`、`in_progress` 或 `completed` 状态；空列表会清空计划。创建或调整任务时使用它。

`todo_update` 接收与已有任务描述完全相同的 `task`、新的 `status`，以及可选的 `start_next`。`task` 两端的空白会被忽略，其余原文必须完整匹配。它更新该项，无需重新发送其他条目；新轮次开始或 Session 重新打开后，也能继续最近保存的清单。任务不存在、状态无效，或禁用并行时结果含多个进行中条目，都会失败且不追加快照。

`start_next: true` 仅能与 `status: completed` 一起使用。本次调用把目标从未完成改为完成，且没有其他进行中的任务时，才按列表顺序启动第一个待办。目标已完成时的重试不会继续推进其他任务。若还有其他进行中任务，或没有待办，则不启动额外任务。

两个工具都返回 JSON 文本，包含结果 `todos`、状态 `counts`、进行中任务名 `current`、下一待办名或 `null` 的 `next`，以及提醒按实际结果记录完成的 `reminder`。每次成功调用都追加一份完整的 `todo/write` 快照。工具不会根据提供方结果判断完成，也不运行自动提醒循环。

### 单一所有者

任务列表属于创建它的那一个 agent 会话——subagent 与其他 agent 各自维护自己的列表，不存在跨 agent 共享列表的方式。来自 agent 会话之外的调用会被拒绝，因此 agent 会得知更新失败，而不是被静默丢弃。如果你需要多个 agent 共享同一份列表，本包不提供该能力。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

本节解释工具背后的设计决策，并指出实现它们的代码位置；可观察行为已在[使用本包](#use-this-package)中完整说明。

### 设计理念

本工具建立在四项承诺之上：

- **完整快照与增量命令。** 计划替换和单项状态更新都提交完整的 `todo/write` 快照。回放与恢复使用最近提交的清单，即使本轮 UI 计划已经清空也能继续。
- **单一所有者。** 列表属于调用 agent 会话；不存在共享或 swarm 作用域，非 agent 调用方会被拒绝。
- **部署策略，而非编码规则。** `allowParallelInProgress` 是必填组合选择，因为工具无法观测运行时并发。
- **校验确保日志快照如实反映输入。** schema 层拒绝未知条目键、`execute` 层拒绝空或重复 content，使持久快照与模型自认为写入的内容一致。

[todo_write 工具 Agent Note](../../../.agents/notes/archived/feature/2026-06-29-todo-write-tool.md) 记录原始设计与备选方案；[并行 in-progress Agent Note](../../../.agents/notes/archived/feature/2026-07-26-todo-parallel-in-progress.md) 记录该策略决策。

### 源码地图

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | 插件入口：`Config` schema、工具注册、`todos` 投影单元 |
| [`src/types.ts`](src/types.ts) | `todos` 投影键声明及其载荷类型的唯一归属地 |
| [`src/client.ts`](src/client.ts) | 客户端命名空间对类型出口的再导出 |

### 导出形状

本插件是函数／命名空间插件：导出 `name`、`inject`、`apply`，没有默认导出。多余的 `export default` 会让 Loader 的 `unwrapExports` 折叠模块并丢弃 `inject`（参见 [postmortem 0001](../../../docs/postmortem/0001-acp-default-export-drops-inject.zh.md)）。

### 会话投影

本包通过 [`ctx.sessionProjections`](../../session/session-projection/README.zh.md) 提供已提交快照的两个视图。可见的 `todos` 投影是本轮计划：首次写入前或下一次 `turn/start` 后为 `null`，`turn/end` 则保留刚完成的清单。仅供宿主使用的 `latestTodos` 投影跨轮次保留最近的 `todo/write`，并在回放时重建；`todo_update` 使用这份保留的清单。历史页面和推送帧只展示可见计划。注册见 [src/index.ts](src/index.ts)。

### 调用机制

每次调用先校验参数与更新后的完整列表，再追加一份 `todo/write` 快照。除明确请求的下一任务状态切换外，增量更新保留其他所有任务。它独立于本轮 UI 投影读取最近提交的快照。持久事件仍包含完整的 `TodoItem` 列表，条目只有 `content`、`status`，无需逐项标识符或增量事件。校验与提交细节见 [src/index.ts](src/index.ts)。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

当包级约定不够用时阅读以下页面。它们从会话子系统逐步进入生成的目录，以及工具背后的决策记录。

- [Todo 子系统](../../../docs/subsystems/todo.zh.md)——`todo/write` 事件载荷、归属规则与 `TodoItem`。
- [todo 组映射](../README.zh.md)——同级组页面及其包表格。
- [生成的工具目录](../../../docs/tool-catalog.zh.md#deepseek-aidsh-tool-todo)——模型接收的 `todo_write` 与 `todo_update` schema。
- [生成的配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-tool-todo)——每个受支持配置字段及其源声明。
- [todo_write 工具 Agent Note](../../../.agents/notes/archived/feature/2026-06-29-todo-write-tool.md)——原始设计、备选方案与未采纳的字段。
- [并行 in-progress Agent Note](../../../.agents/notes/archived/feature/2026-07-26-todo-parallel-in-progress.md)——为何活跃计数上限成为部署策略。

-----

<a id="model-experience"></a>
## 模型体验

### 工具 schema

#### 模型看到什么

模型会看到生成的 [`todo_write` 与 `todo_update` schema](../../../docs/tool-catalog.zh.md#deepseek-aidsh-tool-todo)。前者接收完整计划，后者指定一项已有任务及其状态，并可在完成时请求开始下一项。两个工具说明都要求核实完成，并遵循配置的进行中任务策略。

#### Token 影响

工具可见的每个请求都有固定 schema 开销；在给定配置下描述与 schema 保持稳定。

#### KV Cache 影响

定义与可见性不变时前缀保持稳定。插件生命周期或作用域限制可能使从此 schema 起的复用失效。

### 工具调用历史与结果

#### 模型看到什么

工具调用保留请求参数，成功结果是包含 `todos`、`counts`、`current`、`next` 与 `reminder` 的 JSON 文本。提醒原文如下；其含义是每阶段按实际结果更新，未完成或失败的工作保持待办或进行中，生成成功不代表剪辑、质检或交付完成。完整的 `todo/write` 事件是 UI 与回放状态，而非第二条模型消息。

##### 完成提醒

```markdown
After each stage, verify the actual result and update only completed tasks and the work now in progress. Unfinished or failed work stays pending or in_progress. Video generation success does not complete editing, quality checks, or delivery.
```

#### Token 影响

增量调用只提交所指定的任务与状态切换。每次成功结果仍包含完整列表，因此结果大小随计划增长。调用与结果会保留在历史中，直到压缩（compaction）。

#### KV Cache 影响

仅追加；新可见内容位于可复用请求前缀之后，不会使既有 KV-cache 条目失效。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>


这些限制说明工具何时不合适。它们是当前包约束，不是任务积压。

- **仅单一所有者作用域**——列表属于唯一调用 agent 会话；subagent、共享与 swarm 作用域是有意设置的限制，非 agent 调用方会被拒绝。
- **任务身份使用精确原文**——条目只有 `content` 与三态 `status`；重命名任务需要替换完整计划。
- **完成状态由模型控制**——工具接收明确更新并返回提醒，不监测提供方成功、不推断阶段完成，也不触发定时模型请求。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

本开发备注是维护者的工作上下文：未决问题与尚未决定的方向。它明确不具权威性——已交付行为、限制与既定理由以上文、包代码和相关 Agent Note 为准。

#### 未来：跨 agent 与共享列表

跨 agent 或共享列表需要独立的所有权设计。目前尚不存在设计。

</details>
