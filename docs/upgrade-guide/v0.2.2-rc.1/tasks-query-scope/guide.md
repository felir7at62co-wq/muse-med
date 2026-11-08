---
kind: upgrade-guide
description: "Jubian tasks queries now omit the task-type filter unless task_type is explicit."
---

# Jubian task queries default to all types

English | [中文](guide.zh.md)

## Change

`jubian_video` with `method: tasks` previously requested only generation tasks (`taskType=1`). It now queries the project's task list without a type filter unless the caller supplies a positive integer `task_type`. Callers that assume every returned row is a generation task must select that type explicitly.

`tasks.scope` identifies the project and filter; `scope.task_type: null` means unfiltered. `total_verified` and `complete` describe only the provider-reported results for that query. `project_complete` is false for filtered queries and can be true only when an unfiltered response contains the whole current project list. None of these fields proves that the provider retained all historical tasks.

## Migration

1. To retain the old generation-task selection, pass `{"method":"tasks","script_id":123,"task_type":1}` to `jubian_video`. Omit `task_type` when you need the unfiltered project list; do not send `null` as an input filter.
2. Keep pagination explicit with `page_num` and `page_size`. Read `tasks.rows`, check `scope`, and follow `has_more` and `next_page`; reaching the last page does not show that earlier pages were inspected. Do not treat a missing or unverified total as proof of absence.
3. Read known original IDs separately with `{"method":"task","task_id":456}`, even if a list is empty. Continue reconciliation with the original task and idempotency key. An empty filtered or unfiltered list does not authorize a new paid request.
4. Confirm that `tasks.scope.task_type` is `1` for the filtered call and `null` when omitted. A filtered result must report `project_complete: false`. See the [task query and source reference](../../../../packages/jubian/tool-jubian/README.md#extract-or-reuse-existing-video).
