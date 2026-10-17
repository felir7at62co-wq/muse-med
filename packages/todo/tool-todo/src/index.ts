/**
 * Model-facing task planning and single-task updates. Both tools append complete `todo/write`
 * snapshots to the calling agent's session. Progress reminders describe the next work without
 * inferring completion from other tools. Named exports preserve loader injection metadata.
 * @module @deepseek-ai/dsh-tool-todo
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { z as zod } from 'zod'
import type { ZodType } from 'zod'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { TodoItem } from './types.ts'
// Type-only: resolves the required ctx.sessionProjections service declaration.
import type {} from '@deepseek-ai/dsh-session-projection'
// The `todos` projection-key declaration lives in src/types.ts (its one home);
// this re-export projects the type face onto the package root AND keeps the
// module edge in the emitted index.d.ts, so aggregate programs consuming the
// declarations still receive the SessionProjectionMap merge.
export type * from './types.ts'

export const name = 'tool-todo'
export const inject = ['tools', 'sessionProjections']

/** The valid {@link TodoItem} statuses, as a runtime set for input narrowing. */
const STATUSES = ['pending', 'in_progress', 'completed'] as const

/** Model-facing todo tool configuration. */
export interface Config {
  /**
   * Required deployment choice for whether several todos may be `in_progress` at once. True suits
   * agents that run work concurrently — subagents, background commands, workflow fan-out — and the
   * description then instructs the model to mark every actively worked task. False restores the
   * single-active discipline: the description asks for exactly one, and a call marking more is
   * rejected.
   */
  allowParallelInProgress: boolean
}

/** Schemastery configuration for the todo tool consumer. */
export const Config: z<Config> = z.object({
  allowParallelInProgress: z.boolean().required(),
})

const DESCRIPTION_HEAD =
  'Record and update a task list to plan multi-step work and show progress; skip it for trivial '
  + 'single-step tasks. Add one todo per concrete step before you start. Use this tool to create or '
  + 'revise the whole plan; use todo_update for individual status changes. '

const DESCRIPTION_PARALLEL =
  'While work remains, keep the todos being worked on `in_progress`, several only when work runs in parallel. '

const DESCRIPTION_SINGLE =
  'While work remains, keep exactly one todo `in_progress`. '

const DESCRIPTION_TAIL =
  'After each stage, verify its actual result and immediately update the completed task and the work '
  + 'now in progress. Keep unfinished or failed work pending or in_progress; do not wait until final '
  + 'delivery to update all tasks at once. Generation success does not complete editing, quality checks, or delivery.'

const PROGRESS_REMINDER =
  'After each stage, verify the actual result and update only completed tasks and the work now in progress. '
  + 'Unfinished or failed work stays pending or in_progress. '
  + 'Video generation success does not complete editing, quality checks, or delivery.'

const TODO_OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    todos: {
      type: 'array', required: true,
      items: {
        type: 'object', additionalProperties: false,
        properties: {
          content: { type: 'string', required: true },
          status: { type: 'string', required: true, enum: STATUSES },
        },
      },
    },
    counts: {
      type: 'object', additionalProperties: false, required: true,
      properties: {
        pending: { type: 'integer', required: true },
        inProgress: { type: 'integer', required: true },
        completed: { type: 'integer', required: true },
      },
    },
    current: { type: 'array', required: true, items: { type: 'string' } },
    next: { oneOf: [{ type: 'string' }, { type: 'null' }], required: true },
    reminder: { type: 'string', required: true },
  },
} as const

/** Return the committed list with its current work, next pending task, and advisory guidance. */
function progress(todos: TodoItem[]) {
  const count = (status: TodoItem['status']): number => todos.filter(todo => todo.status === status).length
  return {
    todos,
    counts: { pending: count('pending'), inProgress: count('in_progress'), completed: count('completed') },
    current: todos.filter(todo => todo.status === 'in_progress').map(todo => todo.content),
    next: todos.find(todo => todo.status === 'pending')?.content ?? null,
    reminder: PROGRESS_REMINDER,
  }
}

/**
 * The model-facing description for one activation. The active-status clause is the only part that
 * varies, because it is the only instruction the parallel policy changes.
 * @param allowParallel - whether several todos may be `in_progress` at once.
 * @returns the composed tool description.
 */
function describe(allowParallel: boolean): string {
  return DESCRIPTION_HEAD
    + (allowParallel ? DESCRIPTION_PARALLEL : DESCRIPTION_SINGLE)
    + DESCRIPTION_TAIL
}

/**
 * Validate the value constraints the ParameterSchemaSpec can't express and build the canonical {@link
 * TodoItem}[]: trimmed non-empty unique content, and at most one `in_progress` item unless the
 * deployment allows parallel work. The registry has already enforced the status enum and rejected
 * unknown item keys (`additionalProperties: false` — the logged snapshot must equal what the model
 * believes it wrote, so a nested/extended item shape fails loud at the schema boundary instead of
 * silently flattening); the cast below records that guarantee.
 * @param raw - the model-supplied list, already schema-checked.
 * @param allowParallel - whether several items may be `in_progress` at once.
 * @returns the canonical list.
 */
