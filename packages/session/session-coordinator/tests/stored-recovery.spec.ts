/** Recovery and continuation from stored task records whose worker inputs are pending, spliced, consumed or inconsistent. */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { MessageId, UserMessage } from '@deepseek-ai/dsh-llm'
import type { JobOutcome } from '@deepseek-ai/dsh-jobs'
import { brandString } from '@deepseek-ai/dsh-brand'
import { SessionId } from '@deepseek-ai/dsh-session'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import type { SessionRequestId } from '@deepseek-ai/dsh-api-session-controller/types'
import { toolCallResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import Coordinator, { type Config } from '../src/index.ts'
import { latest, revise } from '../src/ledger.ts'
import type { CoordinationTask, CoordinationTaskId, DispatchRequest, ReconcileRequest } from '../src/types.ts'
import { setup, textResponse } from './fixture.ts'

type Script = Parameters<typeof setup>[1]

/** Report `completed` once for each assignment revision at or above `from`; reply with text otherwise. */
function reportingFrom(from: number): Script {
  const reported = new Set<string>()
  return Array.from({ length: 80 }, () => (options) => {
    const assignment = options.messages.findLast(message => message.role === 'user'
      && message.source?.kind === 'muse-coordination' && message.source.purpose === 'assignment')
    if (assignment?.source?.kind === 'muse-coordination' && assignment.source.revision >= from) {
      const key = `${assignment.source.taskId}:${assignment.source.revision}`
      if (!reported.has(key)) {
        reported.add(key)
        return toolCallResponse(`report-${key}`, 'coordinator_report', {
          task_id: assignment.source.taskId, revision: assignment.source.revision, outcome: 'completed', summary: '已核对已有结果',
        })
      }
    }
    return textResponse('ack')
  })
}

async function fixture(config: Config = {}, script: Script = reportingFrom(2)) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-coordination-recovery-'))
  const cleanup: { ctx?: Context } = {}
  onTestFinished(async () => {
    if (cleanup.ctx !== undefined) await cleanup.ctx.fiber.dispose()
    await rm(root, { recursive: true, force: true })
  })
  const test = await setup(root, script, undefined, config)
  cleanup.ctx = test.ctx
  const main = await test.makeAgent('main', 'main-session')
  main.followup(humanInput('只改第二集，第三集不要动。'))
  await main.whenIdle()
  return { ...test, main, root, lifecycle: { fiber: test.fiber } }
}

type Fixture = Awaited<ReturnType<typeof fixture>>

const request: DispatchRequest = { key: 'goal-1', title: '修改第二集', instructions: 'Revise episode 2 only.', reason: '已有稿件' }

function humanInput(text: string): UserMessage {
  return createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text }] })
}

const fresh = (): MessageId => createUserMessage({ source: { kind: 'user' }, content: [] }).id

function brief(test: Fixture, task: CoordinationTask, id: MessageId, revision: number): UserMessage {
  return { ...createUserMessage({ source: { kind: 'muse-coordination', form: 'relay', purpose: 'assignment', sender: test.main.id,
    taskId: task.id, revision }, content: [{ type: 'text', text: 'Recorded assignment brief' }] }), id }
}

function current(test: Fixture, id: CoordinationTaskId): CoordinationTask {
  const task = test.ctx.sessionCoordinator.list(test.main.id).find(item => item.id === id)
  if (task === undefined) throw new Error(`Task ${id} is missing`)
  return task
}

/** Unload the coordinator, replace stored tasks, then load it again; recovery starts at load. */
async function restart(test: Fixture, tasks: readonly CoordinationTask[], config: Config = {}): Promise<void> {
  await test.lifecycle.fiber.dispose()
  const stored = test.pool.media.get('muse_coordination')!.tables.get('tasks')!
  for (const task of tasks) stored.set(task.id, task)
  test.lifecycle.fiber = await test.ctx.plugin(Coordinator, config)
}

