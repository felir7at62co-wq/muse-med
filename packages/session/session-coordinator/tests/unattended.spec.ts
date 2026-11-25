/** Unattended routing through the native loop: automatic re-dispatch, attention marks, schedule input and task folders. */
import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context, Service } from '@deepseek-ai/cordis'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { createUserMessage, ToolCallId } from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-schedule'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { executeToolFixture } from '@deepseek-ai/dsh-tool-testkit'
import type { JobId, JobOutcome } from '@deepseek-ai/dsh-jobs'
import { SessionId } from '@deepseek-ai/dsh-session'
import { toolCallResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import Coordinator, { type Config } from '../src/index.ts'
import { latest } from '../src/ledger.ts'
import { mainSessionPrompt } from '../src/prompt.ts'
import type { CoordinationTask, CoordinationTaskId, DispatchRequest } from '../src/types.ts'
import { setup, textResponse } from './fixture.ts'

type Script = Parameters<typeof setup>[1]

/** Answer each first delivery of an assignment with `outcome`; every other request replies with text. */
function reporting(outcome: 'completed' | 'failed' | 'needs-input', summary: string): Script {
  const reported = new Set<string>()
  return Array.from({ length: 60 }, () => (options) => {
    const assignment = options.messages.findLast(message => message.role === 'user'
      && message.source?.kind === 'muse-coordination' && message.source.purpose === 'assignment')
    if (assignment?.source?.kind === 'muse-coordination') {
      const key = `${assignment.source.taskId}:${assignment.source.revision}`
      if (!reported.has(key)) {
        reported.add(key)
        return toolCallResponse(`report-${key}`, 'coordinator_report', {
          task_id: assignment.source.taskId, revision: assignment.source.revision, outcome, summary,
        })
      }
    }
    return textResponse('ack')
  })
}

async function fixture(config: Config = {}, script: Script = Array.from({ length: 60 }, () => textResponse('ack')),
  before?: (test: Awaited<ReturnType<typeof setup>>) => void) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-unattended-'))
  const cleanup: { ctx?: Awaited<ReturnType<typeof setup>>['ctx'] } = {}
  onTestFinished(async () => {
    if (cleanup.ctx !== undefined) await cleanup.ctx.fiber.dispose()
    await rm(root, { recursive: true, force: true })
  })
  const resolved = { unattended: true, ...config, ...config.taskRoot === undefined ? {} : { taskRoot: join(root, config.taskRoot) } }
  const test = await setup(root, script, undefined, resolved)
  cleanup.ctx = test.ctx
  before?.(test)
  const main = await test.makeAgent('main', 'main-session')
  main.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: '转写红果短剧《山河》，交付剧本。' }] }))
  await main.whenIdle()
  return { ...test, main, root, taskRoot: resolved.taskRoot }
}

type Fixture = Awaited<ReturnType<typeof fixture>>

const request: DispatchRequest = { key: 'drama-1', title: '转写《山河》', instructions: '每部作品一个执行会话', reason: '新的候选作品' }

async function waitTask(test: Fixture, ready: (task: CoordinationTask) => boolean): Promise<CoordinationTask> {
  const abort = new AbortController()
  const signal = AbortSignal.any([abort.signal, AbortSignal.timeout(15000)])
  try {
    for await (const tasks of test.ctx.sessionCoordinator.watch(test.main.id, signal)) {
      const task = tasks.find(ready)
      if (task !== undefined) return task
    }
    throw new Error(`No task became ready: ${JSON.stringify(test.ctx.sessionCoordinator.list(test.main.id))}`)
  } finally { abort.abort() }
}

/** Main's receipt texts for one task, after Main has handled them. */
async function receipts(test: Fixture, id: CoordinationTaskId): Promise<string> {
  await test.main.whenIdle()
  const log = await test.ctx.sessionQuery.readSession(test.main.id)
  return log.events.flatMap(event => event.type === 'user/message' && event.data.source.kind === 'muse-coordination'
    && event.data.source.taskId === id ? event.data.content.flatMap(block => block.type === 'text' ? [block.text] : []) : []).join('\n')
}

async function forwarded(test: Fixture, sessionId: SessionId) {
  const worker = test.ctx.agents.get(sessionId)
  if (worker === undefined) throw new Error('Worker is not live')
  await worker.whenIdle()
  const log = await test.ctx.sessionQuery.readSession(sessionId)
  return log.events.flatMap(event => event.type === 'user/message'
    && (event.data.source.kind === 'user' || event.data.source.kind === 'schedule') ? [event.data] : [])
}

