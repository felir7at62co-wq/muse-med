/** Keyless Loader coverage for automatic continuation after an original video receipt. */
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, onTestFinished, vi } from 'vitest'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { JubianLedger } from '@deepseek-ai/dsh-jubian'
import Llm, { createUserMessage, LlmError, ReasoningEffortId, ToolCallId } from '@deepseek-ai/dsh-llm'
import SessionStore, { Session, SessionId } from '@deepseek-ai/dsh-session'
import SessionProjections from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import LocalFileSystem from '@deepseek-ai/dsh-fs-local'
import WorkingDirectory from '@deepseek-ai/dsh-working-directory'
import Storage from '@deepseek-ai/dsh-storage'
import * as JsonStorage from '@deepseek-ai/dsh-storage-json'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import WorkspaceRegistry from '@deepseek-ai/dsh-workspace'
import * as WorkspaceOwned from '../../../../apps/desktop-host/src/workspace-owned-storage.ts'
import Tools, { TOOL_BODY_META_KEY } from '@deepseek-ai/dsh-tools'
import { executeToolFixture } from '@deepseek-ai/dsh-tool-testkit'
import { Context } from '@deepseek-ai/cordis'
import { createSessionTestController } from '../../../api/session-controller/tests/test-remote.ts'
import { MockAdapter, textResponse, toolCallResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import { MemoryCredentials } from '../../../credentials/credentials/tests/memory.ts'
import * as JsonlSessionPersistence from '../../../session/session-persistence-jsonl/src/index.ts'
import * as NativeExecutor from '@deepseek-ai/dsh-tool-executor-native'
import { configurationFixture } from '../../../settings/settings/tests/configuration-fixture.ts'
import { GenerationWatchStore, type GenerationWatchRun } from '../src/generation-watch-store.ts'
import { createGenerationWatchNotice, deliverGenerationWatchNotice, registerGenerationWatchDelivery } from '../src/generation-watch-delivery.ts'
import * as Jubian from '../src/index.ts'
import { createNativeGenerationDelivery } from '../src/generation-watch-native-delivery.ts'
import { bodyHash } from '../src/write.ts'

// Each test owns isolated storage; the real process handoff scanner has separate tests.
vi.mock('../../../../apps/desktop-host/src/workspace-handoff.ts', () => ({ assertWorkspaceMigrationHandoff: vi.fn(async () => undefined) }))

const selection = { provider: 'mock', model: 'mock' }
const model = { platformId: 'YU_DIAN', modelId: 'doubao-seedance-2-0-260128', standardId: 11, genType: 3,
  modelGenerationTypeId: 7, videoStandardId: 91, duration: 8, ratio: '9:16', resolution: '720p', genNum: 1,
  materialList: [], backupModelList: [], prompt: '@[Lead](lead) crosses a quiet street.' }
const image = 'https://cdn.invalid/lead.png'
const video = 'https://jubian-aigc.tos-cn-beijing.volces.com/test/episode-43-pack-1.mp4'
const board = { id: 1, scriptId: 2708, isGenerate: 1, storyboardName: 'EP43-P1',
  modelConfig: JSON.stringify(model), storyboardMaterialList: [{ assetId: 'asset-lead', materialAssetId: 81285,
    fileName: 'Lead', materialKey: 'lead', materialType: 'image', materialUrl: image, sortOrder: 1 }] }

it('retains a completed legacy watch without a native binding for manual review on Host startup', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'muse-generation-legacy-watch-')))
  const sessionId = SessionId('legacy-generation-owner'), key = 'a'.repeat(64)
  const id = createHash('sha256').update(JSON.stringify([sessionId, [key]])).digest('hex')
  const store = new GenerationWatchStore(join(root, 'watches'))
  const original: GenerationWatchRun = { id, sessionId, createdAt: 0, deadlineAt: 1,
    packs: [{ key, previewPath: join(root, 'legacy-preview.json'), taskId: 42,
      outcome: { status: 'failed', detail: 'Historical provider task failed' } }],
    notice: createGenerationWatchNotice('The historical task finished before native Session binding was recorded.') }
  const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
    throw new Error('Historical notice recovery must not call a provider')
  })
  let host: Context | undefined
  try {
    await store.create(original)
    const ownership = ['ownership.v1.json', 'ownership.v2.json'].map(name => join(root, 'watches', name))
    const before = await Promise.all(ownership.map(path => readFile(path)))
    host = await watchHost(root)
    const adapter = new MockAdapter([textResponse('A legacy receipt must not start an automatic turn.')])
    host.llm.registerAdapter(['mock'], adapter)
    await vi.waitFor(async () => { expect((await store.load(id))?.reviewRequired).toBe(true) })
    expect(await store.load(id)).toEqual({ ...original, reviewRequired: true })
    expect(await store.listActive()).toEqual([])
    expect(await Promise.all(ownership.map(path => readFile(path)))).toEqual(before)
    expect(host.sessions.get(sessionId)).toBeUndefined()
    expect(host.agents.get(sessionId)).toBeUndefined()
    expect(adapter.requests).toEqual([])
    expect(fetch).not.toHaveBeenCalled()
  } finally {
    try { await host?.fiber.dispose() } finally {
      fetch.mockRestore()
      await rm(root, { recursive: true, force: true })
    }
  }
})