/** Resolve after every coordinator operation queued before this call has finished. */
async function drained(test: Fixture): Promise<void> {
  await test.ctx.sessionCoordinator.stop(test.main.id, brandString<CoordinationTaskId>('task-barrier'), 1).catch(() => undefined)
}

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

/** Dispatch one goal to a fresh worker and wait until Main has received its needs-report receipt. */
async function settledAssignment(test: Fixture, changes: Partial<DispatchRequest> = {}) {
  const task = await test.ctx.sessionCoordinator.dispatch(test.main, { ...request, ...changes })
  const settled = await waitTask(test, item => item.id === task.id && latest(item).notifiedStatus === 'needs-report')
  await test.main.whenIdle()
  const worker = test.ctx.agents.get(latest(task).sessionId)
  if (worker === undefined) throw new Error('Worker is not live')
  return { task: settled, worker }
}

/** Start a job owned by `owner` that keeps it busy until the returned release runs. */
function holdJob(test: Fixture, owner: SessionId) {
  const done = Promise.withResolvers<JobOutcome>()
  let cancellations = 0
  test.ctx.jobs.start({ kind: 'bash', label: 'held work', owner,
    run: () => ({ cancel() { cancellations++; done.resolve({ status: 'killed' }) }, done: done.promise }) })
  onTestFinished(() => { done.resolve({ status: 'completed' }) })
  return { cancellations: () => cancellations }
}

async function workerEvents(test: Fixture, id: SessionId) {
  return (await test.ctx.sessionQuery.readSession(id)).events
}

describe('stored ordinary assignments', () => {
  it('cancels a busy worker whose assignment input was never consumed', async () => {
    const test = await fixture()
    const { task, worker } = await settledAssignment(test)
    const unconsumed = fresh()
    const held = holdJob(test, worker.id)
    await restart(test, [revise(task, { status: 'accepted', messageId: unconsumed, forwardedIds: [unconsumed], notifiedStatus: null })])
    const receipt = await test.ctx.sessionCoordinator.stop(test.main.id, task.id, 1)
    expect(['stopping', 'stopped']).toContain(latest(receipt).status)
    expect(held.cancellations()).toBe(1)
    expect(latest(await waitTask(test, item => latest(item).status === 'stopped')).issue).toBeNull()
  })

  it('settles an unconsumed assignment, refuses its report and ignores later worker input for it', async () => {
    const test = await fixture()
    const { task, worker } = await settledAssignment(test)
    const unconsumed = fresh()
    await restart(test, [revise(task, { status: 'accepted', messageId: unconsumed, forwardedIds: [unconsumed], notifiedStatus: null, issue: null })])
    const settled = await waitTask(test, item => latest(item).notifiedStatus === 'needs-report')
    expect(latest(settled).issue).toBe('Worker is idle without a structured task report; completion is unconfirmed')
    await expect(test.ctx.sessionCoordinator.report(worker, task.id, 1, 'completed', 'done'))
      .rejects.toThrow('Assignment input has not been consumed')
    worker.session.append('user/message', humanInput('另一项直接要求'), { surfaceOp: 'append' })
    await drained(test)
    expect(latest(current(test, task.id)).status).toBe('needs-report')
    expect(latest(current(test, task.id)).changedInputSeq).toBeUndefined()
  })

  it('refuses a report before the current revision brief was consumed', async () => {
    const test = await fixture()
    const { task, worker } = await settledAssignment(test)
    await restart(test, [revise(task, { briefId: fresh() })])
    await drained(test)
    await expect(test.ctx.sessionCoordinator.report(worker, task.id, 1, 'completed', 'done'))
      .rejects.toThrow('The current revision coordination brief has not been consumed')
  })

  it('settles an idle worker whose inbox holds only unrelated input and leaves that input pending', async () => {
    const test = await fixture()
    const { task, worker } = await settledAssignment(test)
    const unrelated = humanInput('排队中的另一项工作')
    worker.send(unrelated, 'next-turn', false)
    await restart(test, [revise(task, { status: 'accepted', notifiedStatus: null })])
    const settled = await waitTask(test, item => latest(item).notifiedStatus === 'needs-report')
    expect(latest(settled).status).toBe('needs-report')
    expect(worker.inbox.nextTurn.map(message => message.id)).toEqual([unrelated.id])
  })
})

