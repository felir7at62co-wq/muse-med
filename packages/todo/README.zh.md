---
description: "todo 组地图：会话任务规划、增量状态更新与进度恢复，供浏览本组的用户与维护者阅读。"
kind: "package-group"
---

# packages/todo

[English](README.md) | 中文

## 概述

todo 组让 agent（智能体）记录计划、更新单项任务状态并继续已保存的进度。其 `tool-todo` 包负责单个 agent 会话内的计划创建与增量更新。交互式宿主展示当前计划，组本身不附带 UI。其他 agent 各自维护独立列表。

## 目录

- [包](#packages)
- [相关文档](#related-documentation)
- [开发备注](#dev-note)

-----

<a id="packages"></a>
## 包

| 包 | 职责 | ctx 键 |
|---|---|---|
| [`tool-todo`](tool-todo/README.zh.md) | 让 agent 维护会话任务列表：规划任务、更新状态、跟踪进度 | 注册到 `ctx.tools` |

-----

<a id="related-documentation"></a>
## 相关文档

- [Todo 子系统](../../docs/subsystems/todo.zh.md)——`todo/write` 事件载荷、归属规则与 `TodoItem`。
- [生成的工具目录](../../docs/tool-catalog.zh.md#deepseek-aidsh-tool-todo)——模型接收的任务列表工具。
- [生成的配置目录](../../docs/config-catalog.zh.md#deepseek-aidsh-tool-todo)——每个受支持配置字段。
- [todo_write 工具 Agent Note](../../.agents/notes/archived/feature/2026-06-29-todo-write-tool.md)——原始设计及其备选方案。

-----

<a id="dev-note"></a>
## 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>
