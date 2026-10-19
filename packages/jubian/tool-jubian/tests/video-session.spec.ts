/** Session video choices survive reload and cannot silently change paid generation. */
import { Context } from '@deepseek-ai/cordis'
import { afterEach, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Sessions, { SessionId, SessionLogOffset, SessionSeq } from '@deepseek-ai/dsh-session'
import Agents from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import Llm from '@deepseek-ai/dsh-llm'
import SessionProjections from '@deepseek-ai/dsh-session-projection'
import { MockAdapter, textResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import Subagents from '@deepseek-ai/dsh-subagent'
import * as Spawn from '@deepseek-ai/dsh-subagent-spawn-in-process'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import Tools from '@deepseek-ai/dsh-tools'
import { JubianClient, JubianLedger } from '@deepseek-ai/dsh-jubian'
import { JubianVideoSelection, selectedVideo, videoOptions, videoSelectionContext } from '../src/video-session.ts'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SessionVideoSelection } from '../src/video-session-types.ts'

const catalogue = JSON.parse(await readFile(new URL('../../jubian-api/tests/fixtures/catalogue-20261016.json', import.meta.url), 'utf8')) as Record<string, unknown[]>
const cleanup: Array<() => Promise<void>> = []
afterEach(async () => { for (const dispose of cleanup.splice(0).reverse()) await dispose() })

async function fixture(defaultModel?: { modelId: string; platformId: string; resolution: string }) {
  const root = await mkdtemp(join(tmpdir(), 'muse-video-choice-'))
  cleanup.push(() => rm(root, { recursive: true, force: true }))
  const ctx = new Context()
  cleanup.push(() => ctx.fiber.dispose())
  await ctx.plugin(Sessions)
  await ctx.plugin(SystemPrompt); await ctx.plugin(Tools)
  await ctx.plugin(Llm); await ctx.plugin(SessionProjections); await ctx.plugin(Agents); await ctx.plugin(AgentLoop, { agents: [] })
  const script: ConstructorParameters<typeof MockAdapter>[0] = []
  const adapter = new MockAdapter(script)
  ctx.llm.registerAdapter(['mock'], adapter)
  const agent = await ctx.agentLoop.create(SessionId('video-choice'), { provider: 'mock', model: 'mock' }, { cwd: root })
  const inject = vi.spyOn(agent, 'inject')
  const requests: Array<{ path: string; method: string; body?: Record<string, unknown> }> = []
  let board: Record<string, unknown> | undefined
  const client = new JubianClient({ credential: async () => 'fixture', baseUrl: 'https://video.invalid', fetch: async (url, init) => {
    const path = new URL(url instanceof Request ? url.url : url.toString()).pathname
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) as Record<string, unknown> : undefined
    requests.push({ path, method: init?.method ?? 'GET', ...(body ? { body } : {}) })
    if (init?.method === 'PUT' && body) board = body
    return new Response(JSON.stringify({ code: 200, data: path.includes('getSelectList') ? catalogue['1'] : path.includes('/list') ? { rows: [board], total: 1 } : board }), { status: 200 })
  } })
  const ledger = new JubianLedger({ root })
  const service = new JubianVideoSelection(ctx, { client, ledger, enabled: true, ...(defaultModel ? { defaultModel } : {}) })
  return { ctx, agent, adapter, script, inject, service, requests, root, ledger,
    setBoard(value: Record<string, unknown>) { board = value } }
}