describe('stored dispatch intents', () => {
  it('keeps a recovered dispatch accepted while its spliced input is still pending, without resending it', async () => {
    const test = await fixture()
    const { task, worker } = await settledAssignment(test)
    const [briefId, inputId] = [fresh(), fresh()]
    worker.send(brief(test, task, briefId, 1), 'next-turn', false)
    worker.send({ ...humanInput('已入队的原始要求'), id: inputId }, 'next-turn', false)
    await test.ctx.sessions.flush(worker.session)
    await restart(test, [revise(task, { status: 'dispatching', briefId, messageId: inputId, forwardedIds: [inputId], notifiedStatus: null, issue: null })])
    const recovered = await waitTask(test, item => latest(item).status === 'accepted')
    expect(latest(recovered).issue).toBeNull()
    await drained(test)
    expect(worker.inbox.nextTurn.map(message => message.id)).toEqual([briefId, inputId])
    expect((await workerEvents(test, worker.id)).some(event => event.type === 'user/message'
      && (event.data.id === briefId || event.data.id === inputId))).toBe(false)
  })

  it('marks a recovered dispatch interrupted when its spliced input is no longer pending', async () => {
    const test = await fixture()
    const { task, worker } = await settledAssignment(test)
    const [briefId, inputId] = [fresh(), fresh()]
    worker.send(brief(test, task, briefId, 1), 'next-turn', false)
    worker.send({ ...humanInput('已入队又被移除的要求'), id: inputId }, 'next-turn', false)
    await test.ctx.sessions.flush(worker.session)
    worker.inbox.remove(briefId)
    worker.inbox.remove(inputId)
    holdJob(test, worker.id)
    await restart(test, [revise(task, { status: 'dispatching', briefId, messageId: inputId, forwardedIds: [inputId], notifiedStatus: null, issue: null })])
    const recovered = await waitTask(test, item => latest(item).status === 'interrupted')
    expect(latest(recovered).issue).toBe('A durable input receipt exists; inspect the worker before explicitly continuing. Nothing was resent.')
  })

  it('keeps a recovered dispatch interrupted without sending when its worker became busy', async () => {
    const test = await fixture()
    const { task, worker } = await settledAssignment(test)
    const [briefId, inputId] = [fresh(), fresh()]
    holdJob(test, worker.id)
    await restart(test, [revise(task, { status: 'dispatching', briefId, messageId: inputId, forwardedIds: [inputId], notifiedStatus: null, issue: null })])
    const recovered = await waitTask(test, item => latest(item).status === 'interrupted')
    expect(latest(recovered).issue).toBe('Error: Worker became busy before dispatch; intent retained without sending')
    expect((await workerEvents(test, worker.id)).some(event => event.type === 'user/message' && event.data.id === briefId)).toBe(false)
  })

  it('refuses to deliver a recovered revision that has fewer delivery identities than human inputs', async () => {
    const test = await fixture()
    const { task } = await settledAssignment(test)
    await test.ctx.sessionCoordinator.stop(test.main.id, task.id, 1)
    await waitTask(test, item => latest(item).notifiedStatus === 'stopped')
    test.main.followup(humanInput('继续，第三集仍然不要动。'))
    await test.main.whenIdle()
    await test.ctx.sessionCoordinator.dispatch(test.main, { ...request, key: 'goal-1-revision-2', taskId: task.id, expectedRevision: 1 })
    const revised = await waitTask(test, item => latest(item).revision === 2 && latest(item).notifiedStatus === 'completed')
    await test.main.whenIdle()
    const only = fresh()
    await restart(test, [revise(revised, { status: 'dispatching', briefId: fresh(), messageId: only, forwardedIds: [only],
      report: null, notifiedStatus: null, issue: null })])
    const recovered = await waitTask(test, item => latest(item).status === 'interrupted')
    expect(latest(recovered).issue).toBe('Error: Original verified human request or its delivery identity is unavailable')
    expect((await workerEvents(test, latest(revised).sessionId)).some(event => event.type === 'user/message'
      && event.data.id === latest(recovered).briefId)).toBe(false)
  })
})

