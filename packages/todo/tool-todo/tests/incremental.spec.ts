/** Incremental task changes through real Loader configuration, agent execution, and serialized replay. */
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import type { Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { createUserMessage, ToolCallId } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { defineContentToolFixture } from '@deepseek-ai/dsh-tools'
import { afterEach, expect, it, vi } from 'vitest'
import * as ToolTodo from '../src/index.ts'
import { MockAdapter, textResponse, toolCallResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'

const contexts: Context[] = []
const roots: string[] = []
afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
  await Promise.all(roots.splice(0).map(root => rm(root, { force: true, recursive: true })))
})

const PLAN = [
  { content: 'generate video', status: 'in_progress' },
  { content: 'edit episode', status: 'pending' },
  { content: 'check quality', status: 'pending' },
  { content: 'deliver episode', status: 'pending' },
]

async function harness(allowParallelInProgress = true, throughLoader = false) {
  const ctx = new Context()
  contexts.push(ctx)
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(AgentLoop, { agents: [] })
  if (throughLoader) {
    const root = await mkdtemp(join(tmpdir(), 'dsh-incremental-todo-'))
    roots.push(root)
    const file = join(root, 'cordis.yml')
    await writeFile(file, `- name: cordis:todo\n  config:\n    allowParallelInProgress: ${allowParallelInProgress}\n`)
    await ctx.plugin(Loader)
    ctx.loader.builtins.include = Include
    ctx.loader.builtins.todo = ToolTodo
    await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(file).href } })
    await ctx.loader.await()
    for (const entry of ctx.loader.entries()) await entry.fiber?.await()
  } else await ctx.plugin(ToolTodo, { allowParallelInProgress })
  const events = new Map<SessionId, SessionEvent[]>()
  ctx.on('session/event', (session, event) => {
    const log = events.get(session.id) ?? []
    log.push(event)
    events.set(session.id, log)
  })
  ctx.tools.register(defineContentToolFixture({
    name: 'generate', description: 'Return a provider success for the fixture', parameters: {},
    execute: async () => [{ type: 'text', text: 'provider generation succeeded' }],
  }))
  return { ctx, events }
}

async function agent(ctx: Context, adapter = new MockAdapter([]), id = 'incremental-todo') {
  ctx.llm.registerAdapter([id], adapter)
  return ctx.agentLoop.create(SessionId(id), { provider: id, model: 'mock' })
}

async function run(subject: Agent, text = 'continue the episode') {
  subject.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text }] }))
  await subject.whenIdle()
}

let call = 0
function execute(ctx: Context, subject: Agent | undefined, name: string, args: object) {
  return ctx.tools.execute({ name, arguments: args, callId: ToolCallId(`incremental-${call++}`),
    signal: new AbortController().signal, ...subject === undefined ? {} : { agent: subject } })
}

function writes(events: readonly SessionEvent[]) {
  return events.filter(event => event.type === 'todo/write').map(event => event.data.todos)
}

function textOf(message: { content: readonly { type: string; text?: string }[] }): string {
  return message.content.filter(block => block.type === 'text').map(block => block.text).join('')
}

function parsedResult(message: { content: readonly { type: string; text?: string }[] }): unknown {
  return JSON.parse(textOf(message))
}

it('runs the configured tools through the real loop and exposes current, next, and completion guidance', async () => {
  const { ctx, events } = await harness(false, true)
  const adapter = new MockAdapter([
    toolCallResponse('plan', 'todo_write', { todos: PLAN }), toolCallResponse('provider', 'generate', {}),
    toolCallResponse('generated', 'todo_update', { task: 'generate video', status: 'completed', start_next: true }),
    toolCallResponse('edited', 'todo_update', { task: 'edit episode', status: 'completed', start_next: true }),
    toolCallResponse('checked', 'todo_update', { task: 'check quality', status: 'completed', start_next: true }),
    toolCallResponse('delivered', 'todo_update', { task: 'deliver episode', status: 'completed', start_next: true }), textResponse('Delivered.'),
  ])
  const subject = await agent(ctx, adapter)
  let generationPlan: unknown
  ctx.on('tools/result', (exec) => {
    if (exec.agent === subject && exec.name === 'generate') generationPlan = ctx.sessionProjections.stateOf(subject.session, 'latestTodos')
  })
  await run(subject)
  expect(generationPlan).toEqual(PLAN)
  expect(adapter.requests).toHaveLength(7)
  const log = events.get(subject.id) ?? []
  expect(writes(log)).toHaveLength(5)
  expect(writes(log).at(-1)).toEqual(PLAN.map(todo => ({ ...todo, status: 'completed' })))
  expect(ctx.sessionProjections.snapshot(subject.session)?.values).not.toHaveProperty('latestTodos')
  const todoCalls = new Set(log.filter(event => event.type === 'tool/call' && event.data.name.startsWith('todo_'))
    .map(event => event.type === 'tool/call' ? event.data.callId : ''))
  const modelResults = subject.session.deriveMessages().filter(message => message.role === 'tool' && todoCalls.has(message.toolCallId))
  expect(modelResults.map(parsedResult)).toMatchSnapshot()
  for (const snapshot of log.filter(event => event.type === 'todo/write')) {
    expect(Object.keys(snapshot.data)).toEqual(['todos'])
    expect(snapshot.data.todos.every(todo => Object.keys(todo).sort().join() === 'content,status')).toBe(true)
  }
})