it('records the parent video choice before a fresh spawned child requests its model', async () => {
  const f = await fixture(defaults)
  await f.ctx.plugin(Subagents)
  await f.ctx.plugin(Spawn, { providerName: 'spawn' })
  const options = await f.service.catalogue()
  const choice = options.find(option => option.maxDurationSeconds === 15)!
  await f.service.select(f.agent, choice.key, 0)
  f.script.push(textResponse('已按继承的视频模型核对本集。'))
  const run = await f.ctx.subagents.start('spawn', { parent: f.agent,
    prompt: [{ type: 'text', text: '核对本集所选视频模型与时长。' }], signal: new AbortController().signal })
  try {
    await run.result
    const child = f.ctx.agents.get(run.id)!
    const inherited = selectedVideo(child.session)
    expect(inherited).toEqual({ ...choice, revision: 1 })
    expect(child.session.snapshotEvents().filter(event => event.type === 'jubian/video-selection')).toHaveLength(1)
    const requestText = f.adapter.requests[0]!.messages.flatMap(message => message.content)
      .flatMap(part => part.type === 'text' ? [part.text] : []).join('\n')
    expect(requestText).toContain(videoSelectionContext(inherited))
    expect({ inherited, context: videoSelectionContext(inherited) }).toMatchSnapshot('fresh child video choice')
    expect(f.requests.every(request => request.method === 'GET')).toBe(true)
  } finally { await run.dispose() }
})

it('samples each new child from the latest parent choice without changing existing children or the parent', async () => {
  const f = await fixture(defaults)
  const options = await f.service.catalogue()
  const first = options.find(option => option.maxDurationSeconds === 15)!
  const second = options.find(option => option.maxDurationSeconds === 30)!
  const third = options.find(option => option.key !== first.key && option.key !== second.key)!
  await f.service.select(f.agent, first.key, 0)
  const create = async (id: string) => (await f.ctx.agents.create({ sessionId: SessionId(id), parentAgent: f.agent,
    agentOptions: { provider: 'mock', model: 'mock' },
    meta: { cwd: f.root, origin: 'subagent', parentSession: f.agent.id } })).agent
  const older = await create('video-child-before-switch')
  await f.service.select(f.agent, second.key, 1)
  const newer = await create('video-child-after-switch')
  expect(selectedVideo(older.session)).toEqual({ ...first, revision: 1 })
  expect(selectedVideo(newer.session)).toEqual({ ...second, revision: 1 })
  await f.service.select(newer, third.key, 1)
  expect(selectedVideo(f.agent.session)).toEqual({ ...second, revision: 2 })
  expect(selectedVideo(newer.session)).toEqual({ ...third, revision: 2 })
  expect(await f.service.initialize(older)).toEqual({ ...first, revision: 1 })
  expect(f.requests.every(request => request.method === 'GET')).toBe(true)
})

it('keeps forked and child-owned choices and uses the configured default when the parent has no choice', async () => {
  const f = await fixture(defaults)
  const options = await f.service.catalogue()
  const own = options.find(option => option.maxDurationSeconds === 15)!
  const emptyChild = (await f.ctx.agents.create({ sessionId: SessionId('video-child-default'), parentAgent: f.agent,
    agentOptions: { provider: 'mock', model: 'mock' },
    meta: { cwd: f.root, origin: 'subagent', parentSession: f.agent.id } })).agent
  expect(selectedVideo(emptyChild.session)).toBeNull()
  expect(await f.service.initialize(emptyChild)).toMatchObject({ ...defaults, revision: 1 })
  const parentChoice = await f.service.select(f.agent, own.key, 0)
  const seed = f.agent.session.snapshotEvents()
  const forked = (await f.ctx.agents.create({ sessionId: SessionId('video-child-fork'), parentAgent: f.agent,
    agentOptions: { provider: 'mock', model: 'mock' }, seed, inheritedEventCount: SessionLogOffset(seed.length),
    meta: { cwd: f.root, origin: 'subagent', parentSession: f.agent.id, isSeeded: true } })).agent
  expect(selectedVideo(forked.session)).toEqual(parentChoice)
  expect(forked.session.snapshotEvents().filter(event => event.type === 'jubian/video-selection')).toHaveLength(1)
  const childChoice = options.find(option => option.key !== own.key)!
  const owned = (await f.ctx.agents.create({ sessionId: SessionId('video-child-own'), parentAgent: f.agent,
    agentOptions: { provider: 'mock', model: 'mock' },
    meta: { cwd: f.root, origin: 'subagent', parentSession: f.agent.id },
    setup: async (_ctx, child) => { await f.service.select(child, childChoice.key, 0) } })).agent
  expect(selectedVideo(owned.session)?.key).toBe(childChoice.key)
  expect(owned.session.snapshotEvents().filter(event => event.type === 'jubian/video-selection')).toHaveLength(1)
  expect(f.requests.every(request => request.method === 'GET')).toBe(true)
})