it('preserves an actual generation notice and its model history with the producer absent', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'generation-notice-attribution-')))
  const id = SessionId('generation-notice-attribution')
  const contexts: Context[] = []
  const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
    throw new Error('Attribution readback must not call a provider')
  })
  try {
    const host = await watchHost(root, false)
    contexts.push(host)
    host.llm.registerAdapter(['mock'], new MockAdapter([textResponse('Use the recorded result.')]))
    const agent = await host.agentLoop.create(id, selection, { cwd: root })
    const notice = createGenerationWatchNotice('The existing provider task finished; continue local verification.')
    const groupOrigin = { roomId: 'saved-room', workerBotId: 'worker', requesterBotId: 'requester',
      requesterSessionId: 'saved-requester', exchangeId: 'fe7826ac-de22-4d82-99e1-d97b7859dbb4' }
    expect(host.get('museTeam')).toBeUndefined()
    await expect(deliverGenerationWatchNotice(host, id, notice, undefined, groupOrigin))
      .rejects.toThrow('Archived Bot group notices require manual ownership review')
    const projection = await registerGenerationWatchDelivery(host)
    const verifyFixture = async () => true // Tests delivery mechanics, not production authority.
    expect(await deliverGenerationWatchNotice(host, id, notice, undefined, undefined, undefined, verifyFixture, projection))
      .toBe('pending')
    await agent.whenIdle()
    expect(await host.sessions.flush(agent.session)).toBe(true)
    const before = agent.session.deriveMessages()
    const original = agent.session.snapshotEvents().find(event => event.type === 'user/message')
    expect(original?.data).toMatchObject({ id: notice.id,
      source: { kind: 'jubian-generation-watch', form: 'notice', summary: '剧变视频生成结果已核对' },
      content: [{ type: 'text', text: notice.text }] })
    await host.fiber.dispose()
    contexts.pop()

    const reader = new Context()
    contexts.push(reader)
    await reader.plugin(JsonlSessionPersistence, { root: join(root, 'sessions'), compression: 'none' })
    expect(reader.get('jubian')).toBeUndefined()
    const handle = await reader.sessionPersistence.open(id, 'read')
    try {
      const { events } = await handle.read()
      const restored = Session.create(id, events, handle.header)
      expect(events.find(event => event.type === 'user/message')).toEqual(original)
      expect(restored.deriveMessages()).toEqual(before)
    } finally { await handle.close() }
    expect(fetch).not.toHaveBeenCalled()
  } finally {
    for (const context of contexts.reverse()) await context.fiber.dispose()
    fetch.mockRestore()
    await rm(root, { recursive: true, force: true })
  }
}, 20_000)

async function watchHost(root: string, generationWatch = true, durableInboxClaims = generationWatch): Promise<Context> {
  const { ctx } = await configurationFixture({ hmr: false, rows: [
    { id: 'prompt', name: 'cordis:prompt' }, { id: 'tools', name: 'cordis:tools' },
    { id: 'executor', name: 'cordis:executor' },
    { id: 'credentials', name: 'cordis:credentials', config: { JUBIANAI_ADMIN_TOKEN: 'offline-token' } },
    { id: 'llm', name: 'cordis:llm' }, { id: 'sessions', name: 'cordis:sessions' },
    { id: 'projections', name: 'cordis:projections' }, { id: 'agents', name: 'cordis:agents' },
    { id: 'persistence', name: 'cordis:persistence', config: { root: join(root, 'sessions'), compression: 'none' } },
    { id: 'loop', name: 'cordis:loop', config: { agents: [], durableInboxClaims } },
    { id: 'controller', name: 'cordis:controller' },
    { id: 'jubian', name: 'cordis:jubian', config: { baseUrl: 'https://watch.invalid', workspaceSecrets: false,
      ledgerRoot: join(root, 'ledger'), generationWatch, generationWatchRoot: join(root, 'watches'),
      watchPollIntervalMs: 10, watchTimeoutMs: 60_000 } },
  ], builtins: {
    prompt: SystemPrompt, tools: Tools, executor: NativeExecutor, credentials: MemoryCredentials, llm: Llm, sessions: SessionStore,
    projections: SessionProjections, agents: AgentRegistry, loop: AgentLoop, persistence: JsonlSessionPersistence,
    controller: { inject: ['llm', 'sessions', 'sessionProjections', 'agents'], apply: async (scope: Context) => {
      await createSessionTestController(scope, { cwd: root, defaultModelSelection: () => selection })
    } },
    jubian: Jubian,
  } })
  for (const entry of ctx.loader.entries()) await entry.fiber?.await()
  await ctx.plugin(LocalFileSystem, { cwd: root })
  await ctx.plugin(WorkingDirectory)
  await ctx.plugin(Storage)
  const legacy = join(root, 'legacy')
  await mkdir(legacy, { recursive: true })
  await ctx.plugin(JsonStorage, { root: legacy })
  await ctx.plugin(WorkspaceOwned, { root: join(root, 'owned'), sourceBackend: 'json' })
  await ctx.plugin(StorageDomain, { backend: 'json', routes: { workspace: 'muse-workspace-owned' } })
  await ctx.plugin(WorkspaceRegistry)
  return ctx
}

