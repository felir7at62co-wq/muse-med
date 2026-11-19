/** Main identity, routing authority, read views, dispatch preconditions and fresh-worker delivery failures. */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { Service } from '@deepseek-ai/cordis'
import type { Context } from '@deepseek-ai/cordis'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { brandString } from '@deepseek-ai/dsh-brand'
import { SessionId } from '@deepseek-ai/dsh-session'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import type { SessionRequestId } from '@deepseek-ai/dsh-api-session-controller/types'
import type {} from '@deepseek-ai/dsh-agent-preset-registry'
import type {} from '@deepseek-ai/dsh-tool-jubian'
import Coordinator, { type Config } from '../src/index.ts'
import { latest } from '../src/ledger.ts'
import type { AssignmentStatus, CoordinationTask, CoordinationTaskId, DispatchRequest } from '../src/types.ts'
import { setup, textResponse } from './fixture.ts'

async function fixture(config: Config = {}) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-coordination-guards-'))
  const cleanup: { ctx?: Context } = {}
  onTestFinished(async () => {
    if (cleanup.ctx !== undefined) await cleanup.ctx.fiber.dispose()
    await rm(root, { recursive: true, force: true })
  })
  const test = await setup(root, Array.from({ length: 40 }, () => textResponse('ack')), undefined, config)
  cleanup.ctx = test.ctx
  const main = await test.makeAgent('main', 'main-session')
  main.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: '改第二集，第三集不要动。' }] }))
  await main.whenIdle()
  return { ...test, main, root }
}

type Fixture = Awaited<ReturnType<typeof fixture>>

const request: DispatchRequest = { key: 'goal-1', title: '修改第二集', instructions: 'Revise episode 2 only.', reason: '已有稿件' }

/** Create an Agent whose Session records only the given metadata. */
async function bareAgent(test: Fixture, id: string, meta: { agentPreset?: string; origin?: 'subagent'; parentSession?: SessionId; cwd?: string } = {}) {
  const handle = await test.ctx.agents.create({ sessionId: SessionId(id), meta, agentOptions: { provider: 'mock', model: 'mock' } })
  return handle.agent
}

function humanInput(text: string) {
  return createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text }] })
}

async function waitTask(test: Fixture, owner: SessionId, ready: (task: CoordinationTask) => boolean): Promise<CoordinationTask> {
  const abort = new AbortController()
  const signal = AbortSignal.any([abort.signal, AbortSignal.timeout(15000)])
  try {
    for await (const tasks of test.ctx.sessionCoordinator.watch(owner, signal)) {
      const task = tasks.find(ready)
      if (task !== undefined) return task
    }
    throw new Error(`No task became ready: ${JSON.stringify(test.ctx.sessionCoordinator.list(owner))}`)
  } finally { abort.abort() }
}

const reaches = (status: AssignmentStatus) => (task: CoordinationTask): boolean => latest(task).status === status

async function workerText(test: Fixture, task: CoordinationTask): Promise<string> {
  const worker = test.ctx.agents.get(latest(task).sessionId)
  if (worker === undefined) throw new Error('Worker is not live')
  await worker.whenIdle()
  return JSON.stringify((await test.ctx.sessionQuery.readSession(worker.id)).events)
}

/** Routing role composed by a preset registry, independent of the Session header. */
class PresetRegistryFixture extends Service {
  constructor(ctx: Context) { super(ctx, 'agentPresets') }
  composedPreset(): string { return 'short-drama' }
}

