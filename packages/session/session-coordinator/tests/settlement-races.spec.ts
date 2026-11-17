/** Worker settlement and receipt delivery while subtrees, jobs, maintenance, worker input and plugin unload race with it. */
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
import type { Agent } from '@deepseek-ai/dsh-agent'
import SubagentRuntime, { SubagentError } from '@deepseek-ai/dsh-subagent'
import type { SubagentDescendantListEntry } from '@deepseek-ai/dsh-subagent'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import { toolCallResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import Coordinator, { type Config } from '../src/index.ts'
import { coordinationDomain, latest } from '../src/ledger.ts'
import type { CoordinationTask, CoordinationTaskId, DispatchRequest } from '../src/types.ts'
import { setup, textResponse } from './fixture.ts'

type Script = Parameters<typeof setup>[1]

/** Report `completed` once for each first-revision assignment; reply with text otherwise. */
function reportingOnce(): Script {
  const reported = new Set<string>()
  return Array.from({ length: 80 }, () => (options) => {
    const assignment = options.messages.findLast(message => message.role === 'user'
      && message.source?.kind === 'muse-coordination' && message.source.purpose === 'assignment')
    if (assignment?.source?.kind === 'muse-coordination') {
      const key = `${assignment.source.taskId}:${assignment.source.revision}`
      if (!reported.has(key)) {
        reported.add(key)
        return toolCallResponse(`report-${key}`, 'coordinator_report', {
          task_id: assignment.source.taskId, revision: assignment.source.revision, outcome: 'completed', summary: '已交付',
        })
      }
    }
    return textResponse('ack')
  })
}

async function fixture(config: Config = {}, script: Script = Array.from({ length: 80 }, () => textResponse('ack'))) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-coordination-settlement-'))
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
const second: DispatchRequest = { ...request, key: 'goal-2', title: '修改第三集' }

function humanInput(text: string): UserMessage {
  return createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text }] })
}

const fresh = (): MessageId => createUserMessage({ source: { kind: 'user' }, content: [] }).id

function current(test: Fixture, id: CoordinationTaskId): CoordinationTask {
  const task = test.ctx.sessionCoordinator.list(test.main.id).find(item => item.id === id)
  if (task === undefined) throw new Error(`Task ${id} is missing`)
  return task
}