it('wakes an idle owner after provider completion from the normal video submission tool', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'muse-generation-loader-')))
  const ledgerRoot = join(root, 'ledger')
  const watchRoot = join(root, 'watches')
  let ctx: Context | undefined
  let finished = false
  let child: Record<string, unknown> | undefined
  const calls: { method: string; path: string }[] = []
  const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
    const request = new URL(url instanceof Request ? url.url : url)
    if (request.hostname !== 'watch.invalid') throw new Error('Unexpected provider host')
    const path = request.pathname.replace(/^\/prod-api(?=\/)/u, '')
    const method = String(init?.method)
    calls.push({ method, path })
    if (method === 'PUT') throw new Error('An original intent must never send another PUT')
    const answer = (data: unknown) => new Response(JSON.stringify({ code: 200, data }))
    const taskStatus = finished ? 'succeeded' : 'submit'
    const task = { id: 42, scriptId: 2708, storyboardId: 1, taskType: 1, taskStatus }
    if (path === '/aigc/storyboard/1') return answer(board)
    if (path === '/aigc/asset/81285') return answer({ id: 81285, scriptId: 2708, assetUrl: image, name: 'Lead' })
    if (path === '/aigc/material/list') return answer({ total: 1, rows: [{ id: 1, scriptId: 2708,
      assetId: 81285, hsAssetId: 'asset-lead', assetUrl: image, assetName: 'Lead', hsAssetStatus: 'Active', isUsed: 1 }] })
    if (path === '/model/charge/getSelectList') return answer([{ id: 11, standardId: 11, modelId: model.modelId,
      platformId: model.platformId, duration: 8, genNum: 1, genTypes: [{ id: 7, type: 3 }],
      videoStandards: [{ id: 91, ratio: '9:16', resolution: '720p', genNum: 1 }] }])
    if (path === '/admin/aigc/video/task/list') return answer(child ? { total: 1, rows: [task] } : { total: 0, rows: [] })
    if (path === '/admin/aigc/video/task/42') return answer(task)
    if (path === '/admin/aigc/video/task/sub/list' && child) {
      return answer({ total: 1, rows: [{ ...child, taskStatus,
        resultList: finished ? [{ tosVideoUrl: video, firstResultId: 61 }] : [] }] })
    }
    throw new Error(`Unexpected provider route: ${method} ${path}`)
  })
  try {
    await mkdir(ledgerRoot)
    await writeFile(join(root, 'project_config.json'), JSON.stringify({ jubian_script_id: 2708 }))
    const host = await watchHost(root)
    ctx = host
    const prepared = await executeToolFixture(host, { callId: ToolCallId('prepare-ep43'), name: 'jubian_storyboard',
      arguments: { method: 'prepare_video', storyboard_id: 1, project_dir: root },
      signal: new AbortController().signal })
    expect(prepared.isError, JSON.stringify(prepared.content)).toBe(false)
    expect(prepared.meta).toBeUndefined()
    const text = prepared.content.find(block => block.type === 'text')
    if (text?.type !== 'text') throw new Error('Expected native preview')
    const { preview_path, idempotencyKey } = JSON.parse(text.text) as { preview_path: string; idempotencyKey: string }
    const { payload } = JSON.parse(await readFile(preview_path, 'utf8')) as { payload: Record<string, unknown> }
    child = { id: 51, aigcVideoTaskId: 42, storyboardId: 1, resolution: '720p',
      modelConfig: payload.modelConfig, imageMaterials: payload.storyboardMaterialList }
    const ledger = new JubianLedger({ root: ledgerRoot })
    await ledger.begin({ idempotencyKey, scriptId: 2708, method: 'storyboard_native_submit',
      requestSha256: bodyHash(payload) })
    await ledger.settle(idempotencyKey, { outcome: 'accepted', httpStatus: 200,
      applicationCode: 200, responseSha256: null })

    const adapter = new MockAdapter([
      toolCallResponse('original-submit', 'jubian_storyboard',
        { method: 'submit_video', preview_path, idempotency_key: idempotencyKey }),
      textResponse('Provider is generating the pack.'),
      textResponse('Continue with the verified pack.'),
    ])
    host.llm.registerAdapter(['mock'], adapter)
    const agent = await host.agentLoop.create(SessionId('generation-watch-owner'), selection, { cwd: root })
    await (await host.workspaceRegistry.create(root)).attachSession(agent.id)
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Continue EP43.' }], source: { kind: 'user' } }))
    await agent.whenIdle()
    expect(agent.status).toBe('idle')
    expect(adapter.requests).toHaveLength(2)
    const store = new GenerationWatchStore(watchRoot)
    const [run] = await store.listActive()
    if (!run) throw new Error('The normal video entry did not persist a watch')
    expect(run.packs).toMatchObject([{ key: idempotencyKey, taskId: 42 }])
    const submitted = agent.session.snapshotEvents().find(event => event.type === 'tool/result'
      && event.data.message.toolCallId === ToolCallId('original-submit'))
    expect(submitted?.data).toMatchObject({ meta: { [TOOL_BODY_META_KEY]: { generationWatchId: run.id,
      submission: { method: 'submit_video', idempotency_key: idempotencyKey, preview_path } } } })

    finished = true
    await vi.waitFor(async () => {
      expect(adapter.requests).toHaveLength(3)
      expect((await store.load(run.id))?.notice?.deliveredAt).toEqual(expect.any(Number))
    }, { timeout: 5000 })
    await agent.whenIdle()
    const watch = await store.load(run.id)
    expect(watch?.packs).toMatchObject([{ taskId: 42, outcome: { status: 'succeeded',
      outputs: [{ subtask_id: 51, video_url: video }] } }])
    const handle = await host.sessionPersistence.open(agent.session.id, 'read')
    try {
      const { events } = await handle.read()
      const notices = events.flatMap(event => event.type === 'user/message' && event.data.source.kind === 'jubian-generation-watch'
        ? [event.data] : [])
      expect(notices).toHaveLength(1)
      expect(notices[0]?.id).toBe(watch?.notice?.id)
    } finally { await handle.close() }
    expect(calls.filter(call => call.method === 'PUT')).toHaveLength(0)
    expect(await ledger.records()).toHaveLength(1)
  } finally {
    await ctx?.fiber.dispose()
    fetch.mockRestore()
    await rm(root, { recursive: true, force: true })
  }
}, 20_000)

