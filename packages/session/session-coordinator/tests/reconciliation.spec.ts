/** Original-worker report recovery through real inbox admission, task storage, and native tools. */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { createUserMessage, ToolCallId } from '@deepseek-ai/dsh-llm'
import type { JobOutcome } from '@deepseek-ai/dsh-jobs'
import { executeToolFixture, executeModelToolFixture } from '@deepseek-ai/dsh-tool-testkit'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { toolCallResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import { PtcExecutor } from '../../../core/tool-executor-ptc/src/index.ts'
import { NativeToolExecutor } from '../../../core/tool-executor-native/src/index.ts'
import Coordinator from '../src/index.ts'
import { coordinationDomain, latest } from '../src/ledger.ts'
import type { AssignmentStatus, CoordinationTask, ReconcileRequest } from '../src/types.ts'
import { setup, textResponse } from './fixture.ts'

async function fixture(reports = true) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-reconciliation-'))
  const reported = new Set<string>()
  const script: Parameters<typeof setup>[1] = Array.from({ length: 100 }, () => (options) => {
    const assignment = options.messages.findLast(message => message.role === 'user'
      && message.source?.kind === 'muse-coordination' && message.source.purpose === 'assignment')
    if (reports && assignment?.source?.kind === 'muse-coordination' && assignment.source.revision > 1) {
      const key = `${assignment.source.taskId}:${assignment.source.revision}`
      if (!reported.has(key)) {
        reported.add(key)
        return toolCallResponse(`report-${assignment.source.revision}`, 'coordinator_report', {
          task_id: assignment.source.taskId, revision: assignment.source.revision, outcome: 'completed', summary: '已核对已有交付，未重复执行',
        })
      }
    }
    return textResponse('ack')
  })
  const test = await setup(root, script)
  onTestFinished(async () => { await test.ctx.fiber.dispose(); await rm(root, { recursive: true, force: true }) })
  const main = await test.makeAgent('main', 'main-session')
  main.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: '只改第二集，第三集不要动。保留 current.docx，交付 candidate.docx。' }] }))
  await main.whenIdle()
  return { ...test, main }
}

async function waitStatus(test: Awaited<ReturnType<typeof fixture>>, status: AssignmentStatus): Promise<CoordinationTask> {
  const abort = new AbortController()
  try {
    const signal = AbortSignal.any([abort.signal, AbortSignal.timeout(15000)])
    for await (const tasks of test.ctx.sessionCoordinator.watch(test.main.id, signal)) {
      const task = tasks.find(item => latest(item).status === status)
      if (task !== undefined) return task
    }
    throw new Error(`Task did not reach ${status}`)
  } finally { abort.abort() }
}

async function inputSettled(test: Awaited<ReturnType<typeof fixture>>,
  worker: Awaited<ReturnType<typeof test.makeAgent>>, inputId: string) {
  const input = (await test.ctx.sessionQuery.readSession(worker.id)).events.find(event => event.type === 'user/message' && event.data.id === inputId)
  if (input === undefined) throw new Error('Human input was not consumed')
  const abort = new AbortController()
  try {
    for await (const tasks of test.service.watch(test.main.id, AbortSignal.any([abort.signal, AbortSignal.timeout(15000)]))) {
      const attempt = latest(tasks[0]!)
      if (attempt.status === 'needs-report' && attempt.changedInputSeq === input.seq && attempt.notifiedInputSeq === input.seq
        && attempt.notifiedStatus === 'needs-report') break
    }
  } finally { abort.abort() }
  await test.main.whenIdle()
}

async function assignment(test: Awaited<ReturnType<typeof fixture>>, direct = true, cwd = '/main') {
  const task = await test.service.dispatch(test.main, {
    key: 'original', title: '修第二集', instructions: 'Revise episode 2 in a distinct candidate; preserve episode 3.', reason: '执行改稿', cwd,
  })
  await waitStatus(test, 'needs-report')
  await test.main.whenIdle()
  const worker = test.ctx.agents.get(latest(task).sessionId)!
  const input = createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: '第二集保留母女关系，先不要再生成视频。' }] })
  if (direct) {
    worker.followup(input)
    await worker.whenIdle()
    await inputSettled(test, worker, input.id)
  }
  const log = await test.ctx.sessionQuery.readSession(worker.id)
  const request = { key: 'inspect-2', taskId: task.id, expectedRevision: 1,
    expectedWorkerSeq: log.events.at(-1)!.seq, instructions: 'Inspect existing results and report only.', reason: '接管用户追加要求后的回报' } satisfies ReconcileRequest
  await expect(test.service.reconcile(test.main, { ...request, expectedRevision: 0 })).rejects.toMatchObject({ code: 'INVALID_ARGS' })
  return { task, worker, input, request }
}