/** Read a task from the coordinator's storage while the plugin is unloaded. */
function storedTask(test: Fixture, id: CoordinationTaskId): CoordinationTask {
  const task = test.pool.media.get('muse_coordination')!.tables.get('tasks')!.get(id)
  if (task === undefined) throw new Error(`Task ${id} is not stored`)
  return coordinationDomain.tables.tasks.valueSchema.parse(task)
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

async function settledAssignment(test: Fixture, changes: Partial<DispatchRequest> = {}) {
  const task = await test.ctx.sessionCoordinator.dispatch(test.main, { ...request, ...changes })
  const settled = await waitTask(test, item => item.id === task.id && latest(item).notifiedStatus !== null)
  await test.main.whenIdle()
  const worker = test.ctx.agents.get(latest(task).sessionId)
  if (worker === undefined) throw new Error('Worker is not live')
  return { task: settled, worker }
}

/** Start a job owned by `owner`; it runs until released or the test ends. */
function holdJob(test: Fixture, owner: SessionId) {
  const done = Promise.withResolvers<JobOutcome>()
  const job = test.ctx.jobs.start({ kind: 'bash', label: 'held work', owner,
    run: () => ({ cancel() { done.resolve({ status: 'killed' }) }, done: done.promise }) })
  onTestFinished(() => { done.resolve({ status: 'completed' }) })
  return { release: async () => { done.resolve({ status: 'completed' }); await test.ctx.jobs.wait(job, 15000, owner) } }
}

/** Main receipt texts after Main handled them. */
async function receipts(test: Fixture): Promise<string> {
  await test.main.whenIdle()
  const log = await test.ctx.sessionQuery.readSession(test.main.id)
  return JSON.stringify(log.events.filter(event => event.type === 'user/message' && event.data.source.kind === 'muse-coordination'))
}

/** Report each Agent from its first `agent/pre-step` (other than Main and `except`) as having subtree work until cleared. */
function treeWork(test: Fixture, except: readonly SessionId[] = []) {
  const members = new Set<Agent>()
  const seen = new Set<Agent>()
  test.ctx.on('agent/pre-step', async ({ agent }, next) => {
    if (agent !== test.main && !except.includes(agent.id) && !seen.has(agent)) {
      seen.add(agent)
      members.add(agent)
    }
    return next()
  })
  vi.spyOn(test.ctx.subagents, 'hasTreeWork').mockImplementation(agent => members.has(agent))
  return members
}

describe('assignment input events', () => {
  it('ignores a consumed brief whose revision is stale or that arrives after settlement', async () => {
    const test = await fixture()
    const { task, worker } = await settledAssignment(test)
    const brief = (revision: number): UserMessage => ({ ...createUserMessage({ source: { kind: 'muse-coordination', form: 'relay',
      purpose: 'assignment', sender: test.main.id, taskId: task.id, revision }, content: [{ type: 'text', text: 'Replayed brief' }] }), id: fresh() })
    worker.session.append('user/message', brief(9), { surfaceOp: 'append' })
    worker.session.append('user/message', brief(1), { surfaceOp: 'append' })
    await drained(test)
    expect(latest(current(test, task.id)).status).toBe('needs-report')
  })

  it('leaves a task stopped when direct worker input arrives while its stop is queued', async () => {
    const test = await fixture()
    const { task, worker } = await settledAssignment(test)
    const stopping = test.ctx.sessionCoordinator.stop(test.main.id, task.id, 1)
    worker.session.append('user/message', humanInput('停止前的直接要求'), { surfaceOp: 'append' })
    expect(latest(await stopping).status).toBe('stopped')
    await drained(test)
    expect(latest(current(test, task.id))).toMatchObject({ status: 'stopped', issue: null })
  })
})

describe('waiting dispatch keys', () => {
  it('delivers a waiting dispatch when its key is repeated after the slot frees and before the queued start runs', async () => {
    const test = await fixture({ maxWorkers: 1 })
    const held = Promise.withResolvers<{ release: () => Promise<void> }>()
    let holding = false
    test.ctx.on('agent/pre-step', async ({ agent }, next) => {
      if (!holding && agent !== test.main) {
        holding = true
        held.resolve(holdJob(test, agent.id))
      }
      return next()
    })
    const first = await test.ctx.sessionCoordinator.dispatch(test.main, request)
    const queued = await test.ctx.sessionCoordinator.dispatch(test.main, second)
    expect(latest(queued).status).toBe('dispatching')
    const job = await held.promise
    // Hold the first worker's settlement at its history read so the repeated dispatch queues before the slot is reused.
    const entered = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    const mainRead: { done?: PromiseWithResolvers<undefined> } = {}
    let armed = true
    const read = test.ctx.sessionQuery.readSession.bind(test.ctx.sessionQuery)
    vi.spyOn(test.ctx.sessionQuery, 'readSession').mockImplementation(async (...args) => {
      if (armed && args[0] === latest(first).sessionId) {
        armed = false
        entered.resolve(undefined)
        await release.promise
      }
      const snapshot = await read(...args)
      if (args[0] === test.main.id) mainRead.done?.resolve(undefined)
      return snapshot
    })
    await test.ctx.agents.get(latest(first).sessionId)!.whenIdle()
    void job.release()
    await entered.promise
    mainRead.done = Promise.withResolvers()
    const repeated = test.ctx.sessionCoordinator.dispatch(test.main, second)
    await mainRead.done.promise
    await new Promise(resolve => setImmediate(resolve))
    release.resolve(undefined)
    const delivered = await repeated
    expect(delivered.id).toBe(queued.id)
    expect(['accepted', 'running']).toContain(latest(delivered).status)
    expect(test.ctx.agents.get(latest(queued).sessionId)).toBeDefined()
  })
})

describe('subtree settlement', () => {
  it('interrupts only the worker task whose subtree settlement fails', async () => {
    const test = await fixture()
    const other = await settledAssignment(test, { key: 'other', title: '另一项' })
    treeWork(test, [other.worker.id])
    // oxlint-disable-next-line typescript/prefer-promise-reject-errors -- pins how a non-Error rejection reason is reported
    vi.spyOn(test.ctx.subagents, 'waitForTreeWork').mockImplementation(() => Promise.reject('subtree catalog lost'))
    const task = await test.ctx.sessionCoordinator.dispatch(test.main, request)
    const failed = await waitTask(test, item => item.id === task.id && latest(item).status === 'interrupted')
    expect(latest(failed).issue).toBe('Execution subtree settlement failed: Error: subtree catalog lost')
    expect(latest(current(test, other.task.id)).status).toBe('needs-report')
  })

  it('stops following subtree work when the coordinator unloads and settles it after reload', async () => {
    const test = await fixture()
    const members = treeWork(test)
    const wait = vi.spyOn(test.ctx.subagents, 'waitForTreeWork').mockReturnValue(new Promise<boolean>(() => {}))
    const task = await test.ctx.sessionCoordinator.dispatch(test.main, request)
    await vi.waitFor(() => { expect(wait).toHaveBeenCalled() })
    await test.lifecycle.fiber.dispose()
    expect(latest(storedTask(test, task.id)).status).toBe('running')
    members.clear()
    test.lifecycle.fiber = await test.ctx.plugin(Coordinator, {})
    const settled = await waitTask(test, item => item.id === task.id && latest(item).status === 'needs-report')
    expect(latest(settled).issue).toBe('Worker is idle without a structured task report; completion is unconfirmed')
  })

  it('does not settle a worker instance that was disposed while its subtree was settling', async () => {
    const test = await fixture()
    const handle = await test.ctx.agents.create({ sessionId: SessionId('reused'), meta: { cwd: '/reused', agentPreset: 'short-drama' },
      agentOptions: { provider: 'mock', model: 'mock' } })
    treeWork(test)
    const tree = Promise.withResolvers<boolean>()
    const wait = vi.spyOn(test.ctx.subagents, 'waitForTreeWork').mockReturnValue(tree.promise)
    const task = await test.ctx.sessionCoordinator.dispatch(test.main, { ...request, sessionId: handle.agent.id })
    await vi.waitFor(() => { expect(wait).toHaveBeenCalled() })
    await handle.dispose()
    tree.resolve(true)
    await drained(test)
    await drained(test)
    expect(latest(current(test, task.id)).status).toBe('running')
  })

  it('ignores a finished subtree wait once the worker task has already settled', async () => {
    const test = await fixture({}, reportingOnce())
    const members = treeWork(test)
    const tree = Promise.withResolvers<boolean>()
    const wait = vi.spyOn(test.ctx.subagents, 'waitForTreeWork').mockReturnValue(tree.promise)
    const task = await test.ctx.sessionCoordinator.dispatch(test.main, request)
    await vi.waitFor(() => { expect(wait).toHaveBeenCalled() })
    expect(latest(current(test, task.id)).status).toBe('finishing')
    members.clear()
    const worker = test.ctx.agents.get(latest(task).sessionId)!
    worker.followup(createUserMessage({ source: { kind: 'muse-coordination', form: 'relay', purpose: 'receipt', sender: test.main.id,
      taskId: task.id, revision: 1 }, content: [{ type: 'text', text: 'Check the reported result.' }] }))
    await waitTask(test, item => latest(item).notifiedStatus === 'completed')
    tree.resolve(true)
    await drained(test)
    await drained(test)
    expect(latest(current(test, task.id)).status).toBe('completed')
    expect((await receipts(test)).match(/\\"status\\":\\"completed\\"/gu)).toHaveLength(1)
  })
})

describe('maintenance owned by another activity', () => {
  /** A worker whose own job deferred settlement after its turn, and whose idle phase another maintenance task then claimed. */
  async function heldWorker(test: Fixture) {
    const owned = Promise.withResolvers<{ release: () => Promise<void> }>()
    let holding = false
    test.ctx.on('agent/pre-step', async ({ agent }, next) => {
      if (!holding && agent !== test.main) {
        holding = true
        owned.resolve(holdJob(test, agent.id))
      }
      return next()
    })
    const task = await test.ctx.sessionCoordinator.dispatch(test.main, request)
    const worker = test.ctx.agents.get(latest(task).sessionId)!
    const job = await owned.promise
    await worker.whenIdle()
    await drained(test)
    const release = Promise.withResolvers<undefined>()
    const maintenance = worker.runMaintenance(async () => { await release.promise })
    const settle = async (): Promise<void> => {
      const trigger = test.ctx.jobs.start({ kind: 'bash', label: 'settle trigger', owner: test.main.id,
        run: () => ({ cancel() {}, done: Promise.resolve({ status: 'completed' }) }) })
      await test.ctx.jobs.wait(trigger, 15000, test.main.id)
      await drained(test)
    }
    await job.release()
    await drained(test)
    return { task, worker, settle, release: async () => { release.resolve(undefined); await maintenance } }
  }

  it('settles the worker once another maintenance activity releases it', async () => {
    const test = await fixture()
    const held = await heldWorker(test)
    await held.settle()
    expect(latest(current(test, held.task.id)).status).toBe('running')
    await held.release()
    await held.worker.whenIdle()
    // The retry is queued when the worker becomes idle; the second barrier queues after it.
    await drained(test)
    await drained(test)
    expect(latest(current(test, held.task.id))).toMatchObject({ status: 'needs-report',
      issue: 'Worker is idle without a structured task report; completion is unconfirmed' })
  })

  it('stops waiting for the worker when the coordinator unloads first', async () => {
    const test = await fixture()
    const held = await heldWorker(test)
    await test.lifecycle.fiber.dispose()
    await held.release()
    expect(latest(storedTask(test, held.task.id)).status).toBe('running')
  })
})

describe('settlement checkpoints', () => {
  /** Hold the settlement checkpoint of the first task that reaches `status` until `release` resolves. */
  function holdCheckpoint(test: Fixture, status: string) {
    const entered = Promise.withResolvers<Agent>()
    const release = Promise.withResolvers<undefined>()
    let armed = true
    const flush = test.ctx.sessions.flush.bind(test.ctx.sessions)
    vi.spyOn(test.ctx.sessions, 'flush').mockImplementation(async (session) => {
      const task = test.ctx.sessionCoordinator.list(test.main.id).find(item => latest(item).sessionId === session.id)
      const worker = test.ctx.agents.get(session.id)
      // A settlement checkpoint runs in maintenance, while the worker's public status is idle.
      if (armed && task !== undefined && latest(task).status === status && worker?.status === 'idle') {
        armed = false
        entered.resolve(worker)
        await release.promise
      }
      return flush(session)
    })
    return { entered: entered.promise, release: () => { release.resolve(undefined) } }
  }

  it('interrupts only the cancelled worker\'s task when its settlement is cancelled', async () => {
    const test = await fixture({}, reportingOnce())
    const other = await settledAssignment(test, { key: 'other', title: '另一项' })
    const checkpoint = holdCheckpoint(test, 'finishing')
    const task = await test.ctx.sessionCoordinator.dispatch(test.main, request)
    const worker = await checkpoint.entered
    worker.cancel({ kind: 'user' }, { keepInbox: true })
    checkpoint.release()
    const issue = 'Worker settlement was cancelled. Its pending inputs were retained; inspect before continuing.'
    const cancelled = await waitTask(test, item => item.id === task.id && latest(item).issue === issue)
    expect(latest(cancelled)).toMatchObject({ status: 'interrupted', report: null, notifiedStatus: 'interrupted' })
    expect(latest(current(test, other.task.id)).status).toBe('completed')
  })

  it('defers publication while the worker starts a job during settlement', async () => {
    const test = await fixture({}, reportingOnce())
    const checkpoint = holdCheckpoint(test, 'finishing')
    const task = await test.ctx.sessionCoordinator.dispatch(test.main, request)
    const worker = await checkpoint.entered
    const job = holdJob(test, worker.id)
    checkpoint.release()
    await drained(test)
    expect(latest(current(test, task.id)).status).toBe('finishing')
    await job.release()
    expect(latest(await waitTask(test, item => latest(item).status === 'completed')).report?.summary).toBe('已交付')
  })

  it('publishes the report only after every descendant job settles, including one started during settlement', async () => {
    const test = await fixture({}, reportingOnce())
    const descendant = await test.makeAgent('descendant', 'short-drama', '/main')
    vi.spyOn(test.ctx.subagents, 'listDescendants').mockImplementation(async parentId => [{ kind: 'child', id: descendant.id,
      activity: 'inactive', mode: 'one-shot', hasChildren: false, parentId, depth: 1 } satisfies SubagentDescendantListEntry])
    const jobs: { release: () => Promise<void> }[] = []
    test.ctx.on('agent/pre-step', async ({ agent }, next) => {
      if (agent !== test.main && jobs.length === 0) jobs.push(holdJob(test, descendant.id))
      return next()
    })
    const task = await test.ctx.sessionCoordinator.dispatch(test.main, request)
    const worker = test.ctx.agents.get(latest(task).sessionId)!
    await waitTask(test, item => latest(item).status === 'finishing')
    await worker.whenIdle()
    await drained(test)
    expect(latest(current(test, task.id)).status).toBe('finishing')
    const checkpoint = holdCheckpoint(test, 'finishing')
    void jobs[0]!.release()
    await checkpoint.entered
    const late = holdJob(test, descendant.id)
    checkpoint.release()
    await drained(test)
    expect(latest(current(test, task.id)).status).toBe('finishing')
    await late.release()
    expect(latest(await waitTask(test, item => latest(item).status === 'completed')).report?.summary).toBe('已交付')
  })

  it('reconciles a worker whose settled descendants hold no live jobs', async () => {
    const test = await fixture()
    const { task, worker } = await settledAssignment(test)
    const listing = vi.spyOn(test.ctx.subagents, 'listDescendants').mockResolvedValue([{ kind: 'child', id: SessionId('settled-child'),
      activity: 'inactive', mode: 'one-shot', hasChildren: false, parentId: worker.id, depth: 1 }])
    const reconciled = await test.ctx.sessionCoordinator.reconcile(test.main, { key: 'inspect', taskId: task.id, expectedRevision: 1,
      instructions: 'Inspect the existing result.', reason: '核对' })
    expect(['accepted', 'running']).toContain(latest(reconciled).status)
    expect(listing.mock.calls.map(call => call[0])).toContain(worker.id)
  })

  it('interrupts only the task whose worker subtree cannot be verified', async () => {
    const test = await fixture({}, reportingOnce())
    const other = await settledAssignment(test, { key: 'other', title: '另一项' })
    const failing = new Set<SessionId>()
    test.ctx.on('agent/pre-step', async ({ agent }, next) => {
      if (agent !== test.main && agent.id !== other.worker.id) failing.add(agent.id)
      return next()
    })
    const list = test.ctx.subagents.listDescendants.bind(test.ctx.subagents)
    vi.spyOn(test.ctx.subagents, 'listDescendants').mockImplementation(async (id, signal) => {
      if (failing.has(id)) throw new Error('catalog unavailable')
      return list(id, signal)
    })
    const task = await test.ctx.sessionCoordinator.dispatch(test.main, request)
    const failed = await waitTask(test, item => item.id === task.id && latest(item).status === 'interrupted')
    expect(latest(failed).issue).toBe('Execution subtree could not be verified: Error: catalog unavailable')
    expect(latest(current(test, other.task.id)).status).toBe('completed')
  })

  it('leaves the task unchanged when its subtree listing fails during unload', async () => {
    const test = await fixture()
    const listing = Promise.withResolvers<SubagentDescendantListEntry[]>()
    const entered = Promise.withResolvers<undefined>()
    let armed = false
    test.ctx.on('agent/pre-step', async ({ agent }, next) => {
      if (agent !== test.main) armed = true
      return next()
    })
    const list = test.ctx.subagents.listDescendants.bind(test.ctx.subagents)
    vi.spyOn(test.ctx.subagents, 'listDescendants').mockImplementation(async (id, signal) => {
      if (!armed) return list(id, signal)
      armed = false
      entered.resolve(undefined)
      return listing.promise
    })
    const task = await test.ctx.sessionCoordinator.dispatch(test.main, request)
    await entered.promise
    const stream = test.ctx.sessionCoordinator.watch(test.main.id, new AbortController().signal)[Symbol.asyncIterator]()
    await stream.next()
    const unloading = test.lifecycle.fiber.dispose()
    while ((await stream.next()).done !== true) { /* The stream ends when the coordinator lifetime aborts. */ }
    listing.reject(new Error('catalog unavailable'))
    await unloading
    expect(latest(storedTask(test, task.id))).toMatchObject({ status: 'running', issue: null })
  })
})

describe('receipt delivery', () => {
  it.each([false, true])('withholds a completion receipt when worker input changes while Main is read (worker busy: %s)', async (busy) => {
    const test = await fixture({}, reportingOnce())
    const read = test.ctx.sessionQuery.readSession.bind(test.ctx.sessionQuery)
    let armed = true
    let changedSeq: number | undefined
    vi.spyOn(test.ctx.sessionQuery, 'readSession').mockImplementation(async (...args) => {
      const snapshot = await read(...args)
      const task = armed && args[0] === test.main.id ? test.ctx.sessionCoordinator.list(test.main.id)[0] : undefined
      if (task !== undefined && latest(task).status === 'completed') {
        armed = false
        const worker = test.ctx.agents.get(latest(task).sessionId)!
        changedSeq = worker.session.append('user/message', humanInput('报告之后改了要求'), { surfaceOp: 'append' }).seq
        if (busy) holdJob(test, worker.id)
      }
      return snapshot
    })
    await test.ctx.sessionCoordinator.dispatch(test.main, request)
    const status = busy ? 'interrupted' : 'needs-report'
    const changed = await waitTask(test, item => latest(item).notifiedStatus === status)
    expect(latest(changed)).toMatchObject({ status, report: null, changedInputSeq: changedSeq, issue: busy
      ? 'Worker input changed before report publication and the worker is still busy; wait for the next receipt.'
      : 'Worker input changed before report publication; call coordinator_reconcile so the worker reports this task.' })
    const notices = await receipts(test)
    expect(notices).not.toContain('\\"status\\":\\"completed\\"')
    expect(notices).toContain(`\\"status\\":\\"${status}\\"`)
  })

  it('keeps a receipt undelivered and logs the failure when Main cannot be resolved, then delivers it after reload', async () => {
    const test = await fixture()
    const errors: string[] = []
    test.ctx.logger.exporter({ levels: { default: 0 }, export: ({ type, args }) => { if (type === 'error') errors.push(args.map(String).join(' ')) } })
    const resolve = test.ctx.sessionController.resolveAgent.bind(test.ctx.sessionController)
    let held = false
    const resolving = vi.spyOn(test.ctx.sessionController, 'resolveAgent').mockImplementation(async id => !held || id !== test.main.id
      ? resolve(id) : { error: new RemoteError('session/agent-busy', 'Main is held elsewhere', { reason: 'test' }) })
    const task = await test.ctx.sessionCoordinator.dispatch(test.main, request)
    held = true
    await vi.waitFor(() => {
      expect(errors.some(line => line.startsWith('session-coordinator: %s') && line.includes('Main is held elsewhere'))).toBe(true)
    })
    expect(latest(current(test, task.id))).toMatchObject({ status: 'needs-report', notifiedStatus: null })
    resolving.mockRestore()
    await test.lifecycle.fiber.dispose()
    test.lifecycle.fiber = await test.ctx.plugin(Coordinator, {})
    await waitTask(test, item => latest(item).notifiedStatus === 'needs-report')
    expect(await receipts(test)).toContain('\\"status\\":\\"needs-report\\"')
  })

  it('stops a receipt when the coordinator unloads while Main history is read', async () => {
    const test = await fixture()
    const entered = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    let armed = true
    const read = test.ctx.sessionQuery.readSession.bind(test.ctx.sessionQuery)
    vi.spyOn(test.ctx.sessionQuery, 'readSession').mockImplementation(async (...args) => {
      const task = armed && args[0] === test.main.id ? test.ctx.sessionCoordinator.list(test.main.id)[0] : undefined
      if (task !== undefined && latest(task).status === 'needs-report') {
        armed = false
        entered.resolve(undefined)
        await release.promise
      }
      return read(...args)
    })
    const task = await test.ctx.sessionCoordinator.dispatch(test.main, request)
    await entered.promise
    await test.lifecycle.fiber.dispose()
    release.resolve(undefined)
    expect(latest(storedTask(test, task.id))).toMatchObject({ status: 'needs-report', notifiedStatus: null })
    expect(await receipts(test)).toBe('[]')
  })
})

describe('worker execution trees', () => {
  it('excludes Agents outside any delegated tree and propagates other root lookup failures', async () => {
    const test = await fixture()
    const worker = await test.makeAgent('ordinary')
    const rootOf = vi.spyOn(test.ctx.subagents, 'rootOf').mockImplementation(() => {
      throw new SubagentError('not a delegated Agent', 'UNAUTHORIZED')
    })
    const listed = JSON.parse(await test.ctx.sessionCoordinator.search(test.main, '')) as { sessions: { sessionId: string; busy: boolean }[] }
    expect(listed.sessions.map(row => [row.sessionId, row.busy])).toEqual([[worker.id, false]])
    rootOf.mockImplementation(() => { throw new Error('subagent runtime unavailable') })
    await expect(test.ctx.sessionCoordinator.search(test.main, '')).rejects.toThrow('subagent runtime unavailable')
  })

  it('reports an idle Session as not busy when no subagent runtime is mounted', async () => {
    const test = await fixture()
    const worker = await test.makeAgent('ordinary')
    const runtime = [...test.ctx.registry.get(SubagentRuntime)!.fibers][0]!
    await runtime.dispose()
    const listed = JSON.parse(await test.ctx.sessionCoordinator.search(test.main, '')) as { sessions: { sessionId: string; busy: boolean }[] }
    expect(listed.sessions.map(row => [row.sessionId, row.busy])).toEqual([[worker.id, false]])
  })
})