type AdapterScript = ConstructorParameters<typeof MockAdapter>[0]

async function originalVideoFixture(script: AdapterScript, reasoningEffort?: ReasoningEffortId, initialDispatch = false,
  method: 'submit_video' | 'generate' = 'submit_video') {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'muse-generation-native-loader-')))
  let host: Context | undefined
  let finished = false
  const childHolder: { value?: Record<string, unknown> } = {}
  const calls: { method: string; path: string }[] = []
  const dispatchOrder: { kind: 'fence' | 'put'; runId?: string; key?: string }[] = []
  // oxlint-disable-next-line typescript/unbound-method -- The observation calls the real method with its Store receiver.
  const markStarted = GenerationWatchStore.prototype.markDispatchStarted
  const fence = initialDispatch ? vi.spyOn(GenerationWatchStore.prototype, 'markDispatchStarted').mockImplementation(function (this: GenerationWatchStore, id, key) {
    const pending = markStarted.call(this, id, key)
    void pending.then(() => { dispatchOrder.push({ kind: 'fence', runId: id, key }) }, () => {})
    return pending
  }) : undefined
  const bytes = Buffer.from('000000106674797069736f6d00000000', 'hex')
  const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const request = new URL(input instanceof Request ? input.url : input)
    const method = String(init?.method)
    if (request.href === video && method === 'GET') {
      calls.push({ method, path: video })
      return new Response(Uint8Array.from(bytes))
    }
    if (request.hostname !== 'watch.invalid') throw new Error('Unexpected provider host')
    const path = request.pathname.replace(/^\/prod-api(?=\/)/u, '')
    calls.push({ method, path })
    const answer = (data: unknown) => new Response(JSON.stringify({ code: 200, data }))
    if (method === 'PUT') {
      if (!initialDispatch || path !== '/aigc/storyboard') {
        throw new Error('An original intent must never send another PUT')
      }
      dispatchOrder.push({ kind: 'put' })
      childHolder.value = preparedChild
      return answer(null)
    }
    const taskStatus = finished ? 'succeeded' : 'submit'
    const task = { id: 42, scriptId: 2708, storyboardId: 1, taskType: 1, taskStatus }
    if (path === '/aigc/storyboard/1') return answer(board)
    if (path === '/aigc/asset/81285') return answer({ id: 81285, scriptId: 2708, assetUrl: image, name: 'Lead' })
    if (path === '/aigc/material/list') return answer({ total: 1, rows: [{ id: 1, scriptId: 2708,
      assetId: 81285, hsAssetId: 'asset-lead', assetUrl: image, assetName: 'Lead', hsAssetStatus: 'Active', isUsed: 1 }] })
    if (path === '/model/charge/getSelectList') return answer([{ id: 11, standardId: 11, modelId: model.modelId,
      platformId: model.platformId, duration: 8, genNum: 1, genTypes: [{ id: 7, type: 3 }],
      videoStandards: [{ id: 91, ratio: '9:16', resolution: '720p', genNum: 1 }] }])
    if (path === '/admin/aigc/video/task/list') return answer(childHolder.value ? { total: 1, rows: [task] } : { total: 0, rows: [] })
    if (path === '/admin/aigc/video/task/42') return answer(task)
    if (path === '/admin/aigc/video/task/sub/list' && childHolder.value) return answer({ total: 1, rows: [{ ...childHolder.value, taskStatus,
      resultList: finished ? [{ tosVideoUrl: video, firstResultId: 61 }] : [] }] })
    throw new Error(`Unexpected provider route: ${method} ${path}`)
  })
  onTestFinished(async () => {
    try { await host?.fiber.dispose() } finally {
      fence?.mockRestore(); fetch.mockRestore()
      await rm(root, { recursive: true, force: true })
    }
  })
  await mkdir(join(root, 'ledger'))
  if (initialDispatch) await writeFile(join(root, 'ledger', 'authorization.json'), JSON.stringify({ version: 1,
    projects: { '2708': { limit: '1000', unit: 'CNY', estimates: { storyboard_native_submit: '1' } } } }))
  await writeFile(join(root, 'project_config.json'), JSON.stringify({ jubian_script_id: 2708 }))
  host = await watchHost(root)
  const prepared = await executeToolFixture(host, { callId: ToolCallId('prepare-original'), name: 'jubian_storyboard',
    arguments: { method: 'prepare_video', storyboard_id: 1, project_dir: root }, signal: new AbortController().signal })
  expect(prepared.isError, JSON.stringify(prepared.content)).toBe(false)
  const text = prepared.content.find(block => block.type === 'text')
  if (text?.type !== 'text') throw new Error('Expected native preview')
  const { preview_path, idempotencyKey } = JSON.parse(text.text) as { preview_path: string; idempotencyKey: string }
  const { payload } = JSON.parse(await readFile(preview_path, 'utf8')) as { payload: Record<string, unknown> }
  const preparedChild: Record<string, unknown> = { id: 51, aigcVideoTaskId: 42, storyboardId: 1, resolution: '720p',
    modelConfig: payload.modelConfig, imageMaterials: payload.storyboardMaterialList }
  if (!initialDispatch) childHolder.value = preparedChild
  const ledger = new JubianLedger({ root: join(root, 'ledger') })
  if (!initialDispatch) {
    await ledger.begin({ idempotencyKey, scriptId: 2708, method: 'storyboard_native_submit', requestSha256: bodyHash(payload) })
    await ledger.settle(idempotencyKey, { outcome: 'accepted', httpStatus: 200, applicationCode: 200, responseSha256: null })
  }
  const adapter = new MockAdapter([toolCallResponse('original-submit', 'jubian_storyboard',
    { method, preview_path, idempotency_key: idempotencyKey }), textResponse('Provider is generating the pack.'), ...script],
  reasoningEffort === undefined ? undefined : { efforts: [{ id: reasoningEffort, name: 'High' }] })
  host.llm.registerAdapter(['mock'], adapter)
  const agent = await host.agentLoop.create(SessionId('original-loader-owner'), { ...selection,
    ...(reasoningEffort === undefined ? {} : { reasoningEffort }) }, { cwd: root })
  await (await host.workspaceRegistry.create(root)).attachSession(agent.id)
  agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Continue EP43.' }], source: { kind: 'user' } }))
  await agent.whenIdle()
  expect(adapter.requests).toHaveLength(2)
  const store = new GenerationWatchStore(join(root, 'watches')), [run] = await store.listActive()
  if (run?.binding === undefined) throw new Error('The actual submission did not record its native binding: '+JSON.stringify(agent.session.snapshotEvents().filter(event => event.type === 'tool/result' || event.type === 'turn/end')))
  const workspace = host.workspaceRegistry.get(run.binding.workspaceId)
  expect(workspace?.sessionIds).toContain(agent.id)
  return { root, host, agent, adapter, store, run, binding: run.binding, bytes, calls, dispatchOrder,
    originalRequest: { method, preview_path, idempotency_key: idempotencyKey },
    complete: () => { finished = true },
    reopen: async (durableInboxClaims = true, generationWatch = true) => {
      await host?.fiber.dispose(); host = await watchHost(root, generationWatch, durableInboxClaims); return host
    } }
}