describe('unattended Main Session', () => {
  it('re-dispatches a worker that ended without a report to a fresh worker once, then marks the task for attention', async () => {
    const test = await fixture()
    const task = await test.service.dispatch(test.main, request)
    const marked = await waitTask(test, item => latest(item).attention !== undefined)
    expect(marked.id).toBe(task.id)
    expect(marked.attempts.map(attempt => ({ revision: attempt.revision, status: attempt.status, redispatch: attempt.redispatch })))
      .toEqual([
        { revision: 1, status: 'needs-report', redispatch: undefined },
        { revision: 2, status: 'needs-report', redispatch: { after: 'needs-report' } },
      ])
    const [first, retry] = marked.attempts
    if (first === undefined || retry === undefined) throw new Error('Expected two revisions')
    expect(retry.sessionId).not.toBe(first.sessionId)
    expect(retry.cwd).toBe(first.cwd)
    expect(retry.createSession).toBe(true)
    expect(latest(marked).attention?.reason).toMatch(/^needs-report: Worker is idle without a structured task report/u)
    const inputs = await forwarded(test, retry.sessionId)
    expect(inputs).toHaveLength(1)
    expect(JSON.stringify(inputs)).toContain('转写红果短剧《山河》')
    const notices = await receipts(test, task.id)
    expect(notices).toContain('Unattended run: nobody answers questions.')
    expect(notices).toContain('"attention":{"reason":"needs-report: ')
    expect(notices).not.toContain('relay the summary question verbatim')
    const rows = await test.service.tasks(test.main)
    expect(rows.tasks[0]?.attention?.reason).toBe(latest(marked).attention?.reason)
  })

  it('marks a needs-input report for attention without a re-dispatch when the limit is zero', async () => {
    const test = await fixture({ redispatchLimit: 0 }, reporting('needs-input', '要不要保留片头？'))
    const task = await test.service.dispatch(test.main, request)
    const marked = await waitTask(test, item => latest(item).attention !== undefined)
    expect(marked.attempts).toHaveLength(1)
    expect(latest(marked).status).toBe('needs-input')
    expect(latest(marked).attention?.reason).toBe('needs-input: 要不要保留片头？')
    const worker = await test.ctx.sessionQuery.readSession(latest(task).sessionId)
    const brief = worker.events.find(event => event.type === 'user/message' && event.data.id === latest(task).briefId)
    expect(JSON.stringify(brief)).toContain('This run is unattended: nobody answers questions here or in Main')
    expect(JSON.stringify(brief)).not.toContain('use ask_user_question here only when')
  })

  it('keeps an unattended retry on its originally confirmed Jingliu production', async () => {
    const test = await fixture()
    const project = { owner: 'studio-user', id: 'film-1', title: '雨夜' }
    let selected = project
    const inherit = vi.fn(() => { selected = { ...project, id: 'film-2' } })
    await test.ctx.plugin(class Studio extends Service {
      constructor(ctx: Context) { super(ctx, 'jingliuConnection') }
      assignmentProject() { return selected }
      inheritProject = inherit
    }).await()
    const task = await test.service.dispatch(test.main, request)
    const marked = await waitTask(test, item => item.id === task.id && latest(item).attention !== undefined)
    expect(marked.attempts).toHaveLength(2)
    expect(latest(marked)).toMatchObject({ revision: 2, studioProject: project })
    expect(inherit.mock.calls).toEqual(marked.attempts.map(attempt => [attempt.sessionId, project]))
  })

  it('re-dispatches a failed report and leaves a completed re-dispatch unmarked', async () => {
    let failures = 0
    const script: Script = Array.from({ length: 60 }, () => (options) => {
      const assignment = options.messages.findLast(message => message.role === 'user'
        && message.source?.kind === 'muse-coordination' && message.source.purpose === 'assignment')
      const answered = options.messages.some(message => message.role === 'tool')
      if (assignment?.source?.kind === 'muse-coordination' && !answered) {
        const outcome = failures++ === 0 ? 'failed' : 'completed'
        return toolCallResponse(`report-${failures}`, 'coordinator_report', {
          task_id: assignment.source.taskId, revision: assignment.source.revision, outcome, summary: `${outcome} 第${failures}次`,
        })
      }
      return textResponse('ack')
    })
    const test = await fixture({}, script)
    await test.service.dispatch(test.main, request)
    const done = await waitTask(test, item => latest(item).status === 'completed')
    expect(done.attempts.map(attempt => attempt.status)).toEqual(['failed', 'completed'])
    expect(latest(done).redispatch).toEqual({ after: 'failed' })
    expect(latest(done).attention).toBeUndefined()
  })

  it('keeps attended receipts and leaves unresolved tasks for Main', async () => {
    const test = await fixture({ unattended: false })
    const task = await test.service.dispatch(test.main, request)
    await waitTask(test, item => latest(item).notifiedStatus === 'needs-report')
    expect(test.service.list(test.main.id)[0]?.attempts).toHaveLength(1)
    expect(latest(test.service.list(test.main.id)[0]!).attention).toBeUndefined()
    expect(await receipts(test, task.id)).toContain('Relay the verified outcome and files to the user.')
  })

  it('denies questions to Main and to an assigned worker, but not to another Session', async () => {
    let asked = 0
    const test = await fixture({ redispatchLimit: 0 }, undefined, (setupTest) => {
      setupTest.ctx.tools.register(defineTool({ name: 'ask_user_question', description: 'Test question',
        parameters: { questions: { type: 'array', required: true, items: { type: 'object', additionalProperties: true, properties: {} } } },
        output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
        async execute() { asked++; return 'answered' } }))
    })
    const ask = (agent: typeof test.main) => executeToolFixture(test.ctx, { agent, name: 'ask_user_question',
      arguments: { questions: [{ id: 'q', question: '继续吗？' }] }, callId: ToolCallId(`ask-${agent.id}`), signal: new AbortController().signal })
    expect((await ask(test.main)).isError).toBe(true)
    const listed = await executeToolFixture(test.ctx, { agent: test.main, name: 'coordinator_tasks', arguments: {},
      callId: ToolCallId('main-tasks'), signal: new AbortController().signal })
    expect(listed.isError).not.toBe(true)
    expect(listed.content).toEqual([{ type: 'text', text: '{"tasks":[],"total":0,"truncated":false}' }])
    const task = await test.service.dispatch(test.main, request)
    await waitTask(test, item => latest(item).attention !== undefined)
    const worker = test.ctx.agents.get(latest(task).sessionId)!
    const denied = await ask(worker)
    expect(denied.isError).toBe(true)
    expect(JSON.stringify(denied.content)).toContain('This run is unattended and nobody answers questions.')
    expect((await ask(await test.makeAgent('ordinary'))).isError).not.toBe(true)
    const host = await executeToolFixture(test.ctx, { name: 'ask_user_question', arguments: { questions: [{ id: 'q', question: '继续吗？' }] },
      callId: ToolCallId('ask-host'), signal: new AbortController().signal })
    expect(host.isError).not.toBe(true)
    expect(asked).toBe(2)
    const tools = test.adapter.requests.at(0)?.tools?.map(tool => tool.name) ?? []
    expect(tools).toContain('coordinator_dispatch')
    expect(tools).not.toContain('ask_user_question')
  })

  it.each([true, false])('dispatches from a schedule reminder only when unattended is %s', async (unattended) => {
    const test = await fixture({ unattended, redispatchLimit: 0 }, reporting('completed', '已上传剧本'))
    test.main.followup(createUserMessage({ source: { kind: 'schedule' }, content: [{ type: 'text', text: '领取今天的候选并派发' }] }))
    await test.main.whenIdle()
    const task = await test.service.dispatch(test.main, request)
    const inputs = await forwarded(test, latest(task).sessionId)
    expect(inputs.map(input => input.source.kind)).toEqual([unattended ? 'schedule' : 'user'])
    expect(JSON.stringify(inputs)).toContain(unattended ? '领取今天的候选并派发' : '转写红果短剧《山河》')
    const done = await waitTask(test, item => latest(item).status === 'completed')
    expect(latest(done).report?.summary).toBe('已上传剧本')
  })

  it('tells Main about unattended routing and task folders in its system prompt', async () => {
    const test = await fixture({ taskRoot: 'tasks' })
    const requests = JSON.stringify(test.adapter.requests)
    expect(requests).toContain('本部署无人值守')
    expect(requests).toContain('最新一条用户消息或定时提醒')
    expect(requests).toContain('每个任务在自己的文件夹里执行，不传 cwd')
    expect(requests).not.toContain('新建的执行会话默认和你在同一工作目录')
    expect(mainSessionPrompt({ unattended: false, taskFolders: true })).toContain('需要用户选择或填写时用选择或表单卡片')
  })

  it('re-dispatches a waiting task whose worker could not start', async () => {
    const test = await fixture({ maxWorkers: 1, redispatchLimit: 1 })
    const holds = new Map<SessionId, { job: JobId; done: PromiseWithResolvers<JobOutcome> }>()
    test.ctx.on('agent/pre-step', async ({ agent }, next) => {
      if (agent !== test.main && !holds.has(agent.id) && holds.size === 0) {
        const done = Promise.withResolvers<JobOutcome>()
        const job = test.ctx.jobs.start({ kind: 'bash', label: 'held worker', owner: agent.id,
          run: () => ({ cancel() { done.resolve({ status: 'killed' }) }, done: done.promise }) })
        holds.set(agent.id, { job, done })
      }
      return next()
    })
    const first = await test.service.dispatch(test.main, request)
    const queued = await test.service.dispatch(test.main, { ...request, key: 'drama-2', title: '转写《江湖》' })
    expect(latest(queued).status).toBe('dispatching')
    const creation = vi.spyOn(test.ctx.sessionController, 'create').mockRejectedValueOnce(new Error('worker creation unavailable'))
    onTestFinished(() => { creation.mockRestore() })
    await vi.waitFor(() => { expect(holds.has(latest(first).sessionId)).toBe(true) })
    const held = holds.get(latest(first).sessionId)!
    held.done.resolve({ status: 'completed' })
    await test.ctx.jobs.wait(held.job, 15000, latest(first).sessionId)
    const retried = await waitTask(test, item => item.id === queued.id && item.attempts.length === 2 && latest(item).status !== 'dispatching')
    expect(retried.attempts[0]?.status).toBe('interrupted')
    expect(retried.attempts[0]?.issue).toContain('worker creation unavailable')
    expect(latest(retried).redispatch).toEqual({ after: 'interrupted' })
    expect(test.ctx.agents.get(latest(retried).sessionId)).toBeDefined()
  })
})