it('offers every video catalogue model with exact resolution, channel and known duration limits', () => {
  const options = videoOptions(catalogue['1'])
  expect(new Set(options.map(option => option.modelId))).toEqual(new Set(catalogue['1']!.map(value => (value as { modelId: string }).modelId)))
  expect(options.find(option => option.modelId === 'doubao-seedance-2-0-260128')?.maxDurationSeconds).toBe(15)
  expect(options.find(option => option.modelId === 'doubao-seedance-2-5-260628')?.maxDurationSeconds).toBe(30)
  expect(options.some(option => option.maxDurationSeconds === null)).toBe(true)
  expect(() => videoOptions({})).toThrow()
})

it('persists only explicit choices, suppresses repeats and refuses concurrent stale selections', async () => {
  const f = await fixture()
  expect(selectedVideo(f.agent.session)).toBeNull()
  const options = await f.service.catalogue()
  const option = options.find(option => option.modelId === 'doubao-seedance-2-5-260628')!
  const selected = await f.service.select(f.agent, option.key, 0)
  expect(selectedVideo(f.agent.session)).toEqual(selected)
  expect(f.inject).toHaveBeenCalledOnce()
  expect(await f.service.select(f.agent, option.key, 1)).toEqual(selected)
  expect(f.agent.session.snapshotEvents().filter(event => event.type === 'jubian/video-selection')).toHaveLength(1)
  await expect(f.service.select(f.agent, options[0]!.key, 0)).rejects.toThrow('已改变')
  await expect(f.service.select(f.agent, 'missing-model', 1)).rejects.toThrow('不可用')
  const reopened = f.ctx.sessions.create(SessionId('reopened'), { seed: f.agent.session.snapshotEvents() })
  expect(selectedVideo(reopened)).toEqual(selected)
  const context = videoSelectionContext(selected)
  expect(context).toContain('30 秒')
  expect(context).toContain('读取剧变项目不改变')
  expect(context).toContain('duration_conflict')
})

it('publishes an initial selection and later explicit changes, and releases an aborted stream', async () => {
  const f = await fixture()
  const controller = new AbortController()
  const iterator = f.service.watch(f.agent, controller.signal)[Symbol.asyncIterator]()
  expect((await iterator.next()).value).toBeNull()
  const next = iterator.next()
  const option = (await f.service.catalogue())[0]!
  const choice = await f.service.select(f.agent, option.key, 0)
  expect((await next).value).toEqual(choice)
  const ended = iterator.next()
  controller.abort()
  expect((await ended).done).toBe(true)
})

it.each(['prepare_video', 'generate'])('refuses overlong %s packages before any PUT and names the human decision tool', async (method) => {
  const f = await fixture()
  const option = (await f.service.catalogue()).find(option => option.modelId === 'doubao-seedance-2-0-260128')!
  await f.service.select(f.agent, option.key, 0)
  f.setBoard({ id: 12, scriptId: 9, modelConfig: { duration: 25 } })
  await expect(f.service.reconcile(f.agent, { method, storyboard_id: 12, project_dir: f.root }))
    .rejects.toThrow('jubian_video_model duration_conflict')
  expect(f.requests.every(request => request.method === 'GET')).toBe(true)
})