async function parkedNativeDelivery() {
  const h = await originalVideoFixture([textResponse('Do not continue before Host restart.')])
  const entered = Promise.withResolvers<undefined>()
  const maintenance = h.agent.runMaintenance(signal => new Promise<void>((resolve) => {
    entered.resolve(undefined)
    signal.addEventListener('abort', () => { resolve() }, { once: true })
  }))
  await entered.promise
  h.complete()
  await vi.waitFor(async () => {
    const run = await h.store.load(h.run.id)
    expect(run?.notice?.id).toEqual(expect.any(String))
    expect(h.agent.inbox.nextTurn.some(message => message.id === run?.notice?.id)).toBe(true)
  })
  const host = await h.reopen(true, false)
  await maintenance
  const saved = await h.store.load(h.run.id)
  if (saved?.notice === undefined) throw new Error('Expected the parked original notice')
  const projection = await registerGenerationWatchDelivery(host)
  const deliver = createNativeGenerationDelivery(host, projection)
  const resolved = await host.sessionController.resolveAgent(saved.sessionId)
  if ('error' in resolved) throw resolved.error
  expect(projection.stateOf(resolved.agent.session).notices[saved.notice.id]).toBe('guard-rejected')
  return { h, host, saved, notice: saved.notice, projection, deliver, agent: resolved.agent }
}

it('retains a parked native notice when the original Session flush fails and resumes it once on retry', async () => {
  const f = await parkedNativeDelivery()
  const adapter = new MockAdapter([textResponse('Continue after the source persisted.')])
  f.host.llm.registerAdapter(['mock'], adapter)
  const flushing = vi.spyOn(f.host.sessions, 'flush').mockResolvedValueOnce(false)
  try {
    await expect(f.deliver(f.saved.sessionId, f.notice, new AbortController().signal, undefined, undefined, f.saved))
      .rejects.toThrow('Original video submission did not persist')
  } finally { flushing.mockRestore() }
  expect(adapter.requests).toEqual([])
  expect(f.agent.inbox.nextTurn).toEqual([])
  expect(await f.deliver(f.saved.sessionId, f.notice, new AbortController().signal, undefined, undefined, f.saved)).toBe('pending')
  await f.agent.whenIdle()
  expect(await f.deliver(f.saved.sessionId, f.notice, new AbortController().signal, undefined, undefined, f.saved)).toBe('settled')
  expect(adapter.requests).toHaveLength(1)
  expect(f.agent.session.snapshotEvents().filter(event => event.type === 'user/message' && event.data.id === f.notice.id)).toHaveLength(1)
  expect(f.h.calls.filter(call => call.method === 'PUT')).toEqual([])
})

it('releases the held native binding when enqueue persistence fails', async () => {
  const f = await parkedNativeDelivery()
  const adapter = new MockAdapter(['hang'])
  f.host.llm.registerAdapter(['mock'], adapter)
  const flush = f.host.sessions.flush.bind(f.host.sessions), followup = f.agent.followup.bind(f.agent)
  let failEnqueueFlush = false
  const enqueue = vi.spyOn(f.agent, 'followup').mockImplementation((message) => {
    followup(message)
    failEnqueueFlush = message.id === f.notice.id
  })
  const flushing = vi.spyOn(f.host.sessions, 'flush').mockImplementation((session) => {
    if (session === f.agent.session && failEnqueueFlush) { failEnqueueFlush = false; return Promise.resolve(false) }
    return flush(session)
  })
  try {
    await expect(f.deliver(f.saved.sessionId, f.notice, new AbortController().signal, undefined, undefined, f.saved))
      .rejects.toThrow('Session persistence did not acknowledge the generation watch notice')
  } finally { flushing.mockRestore(); enqueue.mockRestore() }
  await f.agent.whenIdle()
  expect(() => { f.agent.model.select({ provider: 'mock', model: 'after-failed-delivery' }) }).not.toThrow()
  expect(f.agent.model.current()?.model).toBe('after-failed-delivery')
  expect(f.h.calls.filter(call => call.method === 'PUT')).toEqual([])
})