function toTodoList(raw: { content: string; status: string }[], allowParallel: boolean): TodoItem[] {
  const todos: TodoItem[] = []
  const seen = new Set<string>()
  let active = 0
  for (const item of raw) {
    const content = item.content.trim()
    if (content.length === 0) {
      throw new Error('invalid todo: `content` must be a non-empty string')
    }
    if (seen.has(content)) {
      throw new Error(`invalid todos: duplicate content ${JSON.stringify(content)}`)
    }
    seen.add(content)
    if (item.status === 'in_progress') active++
    todos.push({ content, status: item.status as TodoItem['status'] })
  }
  if (!allowParallel && active > 1) {
    throw new Error(`invalid todos: at most one task may be in_progress (got ${active})`)
  }
  return todos
}

/** Wire payload schema of the `todos` projection (whole list or pre-first-write null). */
const todosProjectionSchema: ZodType<TodoItem[] | null> = zod.union([
  zod.array(zod.object({
    content: zod.string(),
    status: zod.union([zod.literal('pending'), zod.literal('in_progress'), zod.literal('completed')]),
  })),
  zod.null(),
])

/**
 * Register the planning tools and the visible and host-only list projections.
 * @param ctx - registrant context carrying the tool and session-projection registries.
 * @param config - deployment's explicit todo policy.
 */
export function apply(ctx: Context, config: Config): void {
  const allowParallel = config.allowParallelInProgress
  // Standing-plan fold: latest whole todo/write list, cleared by the next
  // turn/start (turn/end keeps the finished checklist visible); null before the
  // first write or after a later turn begins; every other event returns the
  // same state reference.
  ctx.sessionProjections.register<'todos', TodoItem[] | null>({
    key: 'todos',
    stateSchema: todosProjectionSchema,
    init: () => null,
    apply: (state, event) => {
      if (event.type === 'todo/write') return event.data.todos
      if (event.type === 'turn/start') return null
      return state
    },
    wire: { viewSchema: todosProjectionSchema, view: state => state },
    stateVersion: 2,
  })
  ctx.sessionProjections.register<'latestTodos', TodoItem[] | null>({
    key: 'latestTodos',
    stateSchema: todosProjectionSchema,
    init: () => null,
    apply: (state, event) => event.type === 'todo/write' ? event.data.todos : state,
    stateVersion: 1,
  })
  ctx.tools.register(defineTool({
    name: 'todo_write',
    description: describe(allowParallel),
    parameters: {
      todos: {
        type: 'array',
        required: true,
        description: 'The COMPLETE task list, replacing any previous list.',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            content: { type: 'string', required: true, description: 'What the task is — a short imperative line.' },
            status: {
              type: 'string',
              required: true,
              enum: [...STATUSES],
              description: 'pending (not started) | in_progress (now) | completed (done).',
            },
          },
        },
      },
    },
    output: {
      schema: TODO_OUTPUT_SCHEMA,
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    execute(args, exec) {
      const todos = toTodoList(args.todos, allowParallel)
      if (!exec.agent) {
        // The list is per-agent-session state; a non-agent caller (no owning
        // session) has nowhere to write it. Reject rather than silently no-op.
        throw new Error('todo_write requires an owning agent session')
      }
      exec.agent.session.append('todo/write', { todos })
      return Promise.resolve(progress(todos))
    },
    presentCall: args => ({ card: 'generic', title: 'Update todo list', kind: 'other', rawInput: args.todos }),
  }))
  ctx.tools.register(defineTool({
    name: 'todo_update',
    description: 'Update one existing task without resending the list; task must match its full text. '
      + 'Use status completed with start_next true to finish that task and start the first pending task '
      + 'when no other task is in progress. Repeating an already completed task does not advance again. '
      + 'Use todo_write to add, rename, remove, or reorder tasks. '
      + (allowParallel ? DESCRIPTION_PARALLEL : DESCRIPTION_SINGLE) + DESCRIPTION_TAIL,
    parameters: {
      task: { type: 'string', required: true, description: 'Exact content of the existing task; surrounding whitespace is ignored.' },
      status: { type: 'string', required: true, enum: [...STATUSES], description: 'Actual task state: pending, in_progress, or completed.' },
      start_next: {
        type: 'boolean',
        description: 'Only with completed: on a new completion, start the first pending task if no task remains in_progress.',
      },
    },
    output: {
      schema: TODO_OUTPUT_SCHEMA,
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    execute(args, exec) {
      if (!exec.agent) throw new Error('todo_update requires an owning agent session')
      if (args.start_next === true && args.status !== 'completed') {
        throw new Error('invalid todo_update: start_next is only allowed with status completed')
      }
      const task = args.task.trim()
      if (!task) throw new Error('invalid todo_update: task must be a non-empty string')
      const previous = ctx.sessionProjections.stateOf(exec.agent.session, 'latestTodos')
      if (previous === undefined) throw new Error('todo_update requires the latestTodos projection')
      if (previous === null) throw new Error('no todo list: create one with todo_write first')
      const target = previous.find(todo => todo.content === task)
      if (!target) throw new Error(`unknown todo task ${JSON.stringify(task)}; use its exact content from the task list`)
      const todos = previous.map(todo => ({ ...todo, status: todo === target ? args.status : todo.status }))
      if (args.start_next === true && target.status !== 'completed' && !todos.some(todo => todo.status === 'in_progress')) {
        const next = todos.find(todo => todo.status === 'pending')
        if (next) next.status = 'in_progress'
      }
      const canonical = toTodoList(todos, allowParallel)
      exec.agent.session.append('todo/write', { todos: canonical })
      return Promise.resolve(progress(canonical))
    },
    presentCall: args => ({ card: 'generic', title: 'Update todo task', kind: 'other', rawInput: args }),
  }))
}