it('continues the saved list in another turn although the visible plan is cleared at turn start', async () => {
  const { ctx, events } = await harness()
  const adapter = new MockAdapter([
    toolCallResponse('plan', 'todo_write', { todos: PLAN }), textResponse('Generation planned.'),
    toolCallResponse('continue', 'todo_update', { task: 'generate video', status: 'completed', start_next: true }), textResponse('Editing.'),
  ])
  const subject = await agent(ctx, adapter)
  await run(subject, 'plan')
  let visibleAtStart: unknown = 'not observed'
  let savedAtStart: unknown
  ctx.on('session/event', (session, event) => {
    if (session === subject.session && event.type === 'turn/start' && event.data.turn === 2) {
      visibleAtStart = ctx.sessionProjections.stateOf(session, 'todos')
      savedAtStart = ctx.sessionProjections.stateOf(session, 'latestTodos')
    }
  })
  await run(subject, 'generation passed, continue')
  expect(visibleAtStart).toBeNull()
  expect(savedAtStart).toEqual(PLAN)
  expect(writes(events.get(subject.id) ?? [])).toHaveLength(2)
  expect(ctx.sessionProjections.stateOf(subject.session, 'latestTodos')?.[1]?.status).toBe('in_progress')
})

it('replays a serialized real-session log and updates its last saved list in the next turn', async () => {
  const original = await harness()
  const source = await agent(original.ctx, new MockAdapter([
    toolCallResponse('plan', 'todo_write', { todos: PLAN }), textResponse('Ready to continue later.'),
  ]), 'original')
  await run(source)
  const serialized = JSON.stringify(original.events.get(source.id))
  await original.ctx.fiber.dispose()

  const restored = await harness()
  const adapter = new MockAdapter([
    toolCallResponse('continued', 'todo_update', { task: 'generate video', status: 'completed', start_next: true }), textResponse('Editing.'),
  ])
  restored.ctx.llm.registerAdapter(['restored'], adapter)
  const seed = JSON.parse(serialized) as SessionEvent[]
  const handle = await restored.ctx.agents.create({ sessionId: SessionId('restored'), seed,
    agentOptions: { provider: 'restored', model: 'mock' } })
  expect(restored.ctx.sessionProjections.stateOf(handle.agent.session, 'latestTodos')).toEqual(PLAN)
  await run(handle.agent)
  expect(adapter.requests).toHaveLength(2)
  expect(writes(restored.events.get(handle.agent.id) ?? [])).toEqual([[
    { content: 'generate video', status: 'completed' }, { content: 'edit episode', status: 'in_progress' }, ...PLAN.slice(2),
  ]])
})

it('starts only the first pending task on a new completion and does not advance again on a delayed retry', async () => {
  const { ctx, events } = await harness()
  const subject = await agent(ctx)
  await execute(ctx, subject, 'todo_write', { todos: PLAN })
  await execute(ctx, subject, 'todo_update', { task: 'generate video', status: 'completed', start_next: true })
  await execute(ctx, subject, 'todo_update', { task: 'edit episode', status: 'completed' })
  const before = ctx.sessionProjections.stateOf(subject.session, 'latestTodos')
  const retry = await execute(ctx, subject, 'todo_update', { task: 'generate video', status: 'completed', start_next: true })
  expect(retry.isError).toBe(false)
  expect(ctx.sessionProjections.stateOf(subject.session, 'latestTodos')).toEqual(before)
  expect(ctx.sessionProjections.stateOf(subject.session, 'latestTodos')?.[2]?.status).toBe('pending')
  expect(writes(events.get(subject.id) ?? [])).toHaveLength(4)
})