describe('waiting fresh workers after restart', () => {
  /** Hold the first non-Main Agent with a job until the test ends. */
  function holdFirstWorker(test: Fixture) {
    let held = false
    test.ctx.on('agent/pre-step', async ({ agent }, next) => {
      if (!held && agent !== test.main) {
        held = true
        holdJob(test, agent.id)
      }
      return next()
    })
  }

  it('starts waiting tasks recorded in the same millisecond in task id order', async () => {
    const test = await fixture({ maxWorkers: 1 })
    holdFirstWorker(test)
    const first = await test.ctx.sessionCoordinator.dispatch(test.main, request)
    const queued = [
      await test.ctx.sessionCoordinator.dispatch(test.main, { ...request, key: 'goal-2', title: '第二项' }),
      await test.ctx.sessionCoordinator.dispatch(test.main, { ...request, key: 'goal-3', title: '第三项' }),
    ]
    expect(queued.map(task => latest(task).status)).toEqual(['dispatching', 'dispatching'])
    const created: SessionId[] = []
    test.ctx.on('agent/created', ({ agent }) => { created.push(agent.id) })
    await restart(test, [
      revise(current(test, first.id), { status: 'stopped', notifiedStatus: 'stopped' }),
      ...queued.map(task => ({ ...current(test, task.id), createdAt: 1 })),
    ], { maxWorkers: 1 })
    for (const task of queued) await waitTask(test, item => item.id === task.id && latest(item).status === 'needs-report')
    const ordered = queued.toSorted((a, b) => Number(a.id > b.id) - Number(a.id < b.id))
    expect(created).toEqual(ordered.map(task => latest(task).sessionId))
  })

  it('logs a waiting task whose start failure cannot be delivered to Main after recovery', async () => {
    const test = await fixture({ maxWorkers: 1 })
    holdFirstWorker(test)
    const first = await test.ctx.sessionCoordinator.dispatch(test.main, request)
    const queued = await test.ctx.sessionCoordinator.dispatch(test.main, { ...request, key: 'goal-2', title: '第二项' })
    const errors: string[] = []
    test.ctx.logger.exporter({ levels: { default: 0 }, export: ({ type, args }) => { if (type === 'error') errors.push(args.map(String).join(' ')) } })
    vi.spyOn(test.ctx.sessionController, 'create').mockRejectedValue(new Error('worker creation unavailable'))
    const resolve = test.ctx.sessionController.resolveAgent.bind(test.ctx.sessionController)
    vi.spyOn(test.ctx.sessionController, 'resolveAgent').mockImplementation(async id => id !== test.main.id ? resolve(id)
      : { error: new RemoteError('session/agent-busy', 'Main is held elsewhere', { reason: 'test' }) })
    await restart(test, [revise(current(test, first.id), { status: 'stopped', notifiedStatus: 'stopped' })], { maxWorkers: 1 })
    const failed = await waitTask(test, item => item.id === queued.id && latest(item).status === 'interrupted')
    expect(latest(failed)).toMatchObject({ notifiedStatus: null,
      issue: 'The waiting task could not start: Error: worker creation unavailable. Do not reconcile; stop this task, then dispatch it again.' })
    await vi.waitFor(() => {
      expect(errors.some(line => line.includes('starting a waiting task after recovery failed') && line.includes('Main is held elsewhere'))).toBe(true)
    })
  })
})

