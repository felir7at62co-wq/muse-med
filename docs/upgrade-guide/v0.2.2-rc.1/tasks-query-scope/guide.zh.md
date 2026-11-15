---
kind: upgrade-guide
description: "聚变 tasks 查询现在仅在显式传入 task_type 时按任务类型筛选。"
---

# 聚变任务查询默认包含全部类型

[English](guide.md) | 中文

## 变更

`jubian_video` 的 `method: tasks` 原先只请求生成任务（`taskType=1`）。现在只有调用方传入正整数 `task_type` 才筛选类型，否则查询项目全部类型的任务列表。原先假定每条返回记录都是生成任务的调用方，需要显式选择该类型。

`tasks.scope` 标明项目及筛选条件，`scope.task_type: null` 表示未筛选。`total_verified` 与 `complete` 只描述提供方报告的本次查询结果。筛选查询的 `project_complete` 恒为 false，只有未筛选且本次响应包含当前完整项目列表时才可能为 true。这些字段都不证明提供方保留了全部历史任务。

## 迁移

1. 要保留原来的生成任务筛选，向 `jubian_video` 传入 `{"method":"tasks","script_id":123,"task_type":1}`。需要未筛选的项目列表时省略 `task_type`；不要把 `null` 作为输入筛选值。
2. 继续显式使用 `page_num` 和 `page_size` 分页。读取 `tasks.rows`，核对 `scope`，再按 `has_more` 和 `next_page` 查询；读到末页不代表前页已查。总数缺失或未核实时，不能认定记录不存在。
3. 即使列表为空，也要用 `{"method":"task","task_id":456}` 单独回读已知原任务 ID。继续按原任务及原幂等键对账。筛选或未筛选列表为空，都不授权新的收费请求。
4. 确认筛选调用的 `tasks.scope.task_type` 为 `1`，省略筛选时为 `null`。筛选结果必须返回 `project_complete: false`。见[任务查询及来源说明](../../../../packages/jubian/tool-jubian/README.zh.md#extract-or-reuse-existing-video)。
