---
description: "Session-owned task lists with whole-plan creation, incremental status updates, and saved progress, for users and maintainers choosing, configuring, or debugging the tools."
kind: "package-reference"
---

# @deepseek-ai/dsh-tool-todo

English | [中文](README.zh.md)

## Summary

`dsh-tool-todo` lets an agent create a task list, update one task, and continue saved progress in later turns or reopened sessions. Use `todo_write` to revise the plan and `todo_update` to change a task status without repeating unchanged tasks. The owning agent decides when results satisfy each task; generation success does not complete later editing, checks, or delivery. A required configuration flag determines whether several tasks may be active at once.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Use this package when you want the agent to maintain a visible task list while it works: plan multi-step work, show what is active, and record completion. Mounting it with the parallelism flag is the only setup; the agent then updates the list through its own planning tool whenever the plan changes.

### When to choose it

Choose it when one agent session should own a plan and update individual task statuses as work advances. Use whole-list replacement when tasks must be added, removed, renamed, or reordered. Avoid it when several agents must share one list. Automation-only surfaces that never run an agent cannot use these tools.

### Minimal configuration

`allowParallelInProgress` is required with no default: a composition that omits it fails at load, and a non-boolean value is rejected. Set `true` for agents that may run work concurrently (subagents, background commands, workflow fan-out) and `false` for the single-active discipline.

```yaml
- name: '@deepseek-ai/dsh-tool-todo'
  config:
    allowParallelInProgress: true
```

| Field | Default | Meaning |
|---|---|---|
| `allowParallelInProgress` | required | Whether several todos may be `in_progress` at once; also selects the active-status clause of the model description |

The generated [configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-tool-todo) is the exhaustive source for the accepted field.

### What each call does

`todo_write` accepts the complete replacement list. Each item contains a non-empty, unique task description and a status of `pending`, `in_progress`, or `completed`; an empty list clears the plan. Use it to create or revise the tasks.

`todo_update` accepts an exact existing task description as `task`, its new `status`, and optional `start_next`. Surrounding whitespace in `task` is ignored; the remaining text must match in full. It changes that task without resending the other items and can continue the latest saved list after another turn begins or the Session reopens. An unknown task, invalid status, or a result with several active items where parallel work is disabled fails without appending a snapshot.

`start_next: true` is valid only with `status: completed`. When this call changes the target from an unfinished status to completed and no other task remains active, it starts the first pending task in list order. An already completed target never advances another task on retry. If another task remains active or none is pending, no additional task starts.

Both tools return JSON text containing the resulting `todos`, status `counts`, `current` active task names, `next` pending task name or `null`, and a `reminder` to verify actual results before recording completion. Each successful call appends one full `todo/write` snapshot. The tools never derive completion from a provider result or run an automatic reminder loop.

### Single owner

The task list belongs to the one agent session that created it — subagents and other agents each keep their own list, and there is no way to share a list between agents. A call from outside an agent session is rejected, so the agent learns the update failed instead of silently writing nowhere. If you need a list shared across agents, this package does not provide it.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

