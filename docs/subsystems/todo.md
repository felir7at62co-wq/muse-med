# Todo

English | [中文](todo.zh.md)

The durable todo vocabulary owned by [`@deepseek-ai/dsh-tool-todo`](../../packages/todo/tool-todo/README.md). Plan replacement and single-task status updates both commit one agent session's complete list; the package owns the event declaration and replay projections. Tool behavior and configuration are on the [package README](../../packages/todo/tool-todo/README.md).

Source: [`packages/todo/tool-todo/src/types.ts`](../../packages/todo/tool-todo/src/types.ts)

## `TodoItem` — one list entry

```ts type-equiv
/**
 * One entry in an agent's todo list — the unit of the `todo/write`
 * whole-list snapshot declared by this package.
 *
 * Deliberately minimal: a human-readable `content` line and a three-state
 * `status`. Each snapshot replaces the whole list (last-write-wins);
 * single-task updates match the unique content without adding an id. The
 * three statuses describe the complete portable lifecycle needed by model and
 * UI consumers.
 */
interface TodoItem {
  /** What this task is — a short imperative line shown in the UI. */
  content: string
  /** Lifecycle state. `in_progress` marks a task being worked now; parallel work may mark several. */
  status: 'pending' | 'in_progress' | 'completed'
}
```

## Durable event

The package declaration-merges `todo/write: { todos: TodoItem[] }` into `SessionEventMap`. The event is log-only and carries the complete replacement list; the generated [persistence catalog](../persistence-catalog.md#todowrite--log-only) records its declaration site.