async function heldCompletion(test: Awaited<ReturnType<typeof fixture>>, task: CoordinationTask) {
  await test.fiber.dispose()
  const kv = test.ctx.storage.backend.get('memory').kv
  if (kv === undefined) throw new Error('Memory backend has no KV support')
  const entered = Promise.withResolvers<undefined>()
  const release = Promise.withResolvers<undefined>()
  const open = kv.open.bind(kv)
  let held = false
  const opening = vi.spyOn(kv, 'open').mockImplementation(async (descriptor) => {
    const unit = await open(descriptor)
    const put = unit.putRecord.bind(unit)
    vi.spyOn(unit, 'putRecord').mockImplementation(async (table, key, value) => {
      if (table === 'tasks' && key === task.id && !held
        && latest(coordinationDomain.tables.tasks.valueSchema.parse(value)).status === 'completed') {
        held = true
        entered.resolve(undefined)
        await release.promise
      }
      await put(table, key, value)
    })
    return unit
  })
  onTestFinished(() => { release.resolve(undefined); opening.mockRestore() })
  const fiber = await test.ctx.plugin(Coordinator, {})
  await waitStatus(test, 'needs-report')
  return { entered, release, fiber, service: test.ctx.sessionCoordinator }
}

function wakeForSettlement(test: Awaited<ReturnType<typeof fixture>>,
  worker: Awaited<ReturnType<typeof test.makeAgent>>, task: CoordinationTask) {
  worker.followup(createUserMessage({ source: { kind: 'muse-coordination', form: 'relay', purpose: 'receipt',
    sender: test.main.id, taskId: task.id, revision: latest(task).revision },
  content: [{ type: 'text', text: 'Inspect the already reported result.' }] }))
}