describe('Main Session identity', () => {
  it('refuses a configuration whose routing and worker presets are the same', async () => {
    const test = await fixture()
    await test.fiber.dispose()
    await expect(test.ctx.plugin(Coordinator, { mainPreset: 'same', workerPreset: 'same' }).await())
      .rejects.toThrow('Coordinator and worker presets must differ')
  })

  it('recreates a missing Main Session under its retained identity', async () => {
    const test = await fixture()
    await test.service.openMain()
    await test.fiber.dispose()
    test.pool.media.get('muse_coordination')!.tables.get('entry')!.set('main', 'session-retained-main')
    await test.ctx.plugin(Coordinator, {})
    const id = await test.ctx.sessionCoordinator.openMain()
    expect(id).toBe('session-retained-main')
    expect(test.ctx.agents.get(id)?.session.header.agentPreset).toBe('main-session')
  })

  it('unarchives the Main Session when it is opened again', async () => {
    const test = await fixture()
    const id = await test.service.openMain()
    await test.ctx.workspaceRegistry.archiveSession(id)
    expect(test.ctx.workspaceRegistry.archivedSessionIds).toContain(id)
    expect(await test.service.openMain()).toBe(id)
    expect(test.ctx.workspaceRegistry.archivedSessionIds).not.toContain(id)
  })

  it('rejects a Main Session whose creation returns another identity', async () => {
    const test = await fixture()
    vi.spyOn(test.ctx.sessionController, 'create').mockResolvedValue({ sessionId: SessionId('session-other') })
    await expect(test.service.openMain()).rejects.toThrow('Main Session creation returned another identity')
  })

  it('rejects opening Main when its Agent cannot be resolved', async () => {
    const test = await fixture()
    vi.spyOn(test.ctx.sessionController, 'resolveAgent')
      .mockResolvedValue({ error: new RemoteError('session/agent-busy', 'Main is held elsewhere', { reason: 'test' }) })
    await expect(test.service.openMain()).rejects.toThrow('Main is held elsewhere')
  })

  it('rejects coordination calls after the plugin unloads', async () => {
    const test = await fixture()
    const service = test.service
    await test.fiber.dispose()
    await expect(service.stop(test.main.id, brandString<CoordinationTaskId>('task-any'), 1)).rejects.toThrow('Coordinator is unloading')
  })
})

describe('routing authority', () => {
  it('requires a human request in Main before routing', async () => {
    const test = await fixture()
    const quiet = await test.makeAgent('quiet-main', 'main-session')
    await expect(test.service.search(quiet, '')).rejects.toThrow('An owner request is required before coordinating work')
  })

  it('refuses routing for a request another principal submitted', async () => {
    const test = await fixture()
    const shared = await test.makeAgent('shared-main', 'main-session')
    shared.session.append('user/message', createUserMessage({
      source: { kind: 'user', rpcId: brandString<SessionRequestId>('rpc-guest'), principal: { kind: 'owner' } },
      content: [{ type: 'text', text: 'Route this for me.' }],
    }), { surfaceOp: 'append' })
    await expect(test.service.search(shared, '')).rejects.toThrow('Cross-session coordination requires the local profile owner')
  })

  it('recognizes Main by the preset its registry composes', async () => {
    const test = await fixture()
    const registry = await test.ctx.plugin(PresetRegistryFixture)
    await expect(test.service.search(test.main, '')).rejects.toThrow('Only a live main-session Agent can route work')
    await registry.dispose()
    expect(JSON.parse(await test.service.search(test.main, ''))).toMatchObject({ sessions: [] })
  })
})