it('records the generate alias with its original native submission evidence', async () => {
  const h = await originalVideoFixture([], undefined, false, 'generate')
  const result = h.agent.session.snapshotEvents().find(event => event.type === 'tool/result'
    && event.data.message.toolCallId === ToolCallId('original-submit'))
  if (result?.type !== 'tool/result') throw new Error('Missing aliased original submission result')
  expect(result.data.message.isError).not.toBe(true)
  expect(result.data.meta).toMatchObject({ [TOOL_BODY_META_KEY]: {
    generationWatchId: h.run.id, submission: h.originalRequest, binding: h.binding,
  } })
  expect(h.originalRequest.method).toBe('generate')
  expect(h.run.binding).toEqual(h.binding)
  expect(h.run.packs).toMatchObject([{ key: h.originalRequest.idempotency_key,
    previewPath: h.originalRequest.preview_path, taskId: 42 }])
  expect(h.calls.filter(call => call.method === 'PUT')).toEqual([])
})

it('passes an auxiliary model stream without a Session identity through the native watcher', async () => {
  const h = await originalVideoFixture([textResponse('Auxiliary text.')])
  const before = h.agent.session.snapshotEvents()
  const chunks = []
  for await (const chunk of h.host.llm.stream({ provider: selection.provider, model: selection.model,
    messages: [], purpose: 'session-title' })) chunks.push(chunk)
  expect(chunks).toEqual(textResponse('Auxiliary text.'))
  expect(h.adapter.requests).toHaveLength(3)
  expect(h.adapter.requests[2]?.sessionId).toBeUndefined()
  expect(h.adapter.requests[2]?.purpose).toBe('session-title')
  expect((await h.store.load(h.run.id))?.binding).toEqual(h.binding)
  expect(h.agent.session.snapshotEvents()).toEqual(before)
  expect(h.calls.filter(call => call.method === 'PUT')).toEqual([])
})

it('rechecks a settled native notice after a flush failure without starting another turn', async () => {
  const h = await originalVideoFixture([textResponse('Existing result reviewed.')])
  h.complete()
  await vi.waitFor(async () => {
    expect((await h.store.load(h.run.id))?.notice?.deliveredAt).toEqual(expect.any(Number))
  })
  await h.agent.whenIdle()
  const saved = await h.store.load(h.run.id)
  if (saved?.notice === undefined) throw new Error('Expected the completed original notice')
  const host = await h.reopen(true, false)
  const adapter = new MockAdapter([])
  host.llm.registerAdapter(['mock'], adapter)
  const projection = await registerGenerationWatchDelivery(host)
  const deliver = createNativeGenerationDelivery(host, projection)
  const resolved = await host.sessionController.resolveAgent(saved.sessionId)
  if ('error' in resolved) throw resolved.error
  const before = resolved.agent.session.snapshotEvents()
  const flushing = vi.spyOn(host.sessions, 'flush').mockResolvedValueOnce(false)
  try {
    await expect(deliver(saved.sessionId, saved.notice, new AbortController().signal, undefined, undefined, saved))
      .rejects.toThrow('Generation notice settlement did not persist')
  } finally { flushing.mockRestore() }
  for (let index = 0; index < 2; index++) {
    expect(await deliver(saved.sessionId, saved.notice, new AbortController().signal, undefined, undefined, saved)).toBe('settled')
  }
  expect(resolved.agent.session.snapshotEvents()).toEqual(before)
  expect(adapter.requests).toEqual([])
  expect(h.calls.filter(call => call.method === 'PUT')).toEqual([])
})

it('retains the explicitly selected supported reasoning effort in submission evidence and the restored continuation', async () => {
  const high = ReasoningEffortId('high'), h = await originalVideoFixture([], high)
  const submission = h.agent.session.snapshotEvents().find(event => event.type === 'tool/result'
    && event.data.message.toolCallId === ToolCallId('original-submit'))
  if (submission?.type !== 'tool/result') throw new Error('Missing original submission result')
  expect(submission.data.meta).toMatchObject({ [TOOL_BODY_META_KEY]: {
    generationWatchId: h.run.id, binding: { model: { ...selection, reasoningEffort: high } },
  } })
  expect(h.run.binding?.model).toEqual({ ...selection, reasoningEffort: high })
  expect(h.adapter.requests.map(request => request.reasoningEffort)).toEqual([high, high])
  const restored = await h.reopen()
  const adapter = new MockAdapter([textResponse('Continue with the original selected reasoning effort.')],
    { efforts: [{ id: high, name: 'High' }] })
  restored.llm.registerAdapter(['mock'], adapter)
  h.complete()
  await vi.waitFor(async () => {
    expect(adapter.requests).toHaveLength(1)
    expect((await h.store.load(h.run.id))?.notice?.deliveredAt).toEqual(expect.any(Number))
  })
  const resolved = await restored.sessionController.resolveAgent(h.agent.id)
  if ('error' in resolved) throw resolved.error
  await resolved.agent.whenIdle()
  expect(resolved.agent.model.current()).toEqual({ ...selection, reasoningEffort: high })
  expect(adapter.requests).toHaveLength(1)
  expect(adapter.requests[0]).toMatchObject({ ...selection, reasoningEffort: high, sessionId: h.agent.id })
  expect((await h.store.load(h.run.id))?.binding).toEqual(h.binding)
  expect(h.calls.filter(call => call.method === 'PUT')).toEqual([])
})