describe('unattended follow-up', () => {
  const question = (setupTest: Awaited<ReturnType<typeof setup>>, count: { value: number }) => {
    setupTest.ctx.tools.register(defineTool({ name: 'ask_user_question', description: 'Test question',
      parameters: { questions: { type: 'array', required: true, items: { type: 'object', additionalProperties: true, properties: {} } } },
      output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
      async execute() { count.value++; return 'answered' } }))
  }

  it('applies the worker denial through the subagent tree of an assigned worker', async () => {
    const count = { value: 0 }
    const test = await fixture({ redispatchLimit: 0 }, undefined, (setupTest) => { question(setupTest, count) })
    const task = await test.service.dispatch(test.main, request)
    await waitTask(test, item => latest(item).attention !== undefined)
    const worker = test.ctx.agents.get(latest(task).sessionId)!
    const handle = await test.ctx.agents.create({ sessionId: SessionId('delegated-child'),
      meta: { cwd: latest(task).cwd, origin: 'subagent', parentSession: worker.id }, agentOptions: { provider: 'mock', model: 'mock' } })
    const child = handle.agent
    const ask = () => executeToolFixture(test.ctx, { agent: child, name: 'ask_user_question',
      arguments: { questions: [{ id: 'q', question: '继续吗？' }] }, callId: ToolCallId(`ask-child-${count.value}`), signal: new AbortController().signal })
    expect((await ask()).isError).not.toBe(true)
    const root = vi.spyOn(test.ctx.subagents, 'rootOf').mockReturnValue(worker)
    onTestFinished(() => { root.mockRestore() })
    expect(JSON.stringify((await ask()).content)).toContain('This run is unattended and nobody answers questions.')
    root.mockImplementation(() => { throw new Error('subagent runtime unavailable') })
    const failed = await ask().then(result => JSON.stringify(result.content), (error: unknown) => String(error))
    expect(failed).toContain('subagent runtime unavailable')
    expect(count.value).toBe(1)
  })

  it('waits while an interrupted worker is busy and re-dispatches once its direct work is quiescent', async () => {
    const test = await fixture()
    const held = Promise.withResolvers<{ job: JobId; done: PromiseWithResolvers<JobOutcome>; owner: SessionId }>()
    let started = false
    test.ctx.on('agent/pre-step', async ({ agent }, next) => {
      if (agent !== test.main && !started) {
        started = true
        const done = Promise.withResolvers<JobOutcome>()
        const job = test.ctx.jobs.start({ kind: 'bash', label: 'held worker', owner: agent.id,
          run: () => ({ cancel() { done.resolve({ status: 'killed' }) }, done: done.promise }) })
        held.resolve({ job, done, owner: agent.id })
      }
      return next()
    })
    const task = await test.service.dispatch(test.main, request)
    const hold = await held.promise
    const worker = test.ctx.agents.get(latest(task).sessionId)!
    await worker.whenIdle()
    worker.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: '先看一下第一集' }] }))
    const interrupted = await waitTask(test, item => latest(item).notifiedStatus === 'interrupted')
    expect(interrupted.attempts).toHaveLength(1)
    expect(latest(interrupted).attention).toBeUndefined()
    hold.done.resolve({ status: 'completed' })
    await test.ctx.jobs.wait(hold.job, 15000, hold.owner)
    const retried = await waitTask(test, item => item.attempts.length === 2)
    expect(retried.attempts[0]?.status).toBe('needs-report')
    expect(latest(retried).redispatch).toEqual({ after: 'needs-report' })
  })

  it('marks an interrupted task for attention when its execution subtree cannot be verified', async () => {
    const test = await fixture({}, [
      textResponse('main'),
      () => {
        const listing = vi.spyOn(test.ctx.subagents, 'listDescendants').mockRejectedValue(new Error('catalog unavailable'))
        onTestFinished(() => { listing.mockRestore() })
        return textResponse('worker finished')
      },
      ...Array.from({ length: 20 }, () => textResponse('ack')),
    ])
    await test.service.dispatch(test.main, request)
    const marked = await waitTask(test, item => latest(item).attention !== undefined)
    expect(marked.attempts).toHaveLength(1)
    expect(latest(marked).status).toBe('interrupted')
    expect(latest(marked).attention?.reason).toContain('the execution subtree could not be verified')
    expect(latest(marked).attention?.reason).toContain('catalog unavailable')
  })

  it('marks the task for attention when its automatic re-dispatch cannot start', async () => {
    const test = await fixture()
    const creation = vi.spyOn(test.ctx.sessionController, 'create').mockRejectedValue(new Error('worker creation unavailable'))
    onTestFinished(() => { creation.mockRestore() })
    await expect(test.service.dispatch(test.main, request)).rejects.toThrow('worker creation unavailable')
    const marked = await waitTask(test, item => latest(item).attention !== undefined)
    expect(marked.attempts.map(attempt => attempt.status)).toEqual(['interrupted', 'interrupted'])
    expect(latest(marked).attention?.reason).toBe('interrupted: The automatic re-dispatch could not start: Error: worker creation unavailable')
  })

  it('marks the task for attention when its automatic re-dispatch cannot be recorded', async () => {
    const test = await fixture()
    // Hold the follow-up's first read of Main's log so the injected failure hits its revision write.
    const gate = Promise.withResolvers<undefined>()
    let armed = false
    const read = test.ctx.sessionQuery.readSession.bind(test.ctx.sessionQuery)
    const reading = vi.spyOn(test.ctx.sessionQuery, 'readSession').mockImplementation(async (id) => {
      if (armed && id === test.main.id) {
        armed = false
        await gate.promise
      }
      return read(id)
    })
    const creation = vi.spyOn(test.ctx.sessionController, 'create').mockImplementationOnce(async () => {
      armed = true
      throw new Error('worker creation unavailable')
    })
    onTestFinished(() => { creation.mockRestore(); reading.mockRestore() })
    await expect(test.service.dispatch(test.main, request)).rejects.toThrow('worker creation unavailable')
    test.pool.failNextWrites = 1
    gate.resolve(undefined)
    const marked = await waitTask(test, item => latest(item).attention !== undefined)
    expect(marked.attempts).toHaveLength(1)
    expect(latest(marked).attention?.reason).toContain('interrupted: the automatic re-dispatch could not be recorded')
    expect(latest(marked).attention?.reason).toContain('injected write failure')
  })

  it('follows up a task left unresolved before unattended mode was enabled', async () => {
    const test = await fixture({ unattended: false }, reporting('failed', '下载失败'))
    await test.service.dispatch(test.main, request)
    await waitTask(test, item => latest(item).notifiedStatus === 'failed')
    await test.fiber.dispose()
    await test.ctx.plugin(Coordinator, { unattended: true })
    const retried = await waitTask(test, item => item.attempts.length === 2 && latest(item).status === 'failed')
    expect(latest(retried).redispatch).toEqual({ after: 'failed' })
  })

  it('marks a failed dispatch for attention at once when automatic re-dispatch is disabled', async () => {
    const test = await fixture({ redispatchLimit: 0 })
    const creation = vi.spyOn(test.ctx.sessionController, 'create').mockRejectedValueOnce(new Error('worker creation unavailable'))
    onTestFinished(() => { creation.mockRestore() })
    await expect(test.service.dispatch(test.main, request)).rejects.toThrow('worker creation unavailable')
    const marked = await waitTask(test, item => latest(item).notifiedStatus === 'interrupted')
    expect(marked.attempts).toHaveLength(1)
    expect(latest(marked).attention?.reason).toBe('interrupted: Error: worker creation unavailable')
    expect(await receipts(test, marked.id)).toContain('"attention":{"reason":"interrupted: Error: worker creation unavailable"')
  })

  it('restarts the count after a Main revision and forwards every earlier Main input to the next fresh worker', async () => {
    const test = await fixture()
    const task = await test.service.dispatch(test.main, request)
    await waitTask(test, item => item.attempts.length === 2 && latest(item).attention !== undefined)
    await test.service.stop(test.main.id, task.id, 2)
    test.main.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: '片尾彩蛋也要转写。' }] }))
    await test.main.whenIdle()
    await test.service.dispatch(test.main, { ...request, key: 'drama-1-revised', taskId: task.id, expectedRevision: 2 })
    const done = await waitTask(test, item => item.attempts.length === 4 && latest(item).attention !== undefined)
    expect(done.attempts.map(attempt => attempt.redispatch?.after ?? null)).toEqual([null, 'needs-report', null, 'needs-report'])
    const inputs = await forwarded(test, latest(done).sessionId)
    expect(inputs.map(input => input.content)).toEqual([
      [{ type: 'text', text: '转写红果短剧《山河》，交付剧本。' }],
      [{ type: 'text', text: '片尾彩蛋也要转写。' }],
    ])
  })

  it('returns Main to the attended prompt when the coordinator unloads', async () => {
    const test = await fixture()
    expect(JSON.stringify(test.adapter.requests.at(-1))).toContain('本部署无人值守')
    await test.fiber.dispose()
    test.main.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: '状态如何？' }] }))
    await test.main.whenIdle()
    const last = JSON.stringify(test.adapter.requests.at(-1))
    expect(last).toContain('新建的执行会话默认和你在同一工作目录')
    expect(last).not.toContain('本部署无人值守')
  })
})