describe('stored unattended reports', () => {
  it('marks a reported failure whose worker is gone as interrupted and for attention', async () => {
    const test = await fixture()
    const { task } = await settledAssignment(test)
    await restart(test, [revise(task, { status: 'failed', sessionId: SessionId('session-gone'), issue: null, notifiedStatus: 'failed',
      report: { outcome: 'failed', summary: '下载失败', files: [], throughSeq: 0 } })], { unattended: true, redispatchLimit: 0 })
    const marked = await waitTask(test, item => latest(item).attention !== undefined)
    expect(latest(marked)).toMatchObject({ status: 'interrupted', report: null,
      issue: 'Worker became unavailable before its report was published; inspect before continuing.' })
    expect(latest(marked).attention?.reason).toBe('interrupted: Worker became unavailable before its report was published; inspect before continuing.')
  })
})

describe('stored continuation history', () => {
  it('refuses to continue a task whose recorded Main request is no longer a human message', async () => {
    const test = await fixture()
    const { task } = await settledAssignment(test)
    await test.ctx.sessionCoordinator.stop(test.main.id, task.id, 1)
    const stopped = await waitTask(test, item => latest(item).notifiedStatus === 'stopped')
    await test.main.whenIdle()
    const reply = (await workerEvents(test, test.main.id)).find(event => event.type === 'assistant/message')!
    await restart(test, [revise(stopped, { sourceSeq: reply.seq })])
    await expect(test.ctx.sessionCoordinator.dispatch(test.main, { ...request, key: 'continue', taskId: task.id, expectedRevision: 1 }))
      .rejects.toThrow('Original verified Main human request is unavailable')
    expect(current(test, task.id).attempts).toHaveLength(1)
  })

  it.each([
    ['its predecessor ran in another Session', 'Reconciled worker history has no matching predecessor',
      (task: CoordinationTask): CoordinationTask => ({ ...task, attempts: [{ ...task.attempts[0]!, sessionId: SessionId('session-elsewhere') }, latest(task)] })],
    ['its recorded human input position is gone', 'Original reconciled worker human input is unavailable',
      (task: CoordinationTask): CoordinationTask => revise(task, { reconciliation: { ...latest(task).reconciliation!, humanSeq: 0 } })],
  ] as const)('refuses to continue a reconciled task when %s', async (_case, message, corrupt) => {
    const test = await fixture()
    const { task } = await settledAssignment(test)
    await test.ctx.sessionCoordinator.reconcile(test.main, { key: 'inspect', taskId: task.id, expectedRevision: 1,
      instructions: 'Inspect the existing result.', reason: '核对' })
    const completed = await waitTask(test, item => latest(item).revision === 2 && latest(item).notifiedStatus === 'completed')
    await test.main.whenIdle()
    await restart(test, [corrupt(completed)])
    await expect(test.ctx.sessionCoordinator.dispatch(test.main, { ...request, key: 'continue', taskId: task.id, expectedRevision: 2 }))
      .rejects.toThrow(message)
    expect(current(test, task.id).attempts).toHaveLength(2)
  })
})