describe('original worker task reconciliation', () => {
  it('keeps new human input durable and unconsumed until completion commits, without blocking a queued Main stop', async () => {
    const test = await fixture(false)
    const { task, worker } = await assignment(test, false)
    const hold = await heldCompletion(test, task)
    await hold.service.report(worker, task.id, 1, 'completed', 'Original work finished')
    wakeForSettlement(test, worker, task)
    let stopped: ReturnType<typeof hold.service.stop> | undefined
    const later = createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'A new independent request after the original work.' }] })
    try {
      await hold.entered.promise
      worker.followup(later)
      expect(await test.ctx.sessions.flush(worker.session)).toBe(true)
      expect(worker.inbox.nextTurn.map(message => message.id)).toContain(later.id)
      const log = await test.ctx.sessionQuery.readSession(worker.id)
      expect(log.events.some(event => event.type === 'user/message' && event.data.id === later.id)).toBe(false)
      expect(log.events.some(event => event.type === 'agent/inbox/spliced'
        && event.data.inserted.some(message => message.id === later.id))).toBe(true)
      stopped = hold.service.stop(test.main.id, task.id, 1)
    } finally { hold.release.resolve(undefined) }
    expect(latest(await stopped).status).toBe('completed')
    await worker.whenIdle()
    expect(latest(hold.service.list(test.main.id)[0]!).status).toBe('completed')
    const log = await test.ctx.sessionQuery.readSession(worker.id)
    expect(log.events.filter(event => event.type === 'user/message' && event.data.id === later.id)).toHaveLength(1)
  })

  it.each(['cancel', 'unload'] as const)('releases settlement admission after %s without losing pending user input', async (action) => {
    const test = await fixture(false)
    const { task, worker } = await assignment(test, false)
    const hold = await heldCompletion(test, task)
    await hold.service.report(worker, task.id, 1, 'completed', 'Original work finished')
    wakeForSettlement(test, worker, task)
    const later = createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Retain this queued request.' }] })
    let unloading: Promise<void> | undefined
    try {
      await hold.entered.promise
      worker.followup(later)
      expect(await test.ctx.sessions.flush(worker.session)).toBe(true)
      if (action === 'cancel') worker.cancel({ kind: 'user' }, { keepInbox: true })
      else unloading = hold.fiber.dispose()
      expect(worker.inbox.nextTurn.map(message => message.id)).toContain(later.id)
    } finally { hold.release.resolve(undefined) }
    await unloading
    await worker.whenIdle()
    const log = await test.ctx.sessionQuery.readSession(worker.id)
    expect(log.events.filter(event => event.type === 'user/message' && event.data.id === later.id)).toHaveLength(1)
    if (action === 'cancel') {
      await inputSettled({ ...test, service: hold.service }, worker, later.id)
      expect(latest(hold.service.list(test.main.id)[0]!).report).toBeNull()
      const main = await test.ctx.sessionQuery.readSession(test.main.id)
      expect(main.events.some(event => event.type === 'user/message' && event.data.source.kind === 'muse-coordination'
        && JSON.stringify(event.data.content).includes('"status":"completed"'))).toBe(false)
    }
  })

  it('rejects a stale completion snapshot when native input advances before the history read returns', async () => {
    const test = await fixture(false)
    const { task, worker } = await assignment(test, false)
    await test.service.report(worker, task.id, 1, 'completed', 'Report before the changed input')
    const read = test.ctx.sessionQuery.readSession.bind(test.ctx.sessionQuery)
    let changed = false
    let changedSeq: number | undefined
    vi.spyOn(test.ctx.sessionQuery, 'readSession').mockImplementation(async (...args) => {
      const snapshot = await read(...args)
      if (args[0] === worker.id && !changed && latest(test.service.list(test.main.id)[0]!).status === 'finishing') {
        changed = true
        changedSeq = worker.session.append('user/message', createUserMessage({ source: { kind: 'user' },
          content: [{ type: 'text', text: 'Native input advanced while the old snapshot was being read.' }] }), { surfaceOp: 'append' }).seq
      }
      return snapshot
    })
    wakeForSettlement(test, worker, task)
    await worker.whenIdle()
    expect(changed).toBe(true)
    await vi.waitFor(() => {
      expect(latest(test.service.list(test.main.id)[0]!)).toMatchObject({ report: null, changedInputSeq: changedSeq })
    })
    await test.main.whenIdle()
    const main = await read(test.main.id)
    expect(main.events.some(event => event.type === 'user/message' && event.data.source.kind === 'muse-coordination'
      && JSON.stringify(event.data.content).includes('"status":"completed"'))).toBe(false)
  })

  it('retains the exact human input and requests one new coordination report without replaying business commands', async () => {
    const test = await fixture()
    const { task, worker, input, request } = await assignment(test)
    const before = await test.ctx.sessionQuery.readSession(worker.id)
    const initial = latest(task)
    const [first, repeated] = await Promise.all([test.service.reconcile(test.main, request), test.service.reconcile(test.main, request)])
    expect(first.id).toBe(task.id)
    expect(repeated.attempts).toHaveLength(2)
    const completed = await waitStatus(test, 'completed')
    expect(completed.attempts[0]?.briefId).toBe(initial.briefId)
    expect(latest(completed).sessionId).toBe(worker.id)
    expect(latest(completed).messageId).toBe(input.id)
    expect(latest(completed).forwardedIds).toEqual([])
    expect(latest(completed).reconciliation?.throughSeq).toBe(request.expectedWorkerSeq)
    const after = await test.ctx.sessionQuery.readSession(worker.id)
    const beforeHumans = before.events.filter(event => event.type === 'user/message' && event.data.source.kind === 'user')
    expect(after.events.filter(event => event.type === 'user/message' && event.data.source.kind === 'user')).toEqual(beforeHumans)
    expect(after.events.filter(event => event.type === 'user/message' && event.data.id === latest(completed).briefId)).toHaveLength(1)
    expect(latest(completed).report?.summary).toContain('未重复执行')
    expect(worker.model.current()).toEqual(test.main.model.current())
    expect(worker.session.header.cwd).toBe(initial.cwd)
  })

  it('notifies Main once for each new direct human frontier without cancelling that work', async () => {
    const test = await fixture(false)
    const { worker, input } = await assignment(test)
    const second = createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: '还有一个人物称呼要核对。' }] })
    worker.followup(second)
    await worker.whenIdle()
    await inputSettled(test, worker, second.id)
    const log = await test.ctx.sessionQuery.readSession(worker.id)
    expect(log.events.some(event => event.type === 'user/message' && event.data.id === input.id)).toBe(true)
    expect(log.events.some(event => event.type === 'user/message' && event.data.id === second.id)).toBe(true)
    const owner = await test.ctx.sessionQuery.readSession(test.main.id)
    const notices = owner.events.filter(event => event.type === 'user/message' && event.data.source.kind === 'muse-coordination'
      && event.data.source.purpose === 'receipt' && JSON.stringify(event.data.content).includes('later direct human request'))
    expect(notices).toHaveLength(2)
    const ready = owner.events.filter(event => event.type === 'user/message' && event.data.source.kind === 'muse-coordination'
      && event.data.source.purpose === 'receipt' && JSON.stringify(event.data.content).includes('now quiescent'))
    expect(ready).toHaveLength(2)
  })

  it('wakes Main again when direct human work becomes quiescent after the initial busy notice', async () => {
    const test = await fixture()
    const { worker, request } = await assignment(test, false)
    const started = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    const stream = test.adapter.stream.bind(test.adapter)
    let held = false
    vi.spyOn(test.adapter, 'stream').mockImplementation(async function* (options) {
      const human = options.messages.findLast(message => message.role === 'user' && message.source?.kind === 'user')
      if (!held && JSON.stringify(human).includes('等待外部核对')) {
        held = true
        started.resolve(undefined)
        await release.promise
        yield* textResponse('外部核对结束')
        return
      }
      yield* stream(options)
    })
    const input = createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: '等待外部核对，再汇报。' }] })
    worker.followup(input)
    try {
      await started.promise
      const interrupted = await waitStatus(test, 'interrupted')
      expect(latest(interrupted).issue).toContain('Wait for the next receipt')
      await expect(test.service.reconcile(test.main, request)).rejects.toMatchObject({ code: 'INVALID_ARGS',
        message: expect.stringContaining('Worker is still busy; wait for the next receipt and do not dispatch this work again') })
      expect(worker.status).toBe('running')
    } finally { release.resolve(undefined) }
    await worker.whenIdle()
    await inputSettled(test, worker, input.id)
    const log = await test.ctx.sessionQuery.readSession(worker.id)
    await test.service.reconcile(test.main, { ...request, expectedWorkerSeq: log.events.at(-1)!.seq })
    expect(latest(await waitStatus(test, 'completed')).revision).toBe(2)
  })

  it('rejects wrong task revisions, changed history, and conflicting idempotency keys without sending another brief', async () => {
    const test = await fixture()
    const { worker, request } = await assignment(test)
    await expect(test.service.reconcile(test.main, { ...request, expectedRevision: 2 })).rejects.toMatchObject({ name: 'ToolArgsError', code: 'INVALID_ARGS' })
    await expect(test.service.reconcile(test.main, { ...request, expectedWorkerSeq: request.expectedWorkerSeq - 1 })).rejects.toMatchObject({ code: 'INVALID_ARGS' })
    await test.service.reconcile(test.main, request)
    await waitStatus(test, 'completed')
    await expect(test.service.reconcile(test.main, { ...request, reason: '另一个目标' })).rejects.toMatchObject({ code: 'INVALID_ARGS' })
    const log = await test.ctx.sessionQuery.readSession(worker.id)
    expect(log.events.filter(event => event.type === 'user/message' && event.data.source.kind === 'muse-coordination'
      && event.data.source.purpose === 'assignment')).toHaveLength(2)
  })

  it.each([1, 2])('keeps the saved intent interrupted when history read %i returns a stale snapshot after a new human request', async (raceRead) => {
    const test = await fixture(false)
    const { task, worker, request } = await assignment(test)
    const read = test.ctx.sessionQuery.readSession.bind(test.ctx.sessionQuery)
    let injected = false
    let reads = 0
    vi.spyOn(test.ctx.sessionQuery, 'readSession').mockImplementation(async (...args) => {
      const snapshot = await read(...args)
      if (!injected && args[0] === worker.id && latest(test.service.list(test.main.id)[0]!).status === 'reconciling' && ++reads === raceRead) {
        injected = true
        worker.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: '保存意图后新来的要求' }] }))
        await worker.whenIdle()
      }
      return snapshot
    })
    await expect(test.service.reconcile(test.main, request)).rejects.toMatchObject({ code: 'INVALID_ARGS' })
    const current = test.service.list(test.main.id)[0]!
    expect(current.id).toBe(task.id)
    expect(current.attempts).toHaveLength(2)
    expect(latest(current).status).toBe('interrupted')
    const log = await read(worker.id)
    expect(log.events.some(event => event.type === 'user/message' && event.data.id === latest(current).briefId)).toBe(false)
  })

  it('recovers needs-report in the original worker even when no later human input was supplied', async () => {
    const test = await fixture()
    const { task, worker, request } = await assignment(test, false)
    await test.service.reconcile(test.main, request)
    const completed = await waitStatus(test, 'completed')
    expect(latest(completed).messageId).toBe(latest(task).messageId)
    expect(latest(completed).sessionId).toBe(worker.id)
  })

  it('does not deliver a brief when saving reconciliation intent fails', async () => {
    const test = await fixture(false)
    const { worker, request } = await assignment(test)
    const before = worker.session.seq
    test.pool.failNextWrites = 1
    await expect(test.service.reconcile(test.main, request)).rejects.toThrow('injected write failure')
    expect(test.service.list(test.main.id)[0]!.attempts).toHaveLength(1)
    expect(worker.session.seq).toBe(before)
  })

  it('refuses recovery while an owned background job is live and leaves it running', async () => {
    const test = await fixture(false)
    const { worker, request } = await assignment(test)
    const done = Promise.withResolvers<JobOutcome>()
    let cancellations = 0
    const job = test.ctx.jobs.start({ kind: 'bash', label: 'direct user work', owner: worker.id,
      run: () => ({ cancel() { cancellations++ }, done: done.promise }) })
    try {
      await expect(test.service.reconcile(test.main, request)).rejects.toMatchObject({ code: 'INVALID_ARGS' })
      expect(cancellations).toBe(0)
      expect(test.ctx.jobs.get(job, worker.id).status).toBe('running')
    } finally { done.resolve({ status: 'completed' }); await test.ctx.jobs.wait(job, 15000, worker.id) }
  })

  it('refuses recovery while direct user input is queued and preserves that input', async () => {
    const test = await fixture(false)
    const { worker, request } = await assignment(test)
    const queued = createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: '仍在排队的独立工作' }] })
    worker.send(queued, 'next-turn', false)
    await expect(test.service.reconcile(test.main, request)).rejects.toMatchObject({ code: 'INVALID_ARGS' })
    expect(worker.inbox.nextTurn.map(message => message.id)).toContain(queued.id)
  })

  it('blocks business tools and program transports in report recovery, including late tools, then restores ordinary work for a new human request', async () => {
    const test = await fixture(false)
    const { worker, request } = await assignment(test)
    const executions: string[] = []
    const register = (name: string) => test.ctx.tools.register(defineTool({ name, description: `Test ${name}`, parameters: {},
      output: { schema: { type: 'string' }, render: (_args, text) => [{ type: 'text', text }] },
      async execute() { executions.push(name); return 'done' },
    }))
    for (const name of ['business_generate', 'bash', 'read', 'read_image', 'glob', 'grep', 'present']) register(name)
    await test.service.reconcile(test.main, request)
    await worker.whenIdle()
    await waitStatus(test, 'needs-report')
    register('late_generate')
    const call = (name: string) => executeModelToolFixture(test.ctx, { agent: worker, name, arguments: {},
      callId: ToolCallId(`test-${name}`), signal: new AbortController().signal })
    for (const name of ['business_generate', 'bash', 'late_generate']) {
      const result = await call(name)
      expect(result.isError).toBe(true)
      expect(result.error?.info).toMatchObject({ name: 'ToolContextUnavailableError', code: 'TOOL_CONTEXT_UNAVAILABLE' })
    }
    const release = worker.ctx.tools.setExecutor(new PtcExecutor(worker.ctx))
    try {
      const result = await executeModelToolFixture(test.ctx, { agent: worker, name: 'run_code', arguments: { code: 'throw new Error("must not run")', description: 'Blocked program' },
        callId: ToolCallId('test-program'), signal: new AbortController().signal })
      expect(result.isError).toBe(true)
      expect(result.error?.info).toMatchObject({ name: 'ToolContextUnavailableError', code: 'TOOL_CONTEXT_UNAVAILABLE' })
    } finally { release(); worker.ctx.tools.setExecutor(new NativeToolExecutor(worker.ctx)) }
    for (const name of ['read', 'read_image', 'glob', 'grep', 'present']) expect((await call(name)).isError).toBe(false)
    expect(executions).toEqual(['read', 'read_image', 'glob', 'grep', 'present'])
    worker.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: '现在明确开始另一个生成任务。' }] }))
    await worker.whenIdle()
    expect((await call('business_generate')).isError).toBe(false)
    expect(executions.at(-1)).toBe('business_generate')
  })

  it('releases the report-only guard when its owning plugin is disabled', async () => {
    const test = await fixture(false)
    const { worker, request } = await assignment(test)
    let executions = 0
    test.ctx.tools.register(defineTool({ name: 'business_generate', description: 'Test business capability', parameters: {},
      output: { schema: { type: 'string' }, render: (_args, text) => [{ type: 'text', text }] },
      async execute() { executions++; return 'done' },
    }))
    await test.service.reconcile(test.main, request)
    await worker.whenIdle()
    await waitStatus(test, 'needs-report')
    const call = () => executeModelToolFixture(test.ctx, { agent: worker, name: 'business_generate', arguments: {},
      callId: ToolCallId('guard-lifecycle'), signal: new AbortController().signal })
    expect((await call()).isError).toBe(true)
    await test.fiber.dispose()
    expect((await call()).isError).toBe(false)
    expect(executions).toBe(1)
  })

  it('keeps old and guessed reports rejected and invalidates a finishing report after new human input', async () => {
    const test = await fixture(false)
    const { task, worker, request } = await assignment(test)
    await expect(test.service.report(worker, task.id, 1, 'completed', '旧结果')).rejects.toMatchObject({ code: 'INVALID_ARGS' })
    await expect(test.service.report(worker, task.id, 2, 'completed', '猜测版本')).rejects.toMatchObject({ code: 'INVALID_ARGS' })
    await test.service.reconcile(test.main, request)
    await waitStatus(test, 'needs-report')
    await expect(test.service.report(worker, task.id, 1, 'completed', '旧版本')).rejects.toMatchObject({ code: 'INVALID_ARGS' })
    const finishing = await test.service.report(worker, task.id, 2, 'completed', '尚未发布的报告')
    expect(latest(finishing).status).toBe('finishing')
    worker.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: '报告提交后又改变要求' }] }))
    await worker.whenIdle()
    const unconfirmed = await waitStatus(test, 'needs-report')
    expect(latest(unconfirmed).report).toBeNull()
    const result = await executeToolFixture(test.ctx, { agent: worker, name: 'coordinator_report',
      arguments: { task_id: task.id, revision: 2, outcome: 'completed', summary: '过期报告' },
      callId: ToolCallId('late-report'), signal: new AbortController().signal })
    expect(result.isError).toBe(true)
    expect(result.error?.info).toMatchObject({ name: 'ToolArgsError', code: 'INVALID_ARGS' })
  })

  it('restores the current reconciliation without repeating its admitted brief or business input', async () => {
    const test = await fixture()
    const { worker, request } = await assignment(test)
    await test.service.reconcile(test.main, request)
    await waitStatus(test, 'completed')
    await test.main.whenIdle()
    const before = await test.ctx.sessionQuery.readSession(worker.id)
    const calls = test.adapter.requests.length
    await test.fiber.dispose()
    await test.ctx.plugin(Coordinator, {})
    const restored = await test.ctx.sessionCoordinator.reconcile(test.main, request)
    expect(restored.attempts).toHaveLength(2)
    expect(latest(restored).status).toBe('completed')
    expect(test.adapter.requests).toHaveLength(calls)
    expect((await test.ctx.sessionQuery.readSession(worker.id)).events).toEqual(before.events)
  })

  it('recovers a crash after brief consumption without submitting that reconciliation again', async () => {
    const test = await fixture()
    const { worker, request } = await assignment(test)
    await test.service.reconcile(test.main, request)
    const completed = await waitStatus(test, 'completed')
    await test.main.whenIdle()
    const before = await test.ctx.sessionQuery.readSession(worker.id)
    const workerCalls = () => test.adapter.requests.filter(options => options.messages.some(message => message.role === 'user'
      && message.source?.kind === 'muse-coordination' && message.source.purpose === 'assignment')).length
    const calls = workerCalls()
    await test.fiber.dispose()
    const stored: CoordinationTask = { ...completed, attempts: [...completed.attempts.slice(0, -1), {
      ...latest(completed), status: 'reconciling', report: null, notifiedStatus: null,
    }] }
    test.pool.media.get('muse_coordination')!.tables.get('tasks')!.set(stored.id, stored)
    await test.ctx.plugin(Coordinator, {})
    const unconfirmed = await waitStatus(test, 'needs-report')
    expect(latest(unconfirmed).revision).toBe(2)
    expect(workerCalls()).toBe(calls)
    expect((await test.ctx.sessionQuery.readSession(worker.id)).events).toEqual(before.events)
  })

  it('recovers a durable intent with no brief exactly once after restart', async () => {
    const test = await fixture()
    const { task, worker, request } = await assignment(test)
    const original = latest(test.service.list(test.main.id)[0]!)
    const human = (await test.ctx.sessionQuery.readSession(worker.id)).events.findLast(event => event.type === 'user/message' && event.data.source.kind === 'user')!
    if (human.type !== 'user/message') throw new Error('Worker human input missing')
    const stored: CoordinationTask = { ...task, attempts: [original, { ...original,
      revision: 2, key: request.key, requestHash: 'a'.repeat(64), instructions: request.instructions, reason: request.reason,
      briefId: createUserMessage({ source: { kind: 'user' }, content: [] }).id,
      noticeId: createUserMessage({ source: { kind: 'user' }, content: [] }).id,
      messageId: human.data.id, forwardedIds: [], createSession: false, status: 'reconciling', report: null, issue: null,
      notifiedStatus: null, reconciliation: { throughSeq: request.expectedWorkerSeq, humanSeq: human.seq, humanMessageId: human.data.id },
    }] }
    await test.fiber.dispose()
    test.pool.media.get('muse_coordination')!.tables.get('tasks')!.set(stored.id, stored)
    await test.ctx.plugin(Coordinator, {})
    const completed = await waitStatus(test, 'completed')
    expect(latest(completed).sessionId).toBe(worker.id)
    const log = await test.ctx.sessionQuery.readSession(worker.id)
    expect(log.events.filter(event => event.type === 'user/message' && event.data.id === latest(stored).briefId)).toHaveLength(1)
  })

  it('removes only an obsolete pending reconciliation on recovery after a newer human message was consumed', async () => {
    const test = await fixture(false)
    const { task, worker, input, request } = await assignment(test)
    const anchor = (await test.ctx.sessionQuery.readSession(worker.id)).events.find(event => event.type === 'user/message' && event.data.id === input.id)!
    const brief = createUserMessage({ source: { kind: 'muse-coordination', form: 'relay', purpose: 'assignment', sender: test.main.id, taskId: task.id, revision: 2 },
      content: [{ type: 'text', text: 'An obsolete pending report request' }] })
    const newer = createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: '这是另一个已经开始的任务。' }] })
    worker.followup(newer)
    await worker.whenIdle()
    await inputSettled(test, worker, newer.id)
    const original = latest(test.service.list(test.main.id)[0]!)
    worker.send(brief, 'next-turn', false)
    const queued = createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: '还需要保留这个排队任务。' }] })
    worker.send(queued, 'next-turn', false)
    await test.ctx.sessions.flush(worker.session)
    const stored: CoordinationTask = { ...task, attempts: [original, { ...original,
      revision: 2, key: request.key, requestHash: 'a'.repeat(64), instructions: request.instructions, reason: request.reason,
      briefId: brief.id, messageId: input.id, noticeId: createUserMessage({ source: { kind: 'user' }, content: [] }).id,
      forwardedIds: [], createSession: false, status: 'reconciling', report: null, issue: null, notifiedStatus: null,
      reconciliation: { throughSeq: request.expectedWorkerSeq, humanSeq: anchor.seq, humanMessageId: input.id },
    }] }
    await test.fiber.dispose()
    test.pool.media.get('muse_coordination')!.tables.get('tasks')!.set(stored.id, stored)
    const wake = vi.spyOn(worker, 'wakePending')
    await test.ctx.plugin(Coordinator, {})
    await waitStatus(test, 'interrupted')
    expect(wake).not.toHaveBeenCalled()
    expect(worker.inbox.nextTurn.map(message => message.id)).toEqual([queued.id])
    expect(worker.status).toBe('idle')
  })

  it('keeps each original human relative reference bound to the directory active at its event', async () => {
    const test = await fixture()
    const { task, worker, request } = await assignment(test, false, '/canonical')
    worker.session.append('working-directory/change', { cwd: '/source-at-input' })
    const input = createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: '使用 notes/第二集.docx 作为补充资料。' }] })
    worker.followup(input)
    await worker.whenIdle()
    await inputSettled(test, worker, input.id)
    worker.session.append('working-directory/change', { cwd: '/changed-after-input' })
    await test.ctx.sessions.flush(worker.session)
    const current = await test.ctx.sessionQuery.readSession(worker.id)
    await test.service.reconcile(test.main, { ...request, expectedWorkerSeq: current.events.at(-1)!.seq })
    await waitStatus(test, 'completed')
    await test.main.whenIdle()
    const continued = await test.service.dispatch(test.main, { key: 'directory-continue', title: task.title,
      taskId: task.id, expectedRevision: 2, instructions: 'Continue with each original input directory.', reason: '继续核对后的工作' })
    const fresh = test.ctx.agents.get(latest(continued).sessionId)!
    await fresh.whenIdle()
    const log = await test.ctx.sessionQuery.readSession(fresh.id)
    const human = log.events.find(event => event.type === 'user/message' && JSON.stringify(event.data.content) === JSON.stringify(input.content))
    const brief = log.events.find(event => event.type === 'user/message' && event.data.id === latest(continued).briefId)
    if (human?.type !== 'user/message' || brief?.type !== 'user/message') throw new Error('Forwarded input missing')
    const text = brief.data.content.filter(block => block.type === 'text').map(block => block.text).join('\n')
    const sources = text.split('\n').find(line => line.startsWith('Human input sources: '))!.slice('Human input sources: '.length)
    expect(JSON.parse(sources)).toContainEqual(expect.objectContaining({ forwardedId: human.data.id, sessionId: worker.id, cwd: '/source-at-input' }))
  })

  it('retains worker-side human requirements when continuing a reconciled goal in another Session', async () => {
    const test = await fixture()
    const { task, input, request } = await assignment(test, true, '/worker-source')
    await test.service.reconcile(test.main, request)
    await waitStatus(test, 'completed')
    await test.main.whenIdle()
    test.main.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: '继续处理第二集，母女关系沿用已核对的版本。' }] }))
    await test.main.whenIdle()
    const continued = await test.service.dispatch(test.main, { key: 'continue-3', title: '继续第二集', instructions: 'Continue with preserved requirements.',
      reason: '新的执行阶段', taskId: task.id, expectedRevision: 2 })
    const worker = test.ctx.agents.get(latest(continued).sessionId)!
    await worker.whenIdle()
    const log = await test.ctx.sessionQuery.readSession(worker.id)
    const humans = log.events.filter(event => event.type === 'user/message' && event.data.source.kind === 'user')
    expect(humans.some(event => event.type === 'user/message' && JSON.stringify(event.data.content) === JSON.stringify(input.content)
      && JSON.stringify(event.data.source) === JSON.stringify(input.source))).toBe(true)
    expect(JSON.stringify(humans)).toContain('第三集不要动')
    expect(JSON.stringify(humans)).toContain('继续处理第二集')
    const brief = log.events.find(event => event.type === 'user/message' && event.data.id === latest(continued).briefId)
    expect(JSON.stringify(brief)).toContain('/worker-source')
    expect(JSON.stringify(brief)).toContain('Human input sources')
  })

  it('reconciles from the recorded worker position when Main supplies none', async () => {
    const test = await fixture()
    const { task, worker, request } = await assignment(test)
    const through = (await test.ctx.sessionQuery.readSession(worker.id)).events.at(-1)!.seq
    const unchecked: ReconcileRequest = { key: request.key, taskId: task.id, expectedRevision: 1, instructions: request.instructions, reason: request.reason }
    const first = await test.service.reconcile(test.main, unchecked)
    expect(first.id).toBe(task.id)
    const completed = await waitStatus(test, 'completed')
    expect(latest(completed).revision).toBe(2)
    expect(latest(completed).reconciliation?.throughSeq).toBe(through)
    const repeated = await test.service.reconcile(test.main, unchecked)
    expect(repeated.id).toBe(task.id)
    expect(repeated.attempts).toHaveLength(2)
  })

  it('reconciles a producer-unconfirmed interruption without re-flagging the old settlement', async () => {
    const test = await fixture()
    const { task, worker, request } = await assignment(test, false)
    test.ctx.jobs.start({ kind: 'bash', label: 'crashing producer', owner: worker.id,
      run: () => ({ cancel() {}, done: Promise.reject(new Error('producer crashed')) }) })
    await waitStatus(test, 'interrupted')
    await test.main.whenIdle()
    await test.service.reconcile(test.main, { key: 'inspect-after-job', taskId: task.id, expectedRevision: 1,
      instructions: request.instructions, reason: request.reason })
    expect(latest(await waitStatus(test, 'completed')).revision).toBe(2)
  })

  it('tells Main not to reconcile again when a reconciliation ends without a report', async () => {
    const test = await fixture(false)
    const { worker, request } = await assignment(test, false)
    expect(latest(test.service.list(test.main.id)[0]!).issue).toContain('completion is unconfirmed')
    await test.service.reconcile(test.main, request)
    await worker.whenIdle()
    let issue: string | null | undefined
    const abort = new AbortController()
    try {
      for await (const tasks of test.service.watch(test.main.id, AbortSignal.any([abort.signal, AbortSignal.timeout(15000)]))) {
        const attempt = latest(tasks[0]!)
        if (attempt.revision === 2 && attempt.status === 'needs-report') { issue = attempt.issue; break }
      }
    } finally { abort.abort() }
    expect(issue).toContain('tell the user and do not reconcile again automatically')
    expect(JSON.stringify(test.adapter.requests)).toContain('不再自动核对')
  })

  it('keeps a recovered reconciliation accepted while its brief is still pending', async () => {
    const test = await fixture()
    const { task, worker, input, request } = await assignment(test)
    const anchor = (await test.ctx.sessionQuery.readSession(worker.id)).events.find(event => event.type === 'user/message' && event.data.id === input.id)!
    const brief = createUserMessage({ source: { kind: 'muse-coordination', form: 'relay', purpose: 'assignment', sender: test.main.id, taskId: task.id, revision: 2 },
      content: [{ type: 'text', text: 'Pending report request' }] })
    worker.send(brief, 'next-turn', false)
    await test.ctx.sessions.flush(worker.session)
    const through = (await test.ctx.sessionQuery.readSession(worker.id)).events.at(-1)!.seq
    const original = latest(test.service.list(test.main.id)[0]!)
    const stored: CoordinationTask = { ...task, attempts: [original, { ...original,
      revision: 2, key: request.key, requestHash: 'a'.repeat(64), instructions: request.instructions, reason: request.reason,
      briefId: brief.id, messageId: input.id, noticeId: createUserMessage({ source: { kind: 'user' }, content: [] }).id,
      forwardedIds: [], createSession: false, status: 'accepted', report: null, issue: null, notifiedStatus: null,
      reconciliation: { throughSeq: through, humanSeq: anchor.seq, humanMessageId: input.id },
    }] }
    await test.fiber.dispose()
    test.pool.media.get('muse_coordination')!.tables.get('tasks')!.set(stored.id, stored)
    await test.ctx.plugin(Coordinator, {})
    await expect(test.ctx.sessionCoordinator.report(worker, task.id, 1, 'completed', 'stale')).rejects.toMatchObject({ code: 'INVALID_ARGS' })
    expect(latest(test.ctx.sessionCoordinator.list(test.main.id)[0]!).status).toBe('accepted')
    worker.wakePending?.(brief.id)
    expect(latest(await waitStatus(test, 'completed')).revision).toBe(2)
  })
})
