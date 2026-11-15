---
kind: upgrade-guide
description: Jubian task lists now include all task types unless an explicit filter is supplied.
---

# Jubian task-list scope

English | [中文](guide.zh.md)

## Change

`jubian_video` with `method: "tasks"` no longer silently restricts the provider query to `taskType=1`. It lists all task types by default. Results include `tasks.scope` and `tasks.project_complete`; `total_verified` and `complete` describe only the returned scope. Source discovery's project fallback also stops applying the implicit type filter.

## Migration

1. Callers that need generation tasks only must pass `task_type: 1`. Other positive provider task types remain explicit filters.
2. Before treating a response as a complete project listing, check `tasks.project_complete`. A complete type-filtered result, including an empty one, is not complete project coverage.
3. Verify that an unfiltered call reports `scope.task_type: null` and a filtered call reports its numeric type with `project_complete: false`. Keep directly known task IDs when the provider's list disagrees with individual reads; these fields do not prove that the provider retains all historical tasks.