it.each(['submit_video', 'generate'])('refuses an old %s frozen preview after a model switch without creating a paid request', async (method) => {
  const f = await fixture()
  const options = await f.service.catalogue()
  const first = options[0]!
  await f.service.select(f.agent, first.key, 0)
  const path = join(f.root, 'preview.json')
  await writeFile(path, JSON.stringify({ payload: { modelConfig: JSON.stringify({ ...first }) } }))
  const second = options.find(option => option.key !== first.key)!
  await f.service.select(f.agent, second.key, 1)
  await expect(f.service.reconcile(f.agent, { method, preview_path: path, idempotency_key: 'unsubmitted' }))
    .rejects.toThrow('SESSION_VIDEO_SELECTION_CHANGED')
  expect(f.requests.every(request => request.method === 'GET')).toBe(true)
})

it('asks once about a duration decrease and keeps the selected model when the user chooses to replan', async () => {
  const f = await fixture()
  const option = (await f.service.catalogue()).find(option => option.modelId === 'doubao-seedance-2-0-260128')!
  const chosen = await f.service.select(f.agent, option.key, 0)
  const ask = vi.fn(async () => ({ answers: [{ id: 'duration', selected: ['保留当前模型，重新拆包'] }] }))
  f.ctx.provide('userQuestions', { ask })
  expect(await f.service.ask(f.agent, { method: 'duration_conflict', reason: '本批三张卡超过15秒', duration_seconds: 25 }, new AbortController().signal))
    .toMatchObject({ action: 'replan_packages', selection: chosen, paid_requests: 0 })
  expect(ask).toHaveBeenCalledOnce()
  expect(selectedVideo(f.agent.session)).toEqual(chosen)
})

it.each(['prepare_video', 'generate'])('%s synchronizes an existing card without generating, preserving dialogue, assets, ratio and duration', async (method) => {
  const f = await fixture()
  await writeFile(join(f.root, 'project_config.json'), JSON.stringify({ jubian_script_id: 9 }))
  const option = (await f.service.catalogue()).find(option => option.modelId === 'doubao-seedance-2-5-260628' && option.resolution === '480p')!
  await f.service.select(f.agent, option.key, 0)
  const before = { modelId: 'doubao-seedance-2-0-260128', platformId: 'YU_DIAN', resolution: '720p', standardId: 11,
    genType: 3, duration: 12, ratio: '9:16', genNum: 1, prompt: '@小红说：“我回来了。”', materialList: [{ materialKey: '小红', assetId: 'a', sortOrder: 1 }] }
  f.setBoard({ id: 12, scriptId: 9, episodeId: 10, isGenerate: 1, modelConfig: JSON.stringify(before),
    storyboardMaterialList: [{ materialKey: '小红', assetId: 'a', sortOrder: 1 }] })
  await f.service.reconcile(f.agent, { method, storyboard_id: 12, project_dir: f.root })
  const writes = f.requests.filter(request => request.method !== 'GET')
  expect(writes).toHaveLength(1)
  expect(writes[0]).toMatchObject({ method: 'PUT', path: '/aigc/storyboard', body: { id: 12, isGenerate: 0 } })
  const saved = JSON.parse(String(writes[0]!.body!.modelConfig)) as Record<string, unknown>
  expect(saved).toMatchObject({ modelId: option.modelId, platformId: option.platformId, resolution: option.resolution,
    standardId: option.standardId, duration: 12, ratio: before.ratio, prompt: before.prompt, materialList: before.materialList })
  expect(writes[0]!.body!.storyboardMaterialList).toEqual([{ materialKey: '小红', assetId: 'a', sortOrder: 1 }])
})

it('can select a longer model after one batch conflict question and records the explicit answer', async () => {
  const f = await fixture()
  const options = await f.service.catalogue()
  await f.service.select(f.agent, options.find(option => option.maxDurationSeconds === 15)!.key, 0)
  const ask = vi.fn(async (request: { questions: Array<{ options: Array<{ label: string }> }> }) => ({
    answers: [{ id: 'answer', selected: [ask.mock.calls.length === 1 ? '更换模型，保留原视频包' : request.questions[0]!.options[0]!.label] }],
  }))
  f.ctx.provide('userQuestions', { ask })
  const result = await f.service.ask(f.agent, { method: 'duration_conflict', reason: '三张卡为25秒', duration_seconds: 25 }, new AbortController().signal)
  expect(result).toMatchObject({ action: 'selected', selection: { maxDurationSeconds: 30, revision: 2 }, paid_requests: 0 })
  expect(ask).toHaveBeenCalledTimes(2)
  expect(selectedVideo(f.agent.session)?.maxDurationSeconds).toBe(30)
  expect(f.requests.every(request => request.method === 'GET')).toBe(true)
})