it('persists the real dispatch fence before the first offline provider submission and replays its original key without sending again', async () => {
  const h = await originalVideoFixture([], undefined, true)
  const submitted = h.agent.session.snapshotEvents().find(event => event.type === 'tool/result'
    && event.data.message.toolCallId === ToolCallId('original-submit'))
  if (submitted?.type !== 'tool/result') throw new Error('Missing first submission result')
  expect(submitted.data.message.isError, JSON.stringify(submitted.data.message.content)).not.toBe(true)
  expect(h.dispatchOrder).toEqual([{ kind: 'fence', runId: h.run.id, key: h.originalRequest.idempotency_key }, { kind: 'put' }])
  expect(h.calls.filter(call => call.method === 'PUT')).toEqual([{ method: 'PUT', path: '/aigc/storyboard' }])
  expect(await h.store.mayObserve(h.run.id)).toBe(true)
  expect(await h.store.hasNoSend(h.run.id)).toBe(false)
  expect(h.run.packs).toMatchObject([{ key: h.originalRequest.idempotency_key, taskId: 42 }])
  const replay = await executeToolFixture(h.host, { callId: ToolCallId('replay-original-submit'), name: 'jubian_storyboard',
    arguments: h.originalRequest, signal: new AbortController().signal, agent: h.agent })
  expect(replay.isError, JSON.stringify(replay.content)).toBe(false)
  expect(replay.value).toMatchObject({ generation_watch_id: h.run.id, replayed: true, task_id: '42' })
  expect(h.dispatchOrder).toEqual([{ kind: 'fence', runId: h.run.id, key: h.originalRequest.idempotency_key }, { kind: 'put' }])
  expect(h.calls.filter(call => call.method === 'PUT')).toEqual([{ method: 'PUT', path: '/aigc/storyboard' }])
  const retained = await h.store.load(h.run.id)
  expect(retained?.binding).toEqual(h.binding)
  expect(retained?.packs).toMatchObject([{ key: h.originalRequest.idempotency_key, taskId: 42 }])
  expect(await h.store.listAll()).toHaveLength(1)
})

it('keeps the original notice pending without durable claims and resumes it once after the deployment enables them', async () => {
  const h = await originalVideoFixture([textResponse('Must not run in the original Host.')])
  const disabled = await h.reopen(false)
  const blocked = new MockAdapter([textResponse('Must not run without durable inbox claims.')])
  disabled.llm.registerAdapter(['mock'], blocked)
  const scans = vi.spyOn(GenerationWatchStore.prototype, 'listActive')
  let noticeId = ''
  try {
    h.complete()
    await vi.waitFor(async () => {
      const recorded = await h.store.load(h.run.id)
      expect(recorded?.notice?.id).toEqual(expect.any(String))
      noticeId = recorded!.notice!.id
    })
    const recordedScans = scans.mock.calls.length
    await vi.waitFor(() => { expect(scans.mock.calls.length).toBeGreaterThan(recordedScans) })
    const pending = await h.store.load(h.run.id)
    expect(pending).toMatchObject({ id: h.run.id, sessionId: h.agent.id, binding: h.binding,
      notice: { id: noticeId }, packs: [{ key: h.run.packs[0]!.key, previewPath: h.run.packs[0]!.previewPath, taskId: 42 }] })
    expect(pending?.notice?.deliveredAt).toBeUndefined()
    expect(pending?.reviewRequired).toBeUndefined()
    expect(await h.store.listActive()).toHaveLength(1)
    expect(disabled.agents.get(h.agent.id)).toBeUndefined()
    expect(disabled.sessions.get(h.agent.id)).toBeUndefined()
    expect(blocked.requests).toEqual([])
    const reader = await disabled.sessionPersistence.open(h.agent.id, 'read')
    try {
      const { events } = await reader.read()
      expect(events.some(event => event.type === 'user/message' && event.data.id === noticeId)).toBe(false)
      expect(events.some(event => event.type === 'agent/inbox/spliced'
        && event.data.inserted.some(message => message.id === noticeId))).toBe(false)
    } finally { await reader.close() }
    expect(h.calls.filter(call => call.method === 'PUT')).toEqual([])
  } finally { scans.mockRestore() }

  const restored = await h.reopen()
  const adapter = new MockAdapter([textResponse('Continue from the same original video receipt.')])
  restored.llm.registerAdapter(['mock'], adapter)
  await vi.waitFor(async () => {
    expect(adapter.requests).toHaveLength(1)
    expect((await h.store.load(h.run.id))?.notice?.deliveredAt).toEqual(expect.any(Number))
  })
  const resolved = await restored.sessionController.resolveAgent(h.agent.id)
  if ('error' in resolved) throw resolved.error
  await resolved.agent.whenIdle()
  const saved = await h.store.load(h.run.id)
  expect(saved?.binding).toEqual(h.binding)
  expect(saved?.notice?.id).toBe(noticeId)
  expect(adapter.requests).toHaveLength(1)
  expect(adapter.requests[0]).toMatchObject({ provider: selection.provider, model: selection.model, sessionId: h.agent.id })
  expect(resolved.agent.session.snapshotEvents().filter(event => event.type === 'user/message' && event.data.id === noticeId)).toHaveLength(1)
  expect(await h.store.listActive()).toEqual([])
  expect(h.calls.filter(call => call.method === 'PUT')).toEqual([])
})

