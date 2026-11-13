/** Native loop regressions for routing authority, receipts and worker isolation. */
import { mkdtemp, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { createUserMessage, ToolCallId } from '@deepseek-ai/dsh-llm'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { executeModelToolFixture, executeToolFixture } from '@deepseek-ai/dsh-tool-testkit'
import type { JobOutcome } from '@deepseek-ai/dsh-jobs'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { SubagentActivation, SubagentResult } from '@deepseek-ai/dsh-subagent'
import { JubianClient, JubianLedger } from '@deepseek-ai/dsh-jubian'
import { JubianVideoSelection } from '@deepseek-ai/dsh-tool-jubian'
import { brandString } from '@deepseek-ai/dsh-brand'
import { toolCallResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import Coordinator, { type Config } from '../src/index.ts'
import { latest } from '../src/ledger.ts'
import type { AssignmentStatus, CoordinationTask, CoordinationTaskId, DispatchRequest } from '../src/types.ts'
import { manuscriptTaskRequest } from '../../../../apps/desktop-host/src/manuscript-task-intent.ts'
import { setup, textResponse } from './fixture.ts'

async function fixture(script: Parameters<typeof setup>[1] = Array.from({ length: 30 }, () => textResponse('ack')), config: Config = {}) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-coordination-'))
  const cleanup: { ctx?: Awaited<ReturnType<typeof setup>>['ctx'] } = {}
  onTestFinished(async () => {
    if (cleanup.ctx !== undefined) await cleanup.ctx.fiber.dispose()
    await rm(root, { recursive: true, force: true })
  })
  const test = await setup(root, script, undefined, config)
  cleanup.ctx = test.ctx
  const main = await test.makeAgent('main', 'main-session')
  main.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: '只改第2集，原文是 current.docx，交付 candidate.docx，第3集不要动。' }] }))
  await main.whenIdle()
  return { ...test, main, root }
}

const request: DispatchRequest = { key: 'goal-1', title: '修改第二集', instructions: 'Read current.docx and save a distinct candidate.docx; preserve episode 3.', reason: '已有稿件适合交给执行会话' }

async function waitStatus(test: Awaited<ReturnType<typeof fixture>>, status: AssignmentStatus): Promise<CoordinationTask> {
  const abort = new AbortController()
  const signal = AbortSignal.any([abort.signal, AbortSignal.timeout(15000)])
  try {
    for await (const tasks of test.service.watch(test.main.id, signal)) {
      const task = tasks.find(item => latest(item).status === status)
      if (task !== undefined) return task
    }
    throw new Error(`No task reached ${status}: ${JSON.stringify(test.service.list(test.main.id))}`)
  } finally { abort.abort() }
}

