---
kind: upgrade-guide
description: 剧变任务列表默认包含全部类型，只有显式参数才按类型筛选。
---

# 剧变任务列表查询范围

[English](guide.md) | 中文

## 变更

`jubian_video` 的 `method: "tasks"` 不再隐式将提供方查询限制为 `taskType=1`，默认查询全部任务类型。结果新增 `tasks.scope` 和 `tasks.project_complete`；`total_verified` 与 `complete` 只描述返回的查询范围。来源发现的项目回退也不再隐式筛选类型。

## 迁移

1. 只需要生成任务的调用方须传入 `task_type: 1`。其他正整数提供方任务类型同样可显式筛选。
2. 将响应视为完整项目列表前，检查 `tasks.project_complete`。完整的类型筛选结果，包括空结果，不代表完整项目覆盖。
3. 确认无筛选调用返回 `scope.task_type: null`，筛选调用返回具体类型且 `project_complete: false`。提供方列表与单任务读取矛盾时，保留已知任务 ID；这些字段不证明提供方保留了全部历史任务。