it('records an admitted failed continuation for review without scheduling another turn', async () => {
  const h = await originalVideoFixture([() => { throw new LlmError('Offline account quota exhausted', 'ACCOUNT_QUOTA') }])
  h.complete()
  await vi.waitFor(async () => {
    expect((await h.store.load(h.run.id))?.reviewRequired).toBe(true)
  }, { timeout: 5000 })
  expect((await h.store.load(h.run.id))?.recoveryNotice).toBeUndefined()
  expect((await h.store.load(h.run.id))?.notice?.deliveredAt).toBeUndefined()
  expect(await h.store.listActive()).toEqual([])
  expect(h.adapter.requests).toHaveLength(3)
  const ends = h.agent.session.snapshotEvents().filter(event => event.type === 'turn/end')
  expect(ends.map(event => event.data.reason)).toMatchObject([{ kind: 'completed' }, { kind: 'error', error: { code: 'ACCOUNT_QUOTA' } }])
  expect(h.calls.filter(call => call.method === 'PUT')).toHaveLength(0)
}, 20_000)

it('preserves a completed download and reviews an admitted continuation interrupted by Host shutdown', async () => {
  const outputRoot = await realpath(await mkdtemp(join(tmpdir(), 'muse-generation-downloaded-')))
  onTestFinished(async () => { await rm(outputRoot, { recursive: true, force: true }) })
  const output = join(outputRoot, 'pack-1.mp4')
  const h = await originalVideoFixture([toolCallResponse('download-pack', 'jubian_media',
    { method: 'download', media_url: video, media_kind: 'video', output_path: output, resume: true }), 'hang'])
  h.complete()
  await vi.waitFor(() => { expect(h.adapter.requests).toHaveLength(4) }, { timeout: 5000 })
  expect((await readFile(output)).equals(h.bytes)).toBe(true)
  expect(h.calls.filter(call => call.path === video)).toHaveLength(1)
  const host = await h.reopen()
  const resumed = new MockAdapter([textResponse('Must not automatically replay a committed uncertain continuation.')])
  host.llm.registerAdapter(['mock'], resumed)
  await vi.waitFor(async () => { expect((await h.store.load(h.run.id))?.reviewRequired).toBe(true) }, { timeout: 5000 })
  const resolved = await host.sessionController.resolveAgent(h.agent.id)
  if ('error' in resolved) throw resolved.error
  await resolved.agent.whenIdle()
  const current = await h.store.load(h.run.id)
  expect(current?.binding).toEqual(h.run.binding)
  expect(current?.recoveryNotice).toBeUndefined()
  expect(resumed.requests).toHaveLength(0)
  expect(h.calls.filter(call => call.path === video)).toHaveLength(1)
  expect((await readFile(output)).equals(h.bytes)).toBe(true)
  expect(resolved.agent.model.current()).toEqual(selection)
  expect(host.workspaceRegistry.get(h.binding.workspaceId)?.sessionIds).toContain(h.agent.id)
  expect(resolved.agent.session.snapshotEvents().filter(event => event.type === 'tool/result'
    && event.data.message.toolCallId === ToolCallId('download-pack'))).toHaveLength(1)
  expect(h.calls.filter(call => call.method === 'PUT')).toHaveLength(0)
}, 20_000)

it('wakes the same unclaimed persisted notice after Host restart with its original native binding', async () => {
  const h = await originalVideoFixture([textResponse('Must not run before Host shutdown.')])
  const entered = Promise.withResolvers<undefined>()
  const maintenance = h.agent.runMaintenance(signal => new Promise<void>((resolve) => {
    entered.resolve(undefined)
    signal.addEventListener('abort', () => { resolve() }, { once: true })
  }))
  await entered.promise
  h.complete()
  let noticeId = ''
  await vi.waitFor(async () => {
    const pending = await h.store.load(h.run.id)
    expect(pending?.notice?.id).toEqual(expect.any(String))
    noticeId = pending!.notice!.id
    expect(h.agent.inbox.nextTurn.some(message => message.id === noticeId)).toBe(true)
  }, { timeout: 5000 })
  const host = await h.reopen()
  await maintenance
  const adapter = new MockAdapter([textResponse('Resume from the existing package checkpoint.')])
  host.llm.registerAdapter(['mock'], adapter)
  await vi.waitFor(async () => {
    expect(adapter.requests).toHaveLength(1)
    expect((await h.store.load(h.run.id))?.notice?.deliveredAt).toEqual(expect.any(Number))
  }, { timeout: 5000 })
  const resolved = await host.sessionController.resolveAgent(h.agent.id)
  if ('error' in resolved) throw resolved.error
  await resolved.agent.whenIdle()
  const current = await h.store.load(h.run.id)
  expect(current?.notice?.id).toBe(noticeId)
  expect(current?.binding).toEqual(h.run.binding)
  expect(adapter.requests[0]).toMatchObject({ provider: selection.provider, model: selection.model, sessionId: h.agent.id })
  expect(host.workspaceRegistry.get(h.binding.workspaceId)?.sessionIds).toContain(h.agent.id)
  expect(resolved.agent.session.snapshotEvents().filter(event => event.type === 'user/message' && event.data.id === noticeId)).toHaveLength(1)
  expect(h.calls.filter(call => call.method === 'PUT')).toHaveLength(0)
}, 20_000)