describe('routing-only Main Session', () => {
  it('opens the same dedicated Main Session in the existing default Workspace', async () => {
    const test = await fixture()
    const controller = new AbortController()
    const identities = test.service.watchMain(controller.signal)[Symbol.asyncIterator]()
    expect((await identities.next()).value).toBeNull()
    const [first, repeated] = await Promise.all([test.service.openMain(), test.service.openMain()])
    expect(repeated).toBe(first)
    expect((await identities.next()).value).toBe(first)
    controller.abort()
    await identities.return?.()
    const agent = test.ctx.agents.get(first)
    const initial = await test.ctx.workspaceController.initializeDefault(new AbortController().signal)
    expect(initial).toBeDefined()
    expect(agent?.session.header.cwd).toBe(initial?.workspace.path)
    expect(initial?.workspace.sessionIds).toContain(first)
    expect(agent?.session.header.agentPreset).toBe('main-session')
    expect(agent?.status).toBe('idle')
    expect(test.ctx.agents.list().filter(item => item.id === first)).toHaveLength(1)
    expect(test.ctx.sessionController.canReuseBlank(first, undefined)).toBe(false)
    expect(test.ctx.sessionController.canReuseBlank(first, 'short-drama')).toBe(false)
    expect(test.ctx.sessionController.canReuseBlank(first, 'main-session')).toBe(true)
  })

  it('does not create a Main Session elsewhere after the default Workspace was removed', async () => {
    const test = await fixture()
    const initial = await test.ctx.workspaceController.initializeDefault(new AbortController().signal)
    if (initial === undefined) throw new Error('Fixture default Workspace missing')
    await test.ctx.workspaceRegistry.delete(initial.workspace.workspaceId)
    const count = test.ctx.agents.list().length
    await expect(test.service.openMain()).rejects.toThrow('default Workspace is unavailable')
    expect(test.ctx.agents.list()).toHaveLength(count)
  })

  it('blocks inherited and newly registered execution tools while workers retain them', async () => {
    const test = await fixture()
    let executions = 0
    const dangerous = () => defineTool({ name: 'business_write', description: 'test execution', parameters: {},
      output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
      async execute() { executions++; return 'written' } })
    test.ctx.tools.register(dangerous())
    test.main.ctx.tools.register(dangerous())
    const invoke = (agent: typeof test.main) => executeToolFixture(test.ctx, { agent, name: 'business_write', arguments: {}, callId: ToolCallId('test-write'), signal: new AbortController().signal })
    expect((await invoke(test.main)).isError).toBe(true)
    const worker = await test.makeAgent('ordinary')
    expect((await invoke(worker)).isError).toBe(false)
    expect(executions).toBe(1)
    await expect(test.service.dispatch(worker, request)).rejects.toThrow(/main-session/)
  })

  it('creates an independent ordinary worker, retains original requirements and deduplicates concurrent requests', async () => {
    const test = await fixture()
    const [a, b] = await Promise.all([test.service.dispatch(test.main, request), test.service.dispatch(test.main, request)])
    expect(a.id).toBe(b.id)
    expect(test.service.list(test.main.id)).toHaveLength(1)
    const worker = test.ctx.agents.get(latest(a).sessionId)!
    await worker.whenIdle()
    const snapshot = await test.ctx.sessionQuery.readSession(worker.id)
    expect(snapshot.session.agentPreset).toBe('short-drama')
    const inputs = snapshot.events.filter(event => event.type === 'user/message' && event.data.id === latest(a).messageId)
    expect(inputs).toHaveLength(1)
    expect(JSON.stringify(inputs)).toContain('第3集不要动')
    expect(JSON.stringify(inputs)).toContain('current.docx')
    expect(worker.session.header.parentSession).toBeUndefined()
    await expect(test.service.dispatch(test.main, { ...request, instructions: 'Different goal' })).rejects.toThrow(/different work/)
    expect(latest(await waitStatus(test, 'needs-report')).status).toBe('needs-report')
  })

  it('reuses an idle ordinary Session and preserves its existing history and preset', async () => {
    const test = await fixture()
    const worker = await test.makeAgent('existing', 'specialist', '/other-workspace')
    worker.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: '既有项目设定与稿件' }] }))
    await worker.whenIdle()
    const task = await test.service.dispatch(test.main, { ...request, sessionId: worker.id })
    await worker.whenIdle()
    const snapshot = await test.ctx.sessionQuery.readSession(worker.id)
    expect(snapshot.session.agentPreset).toBe('specialist')
    expect(snapshot.session.cwd).toBe('/other-workspace')
    expect(JSON.stringify(snapshot.events)).toContain('既有项目设定与稿件')
    expect(latest(task).sessionId).toBe(worker.id)
    const read = JSON.parse(await test.service.read(test.main, worker.id, 0)) as { complete: boolean }
    expect(read.complete).toBe(true)
  })

  it('does not steer unrelated work into a busy Session', async () => {
    const test = await fixture([textResponse('main'), 'hang', textResponse('stopped')])
    const worker = await test.makeAgent('busy')
    worker.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: '正在进行的独立工作' }] }))
    await expect(test.service.dispatch(test.main, { ...request, sessionId: worker.id })).rejects.toThrow(/busy/)
    expect(test.service.list(test.main.id)).toHaveLength(0)
    worker.cancel({ kind: 'user' })
    await worker.whenIdle()
  })

  it('publishes a structured worker report only after the worker finishes its native turn', async () => {
    const test = await fixture([
      textResponse('main'),
      (options) => {
        const message = options.messages.findLast(item => item.role === 'user' && item.source?.kind === 'muse-coordination')
        if (message?.source?.kind !== 'muse-coordination') throw new Error('Assignment missing')
        return toolCallResponse('report', 'coordinator_report', { task_id: message.source.taskId, revision: message.source.revision, outcome: 'completed', summary: '已保存实际修改结果' })
      },
      textResponse('执行会话最终交付'), textResponse('主会话转交结果'),
    ])
    await test.service.dispatch(test.main, request)
    const task = await waitStatus(test, 'completed')
    const worker = test.ctx.agents.get(latest(task).sessionId)!
    expect(worker.status).toBe('idle')
    expect(latest(task).report?.summary).toBe('已保存实际修改结果')
    expect(latest(task).report?.files).toEqual([])
    await test.main.whenIdle()
    const mainLog = await test.ctx.sessionQuery.readSession(test.main.id)
    expect(JSON.stringify(mainLog.events)).toContain('主会话转交结果')
    expect(mainLog.events.filter(event => event.type === 'user/message' && event.data.source.kind === 'muse-coordination')).toHaveLength(1)
  })

  it('keeps stopping separate from settled and refuses stale or foreign stop requests', async () => {
    const test = await fixture([textResponse('main'), 'hang-slow', textResponse('stop receipt')])
    const task = await test.service.dispatch(test.main, request)
    await expect(test.service.stop(test.main.id, task.id, 2)).rejects.toThrow(/revision/)
    const stranger = await test.makeAgent('stranger', 'main-session')
    await expect(test.service.stop(stranger.id, task.id, 1)).rejects.toThrow(/belong/)
    const receipt = await test.service.stop(test.main.id, task.id, 1)
    expect(['stopping', 'stopped']).toContain(latest(receipt).status)
    const stopped = await waitStatus(test, 'stopped')
    expect(test.ctx.agents.get(latest(stopped).sessionId)?.status).toBe('idle')
  })

  it.each([
    ['completed', 'parent'], ['error', 'parent'], ['stopped', 'parent'], ['stopped', 'caller'],
  ] as const)('waits for an external descendant to release resources before publishing %s with %s delivery', async (outcome, delivery) => {
    const script = Array.from({ length: 30 }, () => textResponse('ack'))
    const test = await fixture([
      script[0]!,
      (options) => {
        const input = options.messages.findLast(message => message.role === 'user' && message.source?.kind === 'muse-coordination')
        if (input?.source?.kind !== 'muse-coordination') throw new Error('Assignment missing')
        return toolCallResponse('early-report', 'coordinator_report', {
          task_id: input.source.taskId, revision: input.source.revision, outcome: 'completed', summary: 'Worker report before its helper settles',
        })
      }, ...script,
    ])
    const result = Promise.withResolvers<SubagentResult>()
    const cleanup = Promise.withResolvers<undefined>()
    const cleaning = Promise.withResolvers<undefined>()
    let activation: SubagentActivation | undefined
    let opened = false
    test.ctx.subagents.registerProvider({
      name: 'external-check', inheritsParentContext: false,
      capabilities: { agentOptions: false, agentPreset: false, outputSchema: false, depthLimit: false },
      async start({ signal }) {
        signal.addEventListener('abort', () => { result.resolve({ output: [], stopReason: 'aborted' }) }, { once: true })
        return { id: SessionId('external-check'), result: result.promise, async dispose() { cleaning.resolve(undefined); await cleanup.promise } }
      },
    })
    test.ctx.on('agent/pre-step', async ({ agent }, next) => {
      if (agent !== test.main && !opened) {
        opened = true
        activation = await test.ctx.subagents.startActivation({
          parent: agent, provider: 'external-check', label: 'helper', delivery,
          ...delivery === 'parent' ? { name: 'helper' } : {},
          signal: new AbortController().signal, prompt: [{ type: 'text', text: 'Check the result' }],
        })
      }
      return next()
    })
    const task = await test.service.dispatch(test.main, request)
    const worker = test.ctx.agents.get(latest(task).sessionId)!
    try {
      await waitStatus(test, 'finishing')
      await worker.whenIdle()
      expect(test.ctx.subagents.hasTreeWork(worker)).toBe(true)
      if (outcome === 'stopped') {
        const stopping = await test.service.stop(test.main.id, task.id, 1)
        expect(latest(stopping).status).toBe('stopping')
      } else result.resolve({ output: [], stopReason: outcome })
      await cleaning.promise
      expect(latest(test.service.list(test.main.id)[0]!).status).toBe(outcome === 'stopped' ? 'stopping' : 'finishing')
      cleanup.resolve(undefined)
      const settled = await waitStatus(test, outcome === 'error' ? 'interrupted' : outcome)
      if (outcome === 'error') expect(latest(settled).issue).toContain('delegated execution failed')
    } finally {
      result.resolve({ output: [], stopReason: 'completed' })
      cleanup.resolve(undefined)
      await activation?.dispose()
    }
  })

  it('retains an unverified subtree as interrupted instead of publishing the worker report', async () => {
    const test = await fixture([
      textResponse('main'),
      (options) => {
        const input = options.messages.findLast(message => message.role === 'user' && message.source?.kind === 'muse-coordination')
        if (input?.source?.kind !== 'muse-coordination') throw new Error('Assignment missing')
        return toolCallResponse('unverified-report', 'coordinator_report', {
          task_id: input.source.taskId, revision: input.source.revision, outcome: 'completed', summary: 'Unverified worker report',
        })
      },
      () => {
        const listing = vi.spyOn(test.ctx.subagents, 'listDescendants').mockRejectedValue(new Error('catalog unavailable'))
        onTestFinished(() => { listing.mockRestore() })
        return textResponse('worker finished')
      },
      textResponse('Inspect the retained execution before continuing.'),
    ])
    await test.service.dispatch(test.main, request)
    const task = await waitStatus(test, 'interrupted')
    expect(latest(task).issue).toContain('Execution subtree could not be verified')
    expect(latest(task).issue).toContain('catalog unavailable')
    expect(latest(task).report?.outcome).toBe('completed')
  })

  it('retains persisted task receipts when the plugin is disabled and re-enabled without repeating execution', async () => {
    const test = await fixture()
    const task = await test.service.dispatch(test.main, request)
    await waitStatus(test, 'needs-report')
    await test.main.whenIdle()
    const before = test.adapter.requests.length
    await test.fiber.dispose()
    await test.ctx.plugin(Coordinator, {})
    expect(test.ctx.sessionCoordinator.list(test.main.id).map(item => item.id)).toEqual([task.id])
    const stream = test.ctx.sessionCoordinator.watch(test.main.id, AbortSignal.timeout(15000))
    for await (const tasks of stream) { if (tasks.length > 0) break }
    expect(test.adapter.requests.length).toBe(before)
  })

  it('keeps the task stopping until its owned background job actually releases its resources', async () => {
    const test = await fixture([textResponse('main'), 'hang', textResponse('stopped')])
    const task = await test.service.dispatch(test.main, request)
    const worker = test.ctx.agents.get(latest(task).sessionId)!
    const done = Promise.withResolvers<JobOutcome>()
    let cancellations = 0
    const jobId = test.ctx.jobs.start({ kind: 'bash', label: 'task-owned work', owner: worker.id,
      run: () => ({ cancel() { cancellations++ }, done: done.promise }) })
    try {
      const stopping = await test.service.stop(test.main.id, task.id, 1)
      expect(latest(stopping).status).toBe('stopping')
      expect(cancellations).toBe(1)
      expect(test.ctx.jobs.get(jobId, worker.id).status).toBe('stopping')
    } finally {
      done.resolve({ status: 'killed' })
      await test.ctx.jobs.wait(jobId, 15000, worker.id)
    }
    const stopped = await waitStatus(test, 'stopped')
    expect(latest(stopped).status).toBe('stopped')
  })

  it('does not create or message any worker when the durable intent write fails', async () => {
    const test = await fixture()
    const before = test.ctx.agents.list().length
    test.pool.failNextWrites = 1
    await expect(test.service.dispatch(test.main, request)).rejects.toThrow(/injected write failure/)
    expect(test.ctx.agents.list()).toHaveLength(before)
    expect(test.service.list(test.main.id)).toEqual([])
  })

  it('preserves background work started by a later direct user request in the execution chat', async () => {
    const test = await fixture()
    const task = await test.service.dispatch(test.main, request)
    await waitStatus(test, 'needs-report')
    const worker = test.ctx.agents.get(latest(task).sessionId)!
    worker.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: '另一项独立工作' }] }))
    await worker.whenIdle()
    const done = Promise.withResolvers<JobOutcome>()
    let cancellations = 0
    const job = test.ctx.jobs.start({ kind: 'bash', label: 'later user work', owner: worker.id,
      run: () => ({ cancel() { cancellations++ }, done: done.promise }) })
    try {
      const result = await test.service.stop(test.main.id, task.id, 1)
      expect(latest(result).status).toBe('interrupted')
      expect(cancellations).toBe(0)
      expect(test.ctx.jobs.get(job, worker.id).status).toBe('running')
    } finally {
      done.resolve({ status: 'completed' })
      await test.ctx.jobs.wait(job, 15000, worker.id)
    }
  })

  it('preserves the saved video model and resolution in the real worker selection before its input is consumed', async () => {
    const test = await fixture()
    const catalogue = JSON.parse(await readFile(new URL('../../../jubian/jubian-api/tests/fixtures/catalogue-20261016.json', import.meta.url), 'utf8')) as Record<string, unknown[]>
    const client = new JubianClient({ credential: async () => 'fixture', baseUrl: 'https://video.invalid',
      fetch: async () => new Response(JSON.stringify({ code: 200, data: catalogue['1'] })) })
    const ledger = new JubianLedger({ root: test.root })
    await test.ctx.plugin(JubianVideoSelection, { client, ledger, enabled: true })
    const chosen = (await test.ctx.jubianVideoSelection.catalogue()).find(option => option.resolution.includes('720'))!
    expect(chosen).toBeDefined()
    await test.ctx.jubianVideoSelection.select(test.main, chosen.key, 0)
    const task = await test.service.dispatch(test.main, request)
    const worker = test.ctx.agents.get(latest(task).sessionId)!
    await worker.whenIdle()
    expect(test.ctx.jubianVideoSelection.current(worker)?.key).toBe(chosen.key)
    const log = await test.ctx.sessionQuery.readSession(worker.id)
    const selection = log.events.find(event => event.type === 'jubian/video-selection')!
    const input = log.events.find(event => event.type === 'user/message' && event.data.id === latest(task).messageId)!
    expect(selection.seq).toBeLessThan(input.seq)
  })


  it('continues one stopped goal in a fresh worker with all earlier human requirements retained', async () => {
    const test = await fixture()
    const initial = await test.service.dispatch(test.main, request)
    await waitStatus(test, 'needs-report')
    await test.service.stop(test.main.id, initial.id, 1)
    await waitStatus(test, 'stopped')
    test.main.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: '继续，候选稿保持同一人物关系' }] }))
    await test.main.whenIdle()
    const continued = await test.service.dispatch(test.main, { ...request, key: 'goal-1-revision-2',
      taskId: initial.id, expectedRevision: 1, instructions: 'Continue with the same relationships and original scope.' })
    expect(continued.id).toBe(initial.id)
    expect(continued.attempts).toHaveLength(2)
    expect(latest(continued).sessionId).not.toBe(latest(initial).sessionId)
    const worker = test.ctx.agents.get(latest(continued).sessionId)!
    await worker.whenIdle()
    const log = await test.ctx.sessionQuery.readSession(worker.id)
    const input = log.events.find(event => event.type === 'user/message' && event.data.id === latest(continued).messageId)
    expect(JSON.stringify(input)).toContain('继续，候选稿保持同一人物关系')
    const humanIntent = manuscriptTaskRequest(worker.session.deriveMessages(), 24000)
    expect(humanIntent.request?.text).toContain('第3集不要动')
    expect(humanIntent.request?.text).toContain('current.docx')
    expect(humanIntent.continuations.map(item => item.text)).toEqual(['继续，候选稿保持同一人物关系'])
  })

  it('rejects a routing note longer than the configured limit before recording intent', async () => {
    const test = await fixture(undefined, { noteChars: 20 })
    const before = test.ctx.agents.list().length
    await expect(test.service.dispatch(test.main, { ...request, instructions: 'x'.repeat(21) }))
      .rejects.toMatchObject({ name: 'ToolArgsError', code: 'INVALID_ARGS' })
    expect(test.service.list(test.main.id)).toEqual([])
    expect(test.ctx.agents.list()).toHaveLength(before)
    const task = await test.service.dispatch(test.main, { ...request, instructions: 'x'.repeat(20) })
    expect(latest(task).instructions).toBe('x'.repeat(20))
  })

  it('cancels the assigned work when its latest input is a runtime continuation rather than later human input', async () => {
    const test = await fixture()
    const task = await test.service.dispatch(test.main, request)
    await waitStatus(test, 'needs-report')
    const worker = test.ctx.agents.get(latest(task).sessionId)!
    worker.session.append('user/message', createUserMessage({
      source: { kind: 'subagent-settled', form: 'notice', summary: 'helper completed', stopReason: 'completed', senderSessionId: SessionId('helper') },
      content: [{ type: 'text', text: 'helper done' }],
    }), { surfaceOp: 'append' })
    const done = Promise.withResolvers<JobOutcome>()
    let cancellations = 0
    const job = test.ctx.jobs.start({ kind: 'bash', label: 'assigned follow-up work', owner: worker.id,
      run: () => ({ cancel() { cancellations++ }, done: done.promise }) })
    try {
      const result = await test.service.stop(test.main.id, task.id, 1)
      expect(latest(result).status).toBe('stopping')
      expect(cancellations).toBe(1)
    } finally {
      done.resolve({ status: 'killed' })
      await test.ctx.jobs.wait(job, 15000, worker.id)
    }
    expect(latest(await waitStatus(test, 'stopped')).status).toBe('stopped')
  })

  it('ends a stopped task whose producer did not report and allows its revision', async () => {
    const test = await fixture()
    const task = await test.service.dispatch(test.main, request)
    await waitStatus(test, 'needs-report')
    const worker = test.ctx.agents.get(latest(task).sessionId)!
    test.ctx.jobs.start({ kind: 'bash', label: 'crashing producer', owner: worker.id,
      run: () => ({ cancel() {}, done: Promise.reject(new Error('producer crashed')) }) })
    const interrupted = await waitStatus(test, 'interrupted')
    expect(latest(interrupted).issue).toContain('did not confirm')
    await test.main.whenIdle()
    await test.service.stop(test.main.id, task.id, 1)
    const stopped = await waitStatus(test, 'stopped')
    expect(latest(stopped).issue).toContain('did not confirm')
    const revised = await test.service.dispatch(test.main, { ...request, key: 'goal-1-after-stop', taskId: task.id, expectedRevision: 1 })
    expect(revised.attempts).toHaveLength(2)
  })

  it('recovers every task when one task cannot be recovered', async () => {
    const test = await fixture()
    const task = await test.service.dispatch(test.main, request)
    await waitStatus(test, 'needs-report')
    await test.main.whenIdle()
    const current = test.service.list(test.main.id).find(item => item.id === task.id)!
    await test.fiber.dispose()
    const stored = test.pool.media.get('muse_coordination')!.tables.get('tasks')!
    const broken: CoordinationTask = { ...current, id: brandString<CoordinationTaskId>('task-0-broken'), owner: SessionId('missing-main'),
      attempts: [{ ...latest(current), status: 'completed', notifiedStatus: null }] }
    const orphan: CoordinationTask = { ...current, id: brandString<CoordinationTaskId>('task-1-orphan'),
      attempts: [{ ...latest(current), key: 'orphan', sessionId: SessionId('gone-worker'), status: 'running', notifiedStatus: null }] }
    stored.set(broken.id, broken)
    stored.set(orphan.id, orphan)
    await test.ctx.plugin(Coordinator, {})
    const abort = new AbortController()
    try {
      for await (const tasks of test.ctx.sessionCoordinator.watch(test.main.id, AbortSignal.any([abort.signal, AbortSignal.timeout(15000)]))) {
        const recovered = tasks.find(item => item.id === orphan.id)
        if (recovered !== undefined && latest(recovered).status === 'interrupted') {
          expect(latest(recovered).issue).toContain('App restarted')
          return
        }
      }
      throw new Error('The orphaned task was not recovered')
    } finally { abort.abort() }
  })

  it('rejects a worker summary longer than the configured limit', async () => {
    const test = await fixture(undefined, { summaryChars: 30 })
    const task = await test.service.dispatch(test.main, request)
    const worker = test.ctx.agents.get(latest(task).sessionId)!
    await worker.whenIdle()
    await expect(test.service.report(worker, task.id, 1, 'completed', 'x'.repeat(31))).rejects.toMatchObject({ code: 'INVALID_ARGS' })
    expect(latest(test.service.list(test.main.id)[0]!).status).not.toBe('finishing')
    const reported = await test.service.report(worker, task.id, 1, 'completed', 'x'.repeat(30))
    expect(latest(reported).report?.summary).toBe('x'.repeat(30))
  })

  it('lets an assigned worker ask a question whose answer a tool verifies in that Session', async () => {
    const test = await fixture()
    let executions = 0
    test.ctx.tools.register(defineTool({ name: 'ask_user_question', description: 'Test question',
      parameters: { questions: { type: 'array', required: true, items: { type: 'object', additionalProperties: true, properties: {} } } },
      output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
      async execute() { executions++; return 'answered' } }))
    const task = await test.service.dispatch(test.main, request)
    await waitStatus(test, 'needs-report')
    const worker = test.ctx.agents.get(latest(task).sessionId)!
    const asked = await executeModelToolFixture(test.ctx, { agent: worker, name: 'ask_user_question',
      arguments: { questions: [{ id: `content-listening-${'a'.repeat(64)}`, question: '是否已完整试听？', options: [{ label: '是' }, { label: '否' }] }] },
      callId: ToolCallId('worker-question'), signal: new AbortController().signal })
    expect(asked.isError).not.toBe(true)
    expect(executions).toBe(1)
    const log = await test.ctx.sessionQuery.readSession(worker.id)
    const brief = log.events.find(event => event.type === 'user/message' && event.data.id === latest(task).briefId)
    expect(JSON.stringify(brief)).toContain('outcome needs-input')
  })

  it('forwards the user reply to a needs-input question when Main revises the task in the same worker', async () => {
    const test = await fixture([
      textResponse('main'),
      (options) => {
        const message = options.messages.findLast(item => item.role === 'user' && item.source?.kind === 'muse-coordination')
        if (message?.source?.kind !== 'muse-coordination') throw new Error('Assignment missing')
        return toolCallResponse('question', 'coordinator_report', { task_id: message.source.taskId, revision: message.source.revision, outcome: 'needs-input', summary: '用A方案还是B方案？' })
      },
      ...Array.from({ length: 30 }, () => textResponse('ack')),
    ])
    const task = await test.service.dispatch(test.main, request)
    const asked = await waitStatus(test, 'needs-input')
    expect(latest(asked).report?.summary).toBe('用A方案还是B方案？')
    await test.main.whenIdle()
    const owner = await test.ctx.sessionQuery.readSession(test.main.id)
    const receipt = owner.events.find(event => event.type === 'user/message' && event.data.source.kind === 'muse-coordination')
    expect(JSON.stringify(receipt)).toContain('plain text, not a card')
    test.main.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: '用B方案' }] }))
    await test.main.whenIdle()
    const revised = await test.service.dispatch(test.main, { ...request, key: 'goal-1-answer', taskId: task.id, expectedRevision: 1,
      sessionId: latest(task).sessionId })
    const worker = test.ctx.agents.get(latest(revised).sessionId)!
    expect(worker.id).toBe(latest(task).sessionId)
    await worker.whenIdle()
    const log = await test.ctx.sessionQuery.readSession(worker.id)
    const input = log.events.find(event => event.type === 'user/message' && event.data.id === latest(revised).messageId)
    expect(JSON.stringify(input)).toContain('用B方案')
  })

  it('forwards only the latest Main human message to a fresh worker and says so in the routing prompt', async () => {
    const test = await fixture()
    test.main.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: '开始写第4集' }] }))
    await test.main.whenIdle()
    const task = await test.service.dispatch(test.main, { ...request, key: 'episode-4' })
    const worker = test.ctx.agents.get(latest(task).sessionId)!
    await worker.whenIdle()
    const log = await test.ctx.sessionQuery.readSession(worker.id)
    const humans = JSON.stringify(log.events.filter(event => event.type === 'user/message' && event.data.source.kind === 'user'))
    expect(humans).toContain('开始写第4集')
    expect(humans).not.toContain('第3集不要动')
    expect(JSON.stringify(test.adapter.requests)).toContain('更早的消息不会转发')
  })

})