describe('task folders', () => {
  it('runs each task in its own created folder and keeps revisions there', async () => {
    const test = await fixture({ unattended: false, taskRoot: 'tasks' })
    const a = await test.service.dispatch(test.main, request)
    const b = await test.service.dispatch(test.main, { ...request, key: 'drama-2', title: '转写《江湖》' })
    const taskRoot = test.taskRoot!
    expect(latest(a).cwd).toBe(join(taskRoot, a.id))
    expect(latest(b).cwd).toBe(join(taskRoot, b.id))
    expect((await stat(latest(a).cwd)).isDirectory()).toBe(true)
    expect(test.ctx.agents.get(latest(a).sessionId)?.session.header.cwd).toBe(latest(a).cwd)
    await expect(test.service.dispatch(test.main, { ...request, key: 'drama-3', cwd: taskRoot })).rejects.toThrow('own folder; omit cwd')
    await waitTask(test, item => item.id === a.id && latest(item).status === 'needs-report')
    await expect(test.service.dispatch(test.main, { ...request, key: 'drama-4', sessionId: latest(a).sessionId }))
      .rejects.toThrow('reuse only a worker of this task')
    await test.service.stop(test.main.id, a.id, 1)
    const revised = await test.service.dispatch(test.main, { ...request, key: 'drama-1-again', taskId: a.id, expectedRevision: 1,
      sessionId: latest(a).sessionId })
    expect(latest(revised).cwd).toBe(latest(a).cwd)
    await waitTask(test, item => item.id === b.id && latest(item).status === 'needs-report')
    await test.service.stop(test.main.id, b.id, 1)
    const fresh = await test.service.dispatch(test.main, { ...request, key: 'drama-2-again', taskId: b.id, expectedRevision: 1 })
    expect(latest(fresh).sessionId).not.toBe(latest(b).sessionId)
    expect(latest(fresh).cwd).toBe(latest(b).cwd)
  })

  it('rejects a relative task root when the plugin loads', async () => {
    const test = await fixture({ unattended: false })
    await test.fiber.dispose()
    await expect(test.ctx.plugin(Coordinator, { taskRoot: 'relative/tasks' }).await()).rejects.toThrow('absolute')
  })
})