This section explains the design decisions behind the tool and points at the code that realizes them; the observable behavior is fully covered in [Use this package](#use-this-package).

### Design philosophy

The tool is built on four commitments:

- **Full snapshots with incremental commands.** Plan replacement and individual status updates both commit a complete `todo/write` snapshot. Replay and recovery use the most recent committed list, including when the current-turn UI plan has been cleared.
- **Single owner.** The list belongs to the calling agent session; there is no shared or swarm scope, and non-agent callers are rejected.
- **Deployment policy, not a coded rule.** `allowParallelInProgress` is a required composition choice because the tool cannot observe runtime concurrency.
- **Validation keeps the logged snapshot honest.** Schema-level rejection of unknown item keys and `execute`-level rejection of empty or duplicate content keep the durable snapshot equal to what the model believes it wrote.

The [todo_write tool Agent Note](../../../.agents/notes/archived/feature/2026-06-29-todo-write-tool.md) records the original design and alternatives; the [parallel in-progress Agent Note](../../../.agents/notes/archived/feature/2026-07-26-todo-parallel-in-progress.md) records the policy decision.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Plugin entry: `Config` schema, tool registration, `todos` projection unit |
| [`src/types.ts`](src/types.ts) | The one home of the `todos` projection-key declaration and its payload types |
| [`src/client.ts`](src/client.ts) | Client-namespace re-export of the types outlet |

### Export shape

The plugin is a function/namespace plugin: it exports `name` / `inject` / `apply` and no default export. A stray `export default` would make the Loader's `unwrapExports` collapse the module and drop `inject` (see [postmortem 0001](../../../docs/postmortem/0001-acp-default-export-drops-inject.md)).

### Session projection

The package uses [`ctx.sessionProjections`](../../session/session-projection/README.md) for two views of committed snapshots. The visible `todos` projection is the current-turn plan: it is `null` before the first write or after the next `turn/start`, while `turn/end` keeps the finished checklist visible. The host-only `latestTodos` projection retains the most recent `todo/write` across turn boundaries and reconstructs it during replay; `todo_update` uses this retained list. History pages and push frames expose only the visible plan. See [src/index.ts](src/index.ts) for the registrations.

### Call mechanics

Each call validates its arguments and the resulting complete list before appending one `todo/write` snapshot. Incremental updates preserve every other task except the explicitly requested next-task transition. They read the latest committed snapshot independently of the current-turn UI projection. The durable event remains a full list of `TodoItem` entries with only `content` and `status`; no per-item identifier or delta event is needed. See [src/index.ts](src/index.ts) for validation and commit details.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

Read these pages when the package-level contract is not enough. They move from the session subsystem to the generated catalogs and the decision records behind the tool.

- [Todo subsystem](../../../docs/subsystems/todo.md) — the `todo/write` event payload, ownership rules, and `TodoItem`.
- [todo group map](../README.md) — the sibling group page and its package table.
- [Generated tool catalog](../../../docs/tool-catalog.md#deepseek-aidsh-tool-todo) — the `todo_write` and `todo_update` schemas the model receives.
- [Generated configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-tool-todo) — every accepted config field and its source declaration.
- [todo_write tool Agent Note](../../../.agents/notes/archived/feature/2026-06-29-todo-write-tool.md) — the original design, alternatives, and dropped fields.
- [parallel in-progress Agent Note](../../../.agents/notes/archived/feature/2026-07-26-todo-parallel-in-progress.md) — why the active-count cap is a deployment policy.

-----

<a id="model-experience"></a>
## Model Experience

### Tool schema

#### What the model sees

The model sees the generated [`todo_write` and `todo_update` schemas](../../../docs/tool-catalog.md#deepseek-aidsh-tool-todo). The first accepts a complete plan; the second names one existing task and its status, optionally requesting the next task when completing it. Both descriptions require verified completion and follow the configured active-task policy.

#### Token effect

Fixed schema cost on every request where the tool is visible; the description and schema are stable for a given configuration.

#### KV Cache effect

Prefix-stable while the definition and visibility are unchanged. Plugin lifecycle or scoped restrictions may invalidate reuse from this schema.

### Tool-call history and result

#### What the model sees

Tool calls retain their requested arguments. Successful results are JSON text containing `todos`, `counts`, `current`, `next`, and `reminder`. The reminder reads as follows. The full `todo/write` event is UI and replay state, not a second model message.

##### Completion reminder

```markdown
After each stage, verify the actual result and update only completed tasks and the work now in progress. Unfinished or failed work stays pending or in_progress. Video generation success does not complete editing, quality checks, or delivery.
```

#### Token effect

Incremental calls submit only the named task and requested transition. Every successful result still contains the complete list, so result size grows with the plan. Calls and their results remain in history until compaction.

#### KV Cache effect

Append-only; newly visible content follows the reusable request prefix and does not invalidate existing KV-cache entries.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>


These limits define when the tool is a poor fit. They are current package constraints, not a task backlog.

- **Single-owner scope only** — the list belongs to the one calling agent session; subagent, shared, and swarm scopes are a deliberate cut, and a non-agent caller is rejected.
- **Task identity uses exact content** — items contain only `content` and three-state `status`; renaming a task requires a whole-plan replacement.
- **Completion is model-controlled** — the tools accept explicit updates and return a reminder; they do not monitor provider success, infer finished stages, or trigger timed model requests.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

This Dev Note is working context for maintainers: open questions and directions that are not decided. It is explicitly non-authoritative — shipped behavior, limits, and accepted rationale live in the sections above, the package code, and the linked Agent Notes.

#### Future: cross-agent and shared lists

Cross-agent or shared lists require a separate ownership design. No design exists yet.

</details>