describe('Main read views', () => {
  it('lists Sessions without a directory or preset, and returns the excerpt of a full-text match', async () => {
    const test = await fixture()
    const bare = await bareAgent(test, 'bare')
    bare.session.append('user/message', humanInput('无目录的会话'), { surfaceOp: 'append' })
    const listed = JSON.parse(await test.service.search(test.main, '')) as { sessions: Record<string, unknown>[] }
    expect(listed.sessions).toEqual([{ sessionId: 'bare', title: '', cwd: null, preset: null, busy: false, archived: false, excerpt: null }])
    const row = (await test.ctx.sessionQuery.listSessions(new AbortController().signal)).find(item => item.header.id === bare.id)!
    const [record] = await test.ctx.sessionQuery.listEvents(bare.id)
    const search = vi.spyOn(test.ctx.sessionQuery, 'searchSessions')
      .mockResolvedValue({ items: [{ ...row, bestMatch: { ...record!, snippet: '无目录的会话' } }] })
    const found = JSON.parse(await test.service.search(test.main, '目录')) as { sessions: { excerpt: string | null }[] }
    expect(search.mock.calls[0]?.[0]).toEqual({ query: '目录', limit: 30 })
    expect(found.sessions.map(item => item.excerpt)).toEqual(['无目录的会话'])
  })

  it('summarizes a Session that has an input but no response yet, and an empty Session', async () => {
    const test = await fixture()
    const waiting = await bareAgent(test, 'waiting', { cwd: '/waiting' })
    waiting.session.append('user/message', humanInput('还没有回复'), { surfaceOp: 'append' })
    type Excerpt = { type: string; text: string; truncated: boolean }
    const summary = JSON.parse(await test.service.summary(test.main, waiting.id)) as { excerpts: Excerpt[] }
    expect(summary.excerpts.map(({ type, text, truncated }) => ({ type, text, truncated })))
      .toEqual([{ type: 'user/message', text: '还没有回复', truncated: false }])
    const empty = await bareAgent(test, 'empty', { cwd: '/empty' })
    expect(JSON.parse(await test.service.summary(test.main, empty.id))).toMatchObject({ excerpts: [] })
  })

  it('rejects a negative history cursor and a delegated subagent Session', async () => {
    const test = await fixture()
    const worker = await test.makeAgent('ordinary')
    await expect(test.service.read(test.main, worker.id, -1)).rejects.toThrow('History cursor must be a nonnegative integer')
    const child = await bareAgent(test, 'delegated', { origin: 'subagent', parentSession: worker.id, cwd: '/main' })
    await expect(test.service.read(test.main, child.id, 0)).rejects.toThrow('Read the ordinary parent Session instead')
  })

  it('rejects an empty report or task list that already exceeds the character budget', async () => {
    const test = await fixture({ readChars: 10 })
    await expect(test.service.displayReport(test.main)).rejects.toThrow('The empty report exceeds the configured readChars budget')
    await expect(test.service.tasks(test.main)).rejects.toThrow('The empty task list exceeds the configured readChars budget')
  })
})

describe('dispatch preconditions', () => {
  it('rejects malformed requests, stale or unsettled revisions, and a worker that another task holds', async () => {
    const test = await fixture()
    await expect(test.service.dispatch(test.main, { ...request, key: ' ' })).rejects.toThrow('Dispatch key, title, instructions and reason must be nonempty')
    const task = await test.service.dispatch(test.main, request)
    await expect(test.service.dispatch(test.main, { ...request, key: 'half', taskId: task.id }))
      .rejects.toThrow('Continuations require both task id and expected revision')
    await waitTask(test, test.main.id, reaches('needs-report'))
    await expect(test.service.dispatch(test.main, { ...request, key: 'stale', taskId: task.id, expectedRevision: 2 }))
      .rejects.toThrow('Task revision changed; read tasks again')
    await expect(test.service.dispatch(test.main, { ...request, key: 'unsettled', taskId: task.id, expectedRevision: 1 }))
      .rejects.toThrow('Stop or settle the current assignment before revising it')
    const worker = latest(task).sessionId
    await expect(test.service.dispatch(test.main, { ...request, key: 'moved', title: '另一项', sessionId: worker, cwd: '/elsewhere' }))
      .rejects.toThrow('Existing worker directory cannot be changed by dispatch')
    await expect(test.service.dispatch(test.main, { ...request, key: 'held', title: '另一项', sessionId: worker }))
      .rejects.toThrow('Worker already has an unsettled task; create a fresh Session')
    expect(test.service.list(test.main.id).map(item => item.attempts.length)).toEqual([1])
  })

  it('refuses to reuse a Session whose latest selected preset is the routing preset', async () => {
    const test = await fixture()
    const promoted = await test.makeAgent('promoted')
    promoted.session.append('agent-preset/selected', { agentPreset: 'main-session' })
    await expect(test.service.dispatch(test.main, { ...request, sessionId: promoted.id }))
      .rejects.toThrow('Target is not an available ordinary execution Session')
    expect(test.service.list(test.main.id)).toEqual([])
  })

  it('rejects dispatch when Main\'s human request can no longer be read back', async () => {
    const test = await fixture()
    const read = test.ctx.sessionQuery.readSession.bind(test.ctx.sessionQuery)
    let reads = 0
    vi.spyOn(test.ctx.sessionQuery, 'readSession').mockImplementation(async (...args) => {
      const snapshot = await read(...args)
      if (args[0] !== test.main.id || ++reads < 2) return snapshot
      return { ...snapshot, events: snapshot.events.filter(event => event.type !== 'user/message') }
    })
    await expect(test.service.dispatch(test.main, request)).rejects.toThrow('A human request is required before dispatch')
    expect(test.service.list(test.main.id)).toEqual([])
  })

  it('records an unspecified request directory for a Main Session without one and keeps it on reconciliation', async () => {
    const test = await fixture()
    const main = await bareAgent(test, 'rootless-main', { agentPreset: 'main-session' })
    main.session.append('user/message', humanInput('转写第一集'), { surfaceOp: 'append' })
    await expect(test.service.dispatch(main, request)).rejects.toThrow('A worker requires an explicit working directory')
    const task = await test.service.dispatch(main, { ...request, cwd: '/explicit' })
    expect(latest(task)).toMatchObject({ cwd: '/explicit', sourceCwd: null })
    const log = await workerText(test, task)
    expect(log).toContain('Original request directory: unspecified.')
    expect(log).toContain('\\"cwd\\":null')
    await waitTask(test, main.id, reaches('needs-report'))
    const reconciled = await test.service.reconcile(main, { key: 'inspect', taskId: task.id, expectedRevision: 1,
      instructions: 'Inspect the existing result.', reason: '核对' })
    expect(latest(reconciled)).toMatchObject({ revision: 2, sourceCwd: null })
  })
})