it('permits original paid-key reconciliation after a switch and never permits a foreign ledger method', async () => {
  const f = await fixture()
  await f.ledger.begin({ idempotencyKey: 'accepted-original', method: 'storyboard_native_submit', requestSha256: 'sha256:old' })
  await expect(f.service.reconcile(f.agent, { method: 'submit_video', idempotency_key: 'accepted-original' })).resolves.toBeUndefined()
  await f.ledger.begin({ idempotencyKey: 'foreign', method: 'image_generate', requestSha256: 'sha256:other' })
  await expect(f.service.reconcile(f.agent, { method: 'submit_video', idempotency_key: 'foreign' })).rejects.toThrow('SESSION_VIDEO_MODEL_REQUIRED')
  expect(f.requests).toHaveLength(0)
})

it.each(['storyboard_generate', 'storyboard_native_submit'] as const)(
  'permits generate reconciliation of an original %s key without changing the session or card', async (method) => {
    const f = await fixture(defaults)
    await f.ledger.begin({ idempotencyKey: 'original-generate', method, requestSha256: 'sha256:original' })
    const before = f.agent.session.seq
    await expect(f.service.reconcile(f.agent, { method: 'generate', idempotency_key: 'original-generate' }))
      .resolves.toBeUndefined()
    expect(f.requests).toHaveLength(0)
    expect(f.agent.session.seq).toBe(before)
    expect(selectedVideo(f.agent.session)).toBeNull()
  },
)

it('rejects missing generate preparation arguments and foreign keys before initializing or synchronizing', async () => {
  const f = await fixture(defaults)
  await expect(f.service.reconcile(f.agent, { method: 'generate', storyboard_id: 12 }))
    .rejects.toThrow('project_dir')
  await expect(f.service.reconcile(f.agent, { method: 'generate', project_dir: f.root }))
    .rejects.toThrow('storyboard_id')
  await f.ledger.begin({ idempotencyKey: 'foreign-generate', method: 'image_generate', requestSha256: 'sha256:other' })
  await expect(f.service.reconcile(f.agent, { method: 'generate', storyboard_id: 12,
    project_dir: f.root, idempotency_key: 'foreign-generate' })).rejects.toThrow()
  expect(f.requests).toHaveLength(0)
  expect(selectedVideo(f.agent.session)).toBeNull()
})

it('checks every batch preview and permits original batch keys after a conversation switch', async () => {
  const f = await fixture()
  const option = (await f.service.catalogue())[0]!
  await f.service.select(f.agent, option.key, 0)
  const path = join(f.root, 'batch-preview.json')
  await writeFile(path, JSON.stringify({ payload: { modelConfig: { ...option, duration: 8 } } }))
  const video_previews = [{ preview_path: path, idempotency_key: 'batch-original' }]
  await expect(f.service.reconcile(f.agent, { method: 'submit_video_batch', video_previews })).resolves.toBeUndefined()
  const other = (await f.service.catalogue()).find(candidate => candidate.key !== option.key)!
  await f.service.select(f.agent, other.key, 1)
  await expect(f.service.reconcile(f.agent, { method: 'submit_video_batch', video_previews })).rejects.toThrow('SESSION_VIDEO_SELECTION_CHANGED')
  await f.ledger.begin({ idempotencyKey: 'batch-original', method: 'storyboard_native_submit', requestSha256: 'sha256:original' })
  await expect(f.service.reconcile(f.agent, { method: 'submit_video_batch', video_previews })).resolves.toBeUndefined()
})