describe('reconciliation preconditions', () => {
  const inspect = (task: CoordinationTask): ReconcileRequest => ({ key: 'inspect', taskId: task.id, expectedRevision: latest(task).revision,
    instructions: 'Inspect the existing result.', reason: '核对' })

  it('reconciles only needs-report or interrupted assignments', async () => {
    const test = await fixture({}, reportingFrom(1))
    const task = await test.ctx.sessionCoordinator.dispatch(test.main, request)
    const completed = await waitTask(test, item => latest(item).status === 'completed')
    await expect(test.ctx.sessionCoordinator.reconcile(test.main, inspect(completed)))
      .rejects.toThrow('Only needs-report or interrupted assignments can be reconciled')
    expect(current(test, task.id).attempts).toHaveLength(1)
  })

  it('rejects reconciliation when the worker Agent cannot be resolved', async () => {
    const test = await fixture()
    const { task } = await settledAssignment(test)
    vi.spyOn(test.ctx.sessionController, 'resolveAgent')
      .mockResolvedValue({ error: new RemoteError('session/agent-busy', 'Worker is held elsewhere', { reason: 'test' }) })
    await expect(test.ctx.sessionCoordinator.reconcile(test.main, inspect(task))).rejects.toThrow('Worker is held elsewhere')
    expect(current(test, task.id).attempts).toHaveLength(1)
  })

  it.each([
    ['the worker history', 'Worker history is unavailable', (_test: Fixture, worker: SessionId) => worker],
    ['Main\'s owner request', 'A retained Main owner request is required', (test: Fixture) => test.main.id],
  ] as const)('rejects reconciliation when %s cannot be read back', async (_case, message, target) => {
    const test = await fixture()
    const { task, worker } = await settledAssignment(test)
    const id = target(test, worker.id)
    const read = test.ctx.sessionQuery.readSession.bind(test.ctx.sessionQuery)
    let reads = 0
    vi.spyOn(test.ctx.sessionQuery, 'readSession').mockImplementation(async (...args) => {
      const snapshot = await read(...args)
      return args[0] === id && ++reads === 2 ? { ...snapshot, events: id === worker.id ? []
        : snapshot.events.filter(event => event.type !== 'user/message') } : snapshot
    })
    await expect(test.ctx.sessionCoordinator.reconcile(test.main, inspect(task))).rejects.toThrow(message)
    expect(current(test, task.id).attempts).toHaveLength(1)
  })

  it('refuses worker input from another principal, whether it is the latest input or an earlier one', async () => {
    const test = await fixture()
    const { task, worker } = await settledAssignment(test)
    const guest = createUserMessage({ source: { kind: 'user', rpcId: brandString<SessionRequestId>('rpc-guest'), principal: { kind: 'owner' } },
      content: [{ type: 'text', text: '来自共享查看者的要求' }] })
    worker.session.append('user/message', guest, { surfaceOp: 'append' })
    const interrupted = await waitTask(test, item => latest(item).notifiedStatus === 'interrupted')
    await test.main.whenIdle()
    await expect(test.ctx.sessionCoordinator.reconcile(test.main, inspect(interrupted)))
      .rejects.toThrow('Reconciliation requires a retained local owner input in the original worker')
    worker.session.append('user/message', humanInput('本人追加的要求'), { surfaceOp: 'append' })
    await drained(test)
    await expect(test.ctx.sessionCoordinator.reconcile(test.main, { ...inspect(interrupted), key: 'inspect-owner' }))
      .rejects.toThrow('Cross-owner worker input cannot be reconciled into a local owner task')
    expect(current(test, task.id).attempts).toHaveLength(1)
  })

  it('reconciles direct input of a reused worker Session that records no directory', async () => {
    const test = await fixture()
    const handle = await test.ctx.agents.create({ sessionId: SessionId('rootless-worker'), meta: { agentPreset: 'short-drama' },
      agentOptions: { provider: 'mock', model: 'mock' } })
    const worker = handle.agent
    const task = await test.ctx.sessionCoordinator.dispatch(test.main, { ...request, sessionId: worker.id })
    await waitTask(test, item => latest(item).notifiedStatus === 'needs-report')
    await test.main.whenIdle()
    worker.session.append('user/message', humanInput('补充：保留片头'), { surfaceOp: 'append' })
    const interrupted = await waitTask(test, item => latest(item).notifiedStatus === 'interrupted')
    await test.main.whenIdle()
    const reconciled = await test.ctx.sessionCoordinator.reconcile(test.main, inspect(interrupted))
    expect(latest(reconciled)).toMatchObject({ revision: 2, cwd: latest(task).cwd })
    expect(latest(await waitTask(test, item => latest(item).revision === 2 && latest(item).status === 'completed')).report?.summary)
      .toBe('已核对已有结果')
  })

  it('resumes delivery of a retained reconciling intent when the same request is repeated', async () => {
    const test = await fixture()
    const { task, worker } = await settledAssignment(test)
    const resolve = test.ctx.sessionController.resolveAgent.bind(test.ctx.sessionController)
    let workerResolves = 0
    vi.spyOn(test.ctx.sessionController, 'resolveAgent').mockImplementation(async (id) => {
      if (id !== worker.id || ++workerResolves !== 2) return resolve(id)
      test.pool.failNextWrites = 1
      return { error: new RemoteError('session/agent-busy', 'Worker is held elsewhere', { reason: 'test' }) }
    })
    await expect(test.ctx.sessionCoordinator.reconcile(test.main, inspect(task))).rejects.toThrow('injected write failure')
    expect(latest(current(test, task.id)).status).toBe('reconciling')
    const resumed = await test.ctx.sessionCoordinator.reconcile(test.main, inspect(task))
    expect(['accepted', 'running']).toContain(latest(resumed).status)
    const completed = await waitTask(test, item => latest(item).revision === 2 && latest(item).status === 'completed')
    expect((await workerEvents(test, worker.id)).filter(event => event.type === 'user/message'
      && event.data.id === latest(completed).briefId)).toHaveLength(1)
  })
})