describe('fresh worker delivery', () => {
  it('creates a fresh worker in the registered Workspace that owns its directory', async () => {
    const test = await fixture()
    const initial = await test.ctx.workspaceController.initializeDefault(new AbortController().signal)
    if (initial === undefined) throw new Error('Fixture default Workspace missing')
    const task = await test.service.dispatch(test.main, { ...request, cwd: initial.workspace.path })
    expect(test.ctx.workspaceRegistry.get(initial.workspace.workspaceId)?.sessionIds).toContain(latest(task).sessionId)
  })

  it('routes new work from a historical Main Session while retaining an earlier task’s Jubian selection', async () => {
    const test = await fixture()
    test.main.session.append('jubian/video-selection', { selection: { key: 'old-720p', modelId: 'old', modelName: 'Old',
      platformId: 'platform', standardId: 1, resolution: '720p', genTypes: [1], ratios: ['16:9'], maxDurationSeconds: null, revision: 1 } })
    await expect(test.service.dispatch(test.main, request)).rejects.toThrow('requires the Jubian video-selection service')
    const [original] = test.service.list(test.main.id)
    expect(latest(original!).videoKey).toBe('old-720p')

    await test.fiber.dispose()
    await test.ctx.plugin(Coordinator, { inheritJubianVideoSelection: false })
    const coordinator = test.ctx.sessionCoordinator
    const fresh = await coordinator.dispatch(test.main, { ...request, key: 'new-work' })
    const attempt = latest(fresh)
    expect(attempt.videoKey).toBeNull()
    const worker = test.ctx.agents.get(attempt.sessionId)!
    await worker.whenIdle()
    const log = await test.ctx.sessionQuery.readSession(worker.id)
    expect(log.events.some(event => event.type === 'user/message' && event.data.id === attempt.messageId)).toBe(true)
    expect(log.events.some(event => event.type === 'jubian/video-selection')).toBe(false)

    await coordinator.stop(test.main.id, original!.id, 1)
    await expect(coordinator.dispatch(test.main, { ...request, key: 'continue-old', taskId: original!.id, expectedRevision: 1 }))
      .rejects.toThrow('requires the Jubian video-selection service')
    const retained = coordinator.list(test.main.id).find(task => task.id === original!.id)!
    expect(retained.attempts.map(entry => entry.videoKey)).toEqual(['old-720p', 'old-720p'])
  })

  it('keeps the worker model when Main has no selected model', async () => {
    const test = await fixture()
    test.main.model.select({ provider: 'mock', model: 'mock-main' })
    const current = vi.spyOn(test.main.model, 'current').mockReturnValue(undefined)
    const task = await test.service.dispatch(test.main, request)
    current.mockRestore()
    expect(test.ctx.agents.get(latest(task).sessionId)?.model.current()?.model).toBe('mock')
  })

  it.each([
    ['the created Session has another identity', 'Worker creation returned another Session', (test: Fixture) => {
      vi.spyOn(test.ctx.sessionController, 'create').mockResolvedValue({ sessionId: SessionId('session-elsewhere') })
    }],
    ['the worker cannot be resolved', 'Worker is held elsewhere', (test: Fixture) => {
      const resolve = test.ctx.sessionController.resolveAgent.bind(test.ctx.sessionController)
      vi.spyOn(test.ctx.sessionController, 'resolveAgent').mockImplementation(async id => id === test.main.id ? resolve(id)
        : { error: new RemoteError('session/agent-busy', 'Worker is held elsewhere', { reason: 'test' }) })
    }],
    ['Main cannot be resolved for its model', 'Main is held elsewhere', (test: Fixture) => {
      const resolve = test.ctx.sessionController.resolveAgent.bind(test.ctx.sessionController)
      vi.spyOn(test.ctx.sessionController, 'resolveAgent').mockImplementation(async id => id !== test.main.id ? resolve(id)
        : { error: new RemoteError('session/agent-busy', 'Main is held elsewhere', { reason: 'test' }) })
    }],
    ['the worker cannot preserve Main\'s selected video model', 'Worker cannot preserve the selected video model', (test: Fixture) => {
      test.main.session.append('jubian/video-selection', { selection: { key: 'model-720p', modelId: 'model', modelName: 'Model',
        platformId: 'platform', standardId: 1, resolution: '720p', genTypes: [1], ratios: ['16:9'], maxDurationSeconds: null, revision: 1 } })
    }],
  ] as const)('keeps the intent interrupted without a brief when %s', async (_case, message, arrange) => {
    const test = await fixture()
    arrange(test)
    await expect(test.service.dispatch(test.main, request)).rejects.toThrow(message)
    const [task] = test.service.list(test.main.id)
    expect(latest(task!)).toMatchObject({ status: 'interrupted' })
    expect(latest(task!).issue).toContain(message)
    vi.restoreAllMocks()
    const worker = test.ctx.agents.get(latest(task!).sessionId)
    if (worker !== undefined) {
      const log = await test.ctx.sessionQuery.readSession(worker.id)
      expect(log.events.some(event => event.type === 'user/message' && event.data.id === latest(task!).briefId)).toBe(false)
    }
  })
})