const defaults = { modelId: 'doubao-seedance-2-5-260628', platformId: 'FANG_ZHOU', resolution: '480p' }
it('initializes the live default once without waking the model or submitting generation', async () => {
  const f = await fixture(defaults)
  const [a, b] = await Promise.all([f.service.initialize(f.agent), f.service.initialize(f.agent)])
  expect(a).toMatchObject({ ...defaults, revision: 1, maxDurationSeconds: 30 })
  expect(a).toEqual(b)
  expect(f.inject).toHaveBeenCalledOnce()
  expect(f.requests).toHaveLength(1)
  expect(f.requests[0]!.method).toBe('GET')
  expect(f.adapter.requests).toHaveLength(0)
  expect(await f.service.initialize(f.agent)).toEqual(a)
  expect(f.agent.session.snapshotEvents().filter(event => event.type === 'jubian/video-selection')).toHaveLength(1)
})
it('keeps a human choice made while the default catalogue is being read', async () => {
  const f = await fixture(defaults)
  const options = videoOptions(catalogue['1'])
  let resume!: (value: typeof options) => void
  const paused = new Promise<typeof options>((resolve) => { resume = resolve })
  vi.spyOn(f.service, 'catalogue').mockImplementationOnce(() => paused)
  const initializing = f.service.initialize(f.agent)
  const other = options.find(option => option.maxDurationSeconds === 15)!
  const chosen = await f.service.select(f.agent, other.key, 0)
  resume(options)
  expect(await initializing).toEqual(chosen)
  expect(await f.service.initialize(f.agent)).toEqual(chosen)
  expect(f.inject).toHaveBeenCalledOnce()
})
it('reports an unavailable default while allowing an explicit supported replacement', async () => {
  const f = await fixture({ ...defaults, resolution: 'missing-resolution' })
  await expect(f.service.initialize(f.agent)).rejects.toThrow('默认视频模型暂不可用')
  expect(selectedVideo(f.agent.session)).toBeNull()
  const choice = (await f.service.catalogue())[0]!
  await f.service.select(f.agent, choice.key, 0)
  expect(await f.service.initialize(f.agent)).toMatchObject({ key: choice.key })
  expect(f.requests.every(request => request.method === 'GET')).toBe(true)
})

it('reads configured defaults without resuming or changing a session, and projects legacy selections unchanged', async () => {
  const f = await fixture(defaults)
  const before = f.agent.session.seq
  expect(f.service.defaults()).toEqual(defaults)
  expect(f.requests).toHaveLength(0)
  expect(f.agent.session.seq).toBe(before)
  expect(f.ctx.sessionProjections.snapshot(f.agent.session, ['jubianVideoSelection']).values).toEqual({ jubianVideoSelection: null })
  const explicit = { ...videoOptions(catalogue['1']).find(option => option.maxDurationSeconds === 15)!, revision: 7 }
  f.agent.session.append('jubian/video-selection', { selection: explicit })
  expect(f.ctx.sessionProjections.snapshot(f.agent.session, ['jubianVideoSelection']).values).toEqual({ jubianVideoSelection: explicit })
  expect(await f.service.initialize(f.agent)).toEqual(explicit)
  expect(f.requests).toHaveLength(0)
  expect(f.inject).not.toHaveBeenCalled()
})

