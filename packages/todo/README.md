---
description: "The todo group map: session task planning, incremental status updates, and saved progress, for users and maintainers navigating the group."
kind: "package-group"
---

# packages/todo

English | [中文](README.zh.md)

## Summary

The todo group lets agents record plans, update individual task statuses, and continue saved progress. Its `tool-todo` package owns plan creation and incremental updates within one agent session. Interactive hosts show the current plan; the group itself ships no UI. Other agents keep independent lists.

## Table of Contents

- [Packages](#packages)
- [Related documentation](#related-documentation)
- [Dev Note](#dev-note)

-----

<a id="packages"></a>
## Packages

| Package | Role | ctx key |
|---|---|---|
| [`tool-todo`](tool-todo/README.md) | Lets the agent maintain a session task list: plan tasks, update status, and track progress | registers on `ctx.tools` |

-----

<a id="related-documentation"></a>
## Related documentation

- [Todo subsystem](../../docs/subsystems/todo.md) — the `todo/write` event payload, ownership rules, and `TodoItem`.
- [Generated tool catalog](../../docs/tool-catalog.md#deepseek-aidsh-tool-todo) — the task-list tools the model receives.
- [Generated configuration catalog](../../docs/config-catalog.md#deepseek-aidsh-tool-todo) — every accepted config field.
- [todo_write tool Agent Note](../../.agents/notes/archived/feature/2026-06-29-todo-write-tool.md) — the original design and its alternatives.

-----

<a id="dev-note"></a>
## Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