it('does not start another task while parallel work remains active', async () => {
  const { ctx } = await harness(true)
  const subject = await agent(ctx)
  const plan = PLAN.map((todo, index) => ({ ...todo, status: index < 2 ? 'in_progress' : 'pending' }))
  await execute(ctx, subject, 'todo_write', { todos: plan })
  const result = await execute(ctx, subject, 'todo_update', { task: 'generate video', status: 'completed', start_next: true })
  expect(result.isError).toBe(false)
  expect(ctx.sessionProjections.stateOf(subject.session, 'latestTodos')).toEqual([
    { content: 'generate video', status: 'completed' }, ...plan.slice(1),
  ])
})

it('accepts explicit false without starting another task and matches full task text after trimming whitespace', async () => {
  const { ctx } = await harness()
  const subject = await agent(ctx)
  await execute(ctx, subject, 'todo_write', { todos: PLAN })
  const result = await execute(ctx, subject, 'todo_update', { task: '  generate video  ', status: 'pending', start_next: false })
  expect(result.isError).toBe(false)
  expect(ctx.sessionProjections.stateOf(subject.session, 'latestTodos')).toEqual([
    { content: 'generate video', status: 'pending' }, ...PLAN.slice(1),
  ])
})

it.each([
  { task: 'generate', status: 'completed' }, { task: 'absent', status: 'completed' }, { task: ' ', status: 'completed' },
  { task: 'generate video', status: 'doing' }, { task: 'generate video', status: 'pending', start_next: true },
  { task: 'generate video', status: 'in_progress', start_next: true }, { task: 'generate video', status: 'completed', start_next: 'yes' },
])('rejects invalid incremental changes without appending or changing the saved plan: %j', async (args) => {
  const { ctx, events } = await harness()
  const subject = await agent(ctx)
  await execute(ctx, subject, 'todo_write', { todos: PLAN })
  const seq = subject.session.seq
  expect((await execute(ctx, subject, 'todo_update', args)).isError).toBe(true)
  expect(subject.session.seq).toBe(seq)
  expect(writes(events.get(subject.id) ?? [])).toEqual([PLAN])
})

it('rejects a second active task under single-active configuration without writing', async () => {
  const { ctx, events } = await harness(false, true)
  const subject = await agent(ctx)
  await execute(ctx, subject, 'todo_write', { todos: PLAN })
  expect((await execute(ctx, subject, 'todo_update', { task: 'edit episode', status: 'in_progress' })).isError).toBe(true)
  expect(writes(events.get(subject.id) ?? [])).toEqual([PLAN])
})

it('requires an owning list, keeps agents independent, and still replaces the entire plan', async () => {
  const { ctx, events } = await harness()
  const first = await agent(ctx, new MockAdapter([]), 'first')
  const second = await agent(ctx, new MockAdapter([]), 'second')
  await execute(ctx, first, 'todo_write', { todos: PLAN })
  expect((await execute(ctx, second, 'todo_update', { task: 'generate video', status: 'completed' })).isError).toBe(true)
  expect((await execute(ctx, undefined, 'todo_update', { task: 'generate video', status: 'completed' })).isError).toBe(true)
  expect(writes(events.get(second.id) ?? [])).toEqual([])
  await execute(ctx, first, 'todo_write', { todos: [] })
  expect(ctx.sessionProjections.stateOf(first.session, 'latestTodos')).toEqual([])
  expect((await execute(ctx, first, 'todo_update', { task: 'generate video', status: 'completed' })).isError).toBe(true)
  expect(writes(events.get(first.id) ?? [])).toEqual([PLAN, []])
})

it('refuses an unavailable latest-list projection without appending a completion', async () => {
  const { ctx, events } = await harness()
  const subject = await agent(ctx)
  await execute(ctx, subject, 'todo_write', { todos: PLAN })
  const projection = vi.spyOn(ctx.sessionProjections, 'stateOf').mockReturnValueOnce(undefined)
  try {
    const result = await execute(ctx, subject, 'todo_update', { task: 'generate video', status: 'completed' })
    expect(result.isError).toBe(true)
    expect(textOf(result)).toContain('todo_update requires the latestTodos projection')
    expect(writes(events.get(subject.id) ?? [])).toEqual([PLAN])
  } finally { projection.mockRestore() }
  expect(ctx.sessionProjections.stateOf(subject.session, 'latestTodos')).toEqual(PLAN)
})

it('presents the exact incremental change without replacing the task list', async () => {
  const { ctx } = await harness()
  const args = { task: 'generate video', status: 'completed', start_next: true }
  expect(ctx.tools.get('todo_update')?.presentCall?.(args)).toEqual({
    card: 'generic', title: 'Update todo task', kind: 'other', rawInput: args,
  })
})