describe('worker operations', () => {
  it('rejects a stop whose worker cannot be resolved and keeps the task stopping', async () => {
    const test = await fixture()
    const task = await test.service.dispatch(test.main, request)
    await waitTask(test, test.main.id, reaches('needs-report'))
    await test.main.whenIdle()
    vi.spyOn(test.ctx.sessionController, 'resolveAgent')
      .mockResolvedValue({ error: new RemoteError('session/agent-busy', 'Worker is held elsewhere', { reason: 'test' }) })
    await expect(test.service.stop(test.main.id, task.id, 1)).rejects.toThrow('Worker is held elsewhere')
    expect(latest(test.service.list(test.main.id)[0]!).status).toBe('stopping')
  })

  it('rejects a stop whose execution subtree cannot be listed before cancelling the worker', async () => {
    const test = await fixture()
    const task = await test.service.dispatch(test.main, request)
    await waitTask(test, test.main.id, reaches('needs-report'))
    await test.main.whenIdle()
    const worker = test.ctx.agents.get(latest(task).sessionId)!
    const cancel = vi.spyOn(worker, 'cancel')
    vi.spyOn(test.ctx.subagents, 'listDescendants')
      .mockResolvedValue([{ kind: 'diagnostic', id: SessionId('lost-child'), parentId: worker.id, depth: 1, reason: 'unavailable' }])
    await expect(test.service.stop(test.main.id, task.id, 1)).rejects.toThrow('Execution subtree is unavailable')
    expect(cancel).not.toHaveBeenCalled()
    expect(latest(test.service.list(test.main.id)[0]!).status).toBe('stopping')
  })

  it('rejects a report from a worker instance that is no longer live', async () => {
    const test = await fixture()
    const handle = await test.ctx.agents.create({ sessionId: SessionId('reused'), meta: { cwd: '/reused', agentPreset: 'short-drama' },
      agentOptions: { provider: 'mock', model: 'mock' } })
    const task = await test.service.dispatch(test.main, { ...request, sessionId: handle.agent.id })
    await waitTask(test, test.main.id, reaches('needs-report'))
    await handle.dispose()
    await expect(test.service.report(handle.agent, task.id, 1, 'completed', 'done'))
      .rejects.toThrow('Report requires the current live worker instance')
  })
})