describe('stored reconciliation intents', () => {
  /** A reconciling revision 2 on the settled worker, anchored at revision 1's forwarded human input. */
  async function reconciling(test: Fixture, task: CoordinationTask, briefId: MessageId, anchor = latest(task).messageId) {
    const events = await workerEvents(test, latest(task).sessionId)
    const human = events.find(event => event.type === 'user/message' && event.data.id === anchor)
    if (human === undefined) throw new Error('Anchor input missing')
    return { ...task, attempts: [...task.attempts, { ...latest(task), revision: 2, key: 'inspect', requestHash: 'a'.repeat(64),
      instructions: 'Inspect the existing result.', reason: '核对', briefId, noticeId: fresh(), messageId: anchor, forwardedIds: [],
      createSession: false, status: 'reconciling' as const, report: null, issue: null, notifiedStatus: null,
      reconciliation: { throughSeq: events.at(-1)!.seq, humanSeq: human.seq, humanMessageId: anchor } }] }
  }

  it('wakes a recovered reconciliation whose brief is still pending and completes it once', async () => {
    const test = await fixture()
    const { task, worker } = await settledAssignment(test)
    const briefId = fresh()
    worker.send(brief(test, task, briefId, 2), 'next-turn', false)
    await test.ctx.sessions.flush(worker.session)
    // Recovery starts while the report tool re-registers for the reloaded coordinator; wake the worker once it is back.
    const resolve = test.ctx.sessionController.resolveAgent.bind(test.ctx.sessionController)
    vi.spyOn(test.ctx.sessionController, 'resolveAgent').mockImplementation(async (id) => {
      await vi.waitFor(() => { expect(test.ctx.tools.get('coordinator_report')).toBeDefined() })
      return resolve(id)
    })
    await restart(test, [await reconciling(test, task, briefId)])
    const completed = await waitTask(test, item => latest(item).revision === 2 && latest(item).status === 'completed')
    expect(latest(completed).report?.summary).toBe('已核对已有结果')
    expect((await workerEvents(test, worker.id)).filter(event => event.type === 'user/message' && event.data.id === briefId)).toHaveLength(1)
  })

  it('marks a recovered reconciliation interrupted when its spliced brief is neither pending nor consumed', async () => {
    const test = await fixture()
    const { task, worker } = await settledAssignment(test)
    const briefId = fresh()
    worker.send(brief(test, task, briefId, 2), 'next-turn', false)
    await test.ctx.sessions.flush(worker.session)
    worker.inbox.remove(briefId)
    holdJob(test, worker.id)
    await restart(test, [await reconciling(test, task, briefId)])
    const recovered = await waitTask(test, item => latest(item).revision === 2 && latest(item).status === 'interrupted')
    expect(latest(recovered).issue).toBe('A durable reconciliation receipt exists but is not pending or consumed; nothing was resent.')
  })

  it('reports a recovered reconciliation whose consumed brief predates newer human input', async () => {
    const test = await fixture()
    const { task, worker } = await settledAssignment(test)
    const briefId = fresh()
    const stored = await reconciling(test, task, briefId)
    await test.lifecycle.fiber.dispose()
    worker.session.append('user/message', brief(test, task, briefId, 2), { surfaceOp: 'append' })
    const newer = worker.session.append('user/message', humanInput('又一个直接要求'), { surfaceOp: 'append' })
    await restart(test, [stored])
    const changed = await waitTask(test, item => latest(item).revision === 2 && latest(item).changedInputSeq === newer.seq
      && latest(item).notifiedStatus === 'needs-report')
    expect(latest(changed).status).toBe('needs-report')
    await test.main.whenIdle()
    const receipts = JSON.stringify((await workerEvents(test, test.main.id)).filter(event => event.type === 'user/message'
      && event.data.source.kind === 'muse-coordination'))
    expect(receipts).toContain('Worker human input changed after the retained reconciliation.')
  })

  it('leaves a recovered reconciliation interrupted when its worker is disposed while Main is notified', async () => {
    const test = await fixture()
    const handle = await test.ctx.agents.create({ sessionId: SessionId('reused'), meta: { cwd: '/reused', agentPreset: 'short-drama' },
      agentOptions: { provider: 'mock', model: 'mock' } })
    const { task, worker } = await settledAssignment(test, { sessionId: handle.agent.id })
    const briefId = fresh()
    const stored = await reconciling(test, task, briefId)
    await test.lifecycle.fiber.dispose()
    worker.session.append('user/message', brief(test, task, briefId, 2), { surfaceOp: 'append' })
    worker.session.append('user/message', humanInput('又一个直接要求'), { surfaceOp: 'append' })
    const entered = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    let armed = true
    const read = test.ctx.sessionQuery.readSession.bind(test.ctx.sessionQuery)
    vi.spyOn(test.ctx.sessionQuery, 'readSession').mockImplementation(async (...args) => {
      if (armed && args[0] === test.main.id) {
        armed = false
        entered.resolve(undefined)
        await release.promise
      }
      return read(...args)
    })
    await restart(test, [stored])
    await entered.promise
    await handle.dispose()
    release.resolve(undefined)
    await waitTask(test, item => latest(item).revision === 2 && latest(item).notifiedStatus === 'interrupted')
    await drained(test)
    expect(latest(current(test, task.id))).toMatchObject({ status: 'interrupted',
      issue: 'Worker human input changed after the retained reconciliation. Its old pending brief was removed without waking it; unrelated work was preserved.' })
  })

  it('interrupts a recovered reconciliation whose worker received newer human input before its brief', async () => {
    const test = await fixture()
    const { task, worker } = await settledAssignment(test)
    await test.lifecycle.fiber.dispose()
    worker.session.append('user/message', humanInput('重启前的直接要求'), { surfaceOp: 'append' })
    await test.ctx.sessions.flush(worker.session)
    const briefId = fresh()
    await restart(test, [await reconciling(test, task, briefId)])
    const recovered = await waitTask(test, item => latest(item).revision === 2 && latest(item).status === 'interrupted')
    expect(latest(recovered).issue).toContain('Worker human input changed; read its history again')
    expect((await workerEvents(test, worker.id)).some(event => event.type === 'user/message' && event.data.id === briefId)).toBe(false)
  })
})