it('adds synchronous review advice to one selection context after the choice is committed', async () => {
  const f = await fixture()
  const option = videoOptions(catalogue['1']).find(option => option.maxDurationSeconds === 15)!
  const reviewer = vi.fn((agent: Agent, selection: SessionVideoSelection) => {
    expect(agent).toBe(f.agent)
    expect(f.service.current(agent)).toEqual(selection)
    return '上次检查的第2包请求21秒，超过当前15秒上限；完整台词未截断。'
  })
  const unregister = f.service.registerContextReviewer(reviewer)
  const before = f.agent.session.seq
  const selected = await f.service.select(f.agent, option.key, 0)
  expect(reviewer).toHaveBeenCalledOnce()
  expect(f.agent.session.eventAt(SessionSeq(before))?.type).toBe('jubian/video-selection')
  const afterSelection = f.agent.session.seq
  expect(f.inject).toHaveBeenCalledOnce()
  expect(f.inject.mock.calls[0]?.[0]).toMatchObject({ source: { kind: 'jubian-video-selection' }, content: [{ type: 'text',
    text: `${videoSelectionContext(selected)}\n上次检查的第2包请求21秒，超过当前15秒上限；完整台词未截断。` }] })
  expect(await f.service.select(f.agent, option.key, 1)).toEqual(selected)
  expect(reviewer).toHaveBeenCalledOnce()
  expect(f.inject).toHaveBeenCalledOnce()
  expect(f.agent.session.seq).toBe(afterSelection)
  unregister()
  unregister()
  const other = videoOptions(catalogue['1']).find(candidate => candidate.key !== option.key)!
  const next = await f.service.select(f.agent, other.key, 1)
  expect(reviewer).toHaveBeenCalledOnce()
  expect(f.inject.mock.calls[1]?.[0]).toMatchObject({ content: [{ type: 'text', text: videoSelectionContext(next) }] })
})

it('removes a plugin-owned reviewer when its registering fiber is disposed', async () => {
  const f = await fixture()
  const reviewer = vi.fn(() => '插件检查建议。')
  const plugin = f.ctx.plugin({ inject: ['jubianVideoSelection'], apply(scope) {
    scope.jubianVideoSelection.registerContextReviewer(reviewer)
  } })
  await plugin
  const options = videoOptions(catalogue['1'])
  const first = options[0]!
  await f.service.select(f.agent, first.key, 0)
  expect(reviewer).toHaveBeenCalledOnce()
  await plugin.dispose()
  const second = options.find(option => option.key !== first.key)!
  const selected = await f.service.select(f.agent, second.key, 1)
  expect(reviewer).toHaveBeenCalledOnce()
  expect(f.inject.mock.calls[1]?.[0]).toMatchObject({ content: [{ type: 'text', text: videoSelectionContext(selected) }] })
})

it('keeps a committed choice and other advice when one reviewer throws', async () => {
  const f = await fixture()
  f.service.registerContextReviewer(() => { throw new Error('synthetic reviewer failure') })
  const succeeding = vi.fn(() => '其余检查仍完成，仅供参考。')
  f.service.registerContextReviewer(succeeding)
  const option = videoOptions(catalogue['1'])[0]!
  const selected = await f.service.select(f.agent, option.key, 0)
  expect(f.service.current(f.agent)).toEqual(selected)
  expect(succeeding).toHaveBeenCalledOnce()
  expect(f.inject).toHaveBeenCalledOnce()
  const message = f.inject.mock.calls[0]?.[0]
  expect(message).toMatchObject({ source: { kind: 'jubian-video-selection' } })
  const content = JSON.stringify(message)
  expect(content).toContain(videoSelectionContext(selected))
  expect(content).toContain('其余检查仍完成，仅供参考。')
  expect(content).toContain('视频模型选择已保存；自动检查暂不可用')
  expect(content).not.toContain('synthetic reviewer failure')
  expect(f.adapter.requests).toHaveLength(0)
})

it('does not call a reviewer removed earlier in the same synchronous review', async () => {
  const f = await fixture()
  let unregisterLater: () => void = () => undefined
  f.service.registerContextReviewer(() => { unregisterLater(); return '' })
  const later = vi.fn(() => '已卸载检查不应进入上下文。')
  unregisterLater = f.service.registerContextReviewer(later)
  const option = videoOptions(catalogue['1'])[0]!
  const selected = await f.service.select(f.agent, option.key, 0)
  expect(later).not.toHaveBeenCalled()
  expect(f.inject).toHaveBeenCalledOnce()
  expect(f.inject.mock.calls[0]?.[0]).toMatchObject({ content: [{ type: 'text', text: videoSelectionContext(selected) }] })
})
