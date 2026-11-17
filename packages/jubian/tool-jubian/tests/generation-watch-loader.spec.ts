/** Keyless Loader coverage for automatic continuation after an original video receipt. */
import { cp, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, onTestFinished, vi } from 'vitest'
import AgentRegistry, { agentEvents } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { JubianLedger } from '@deepseek-ai/dsh-jubian'
import Llm, { createMessage, createToolResultMessage, createUserMessage, LlmError, MessageId, ReasoningEffortId, ToolCallId } from '@deepseek-ai/dsh-llm'
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
import Tools from '@deepseek-ai/dsh-tools'
import { TOOL_BODY_META_KEY } from '@deepseek-ai/dsh-tools/pipeline'
import { defineContentToolFixture, executeToolFixture } from '@deepseek-ai/dsh-tool-testkit'
import { Context } from '@deepseek-ai/cordis'
import { createSessionTestController } from '../../../api/session-controller/tests/test-remote.ts'
import { MockAdapter, textResponse, toolCallResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import { MemoryCredentials } from '../../../credentials/credentials/tests/memory.ts'
import * as JsonlSessionPersistence from '../../../session/session-persistence-jsonl/src/index.ts'
import { sessionDir } from '../../../session/session-persistence-jsonl/src/format.ts'
import * as NativeExecutor from '@deepseek-ai/dsh-tool-executor-native'
import { configurationFixture } from '../../../settings/settings/tests/configuration-fixture.ts'
import { GenerationWatchStore, type GenerationWatchRun } from '../src/generation-watch-store.ts'
import { createGenerationWatchNotice, deliverGenerationWatchNotice, registerGenerationWatchDelivery } from '../src/generation-watch-delivery.ts'
import { SessionPersistenceRevision } from '@deepseek-ai/dsh-session-persistence'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import { GenerationSessionBindings, type GenerationWorkspaceLease } from '../src/generation-binding.ts'
import * as Jubian from '../src/index.ts'
import { createNativeGenerationDelivery, type NativeGenerationDelivery } from '../src/generation-watch-native-delivery.ts'
import { bodyHash } from '../src/write.ts'

// Each test owns isolated storage; the real process handoff scanner has separate tests.
vi.mock('../../../../apps/desktop-host/src/workspace-handoff.ts', () => ({ assertWorkspaceMigrationHandoff: vi.fn(async () => undefined) }))

/** Wait for native watch state with the current test lane's polling budget. */
async function waitForState(assertion: () => void | Promise<void>): Promise<void> {
  await expect.poll(async () => { await assertion(); return true }).toBe(true)
}

const selection = { provider: 'mock', model: 'mock' }
const model = { platformId: 'YU_DIAN', modelId: 'doubao-seedance-2-0-260128', standardId: 11, genType: 3,
  modelGenerationTypeId: 7, videoStandardId: 91, duration: 8, ratio: '9:16', resolution: '720p', genNum: 1,
  materialList: [], backupModelList: [], prompt: '@[Lead](lead) crosses a quiet street.' }
const image = 'https://cdn.invalid/lead.png'
const video = 'https://jubian-aigc.tos-cn-beijing.volces.com/test/episode-43-pack-1.mp4'
const board = { id: 1, scriptId: 2708, isGenerate: 1, storyboardName: 'EP43-P1',
  modelConfig: JSON.stringify(model), storyboardMaterialList: [{ assetId: 'asset-lead', materialAssetId: 81285,
    fileName: 'Lead', materialKey: 'lead', materialType: 'image', materialUrl: image, sortOrder: 1 }] }
const secondBoard = { ...board, id: 2, storyboardName: 'EP43-P2',
  modelConfig: JSON.stringify({ ...model, prompt: '@[Lead](lead) crosses a quiet alley.' }) }

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
    await waitForState(async () => { expect((await store.load(id))?.reviewRequired).toBe(true) })
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

it('rejects a native watcher notice without an acquired execution binding before requesting a model', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'muse-generation-unbound-notice-')))
  const host = await watchHost(root)
  const adapter = new MockAdapter([textResponse('An unbound notice must not reach this model.')])
  host.llm.registerAdapter(['mock'], adapter)
  try {
    const agent = await host.agentLoop.create(SessionId('unbound-native-notice'), selection, { cwd: root })
    const message = createUserMessage({ content: [{ type: 'text', text: 'Continue the saved result.' }],
      source: { kind: 'jubian-generation-watch', form: 'notice', summary: 'Unbound generation notice' } })
    agent.followup(message)
    await agent.whenIdle()
    const events = agent.session.snapshotEvents()
    expect(adapter.requests).toEqual([])
    expect(events.some(event => event.type === 'user/message' && event.data.id === message.id)).toBe(false)
    expect(events.filter(event => event.type === 'turn/end').map(event => event.data.reason))
      .toMatchObject([{ kind: 'error' }])
    expect(JSON.stringify(events.filter(event => event.type === 'turn/end')))
      .toContain('original native execution binding is not held')
    expect(agent.inbox.nextTurn.map(item => item.id)).toEqual([message.id])
    expect(await new GenerationWatchStore(join(root, 'watches')).listAll()).toEqual([])
  } finally {
    try { await host.fiber.dispose() } finally { await rm(root, { recursive: true, force: true }) }
  }
})

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
  method: 'submit_video' | 'generate' = 'submit_video', omitPreviewPath = false, secondStoryboard = false) {
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
    if (path === '/aigc/storyboard/2' && secondStoryboard) return answer(secondBoard)
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
  let secondRequest: { preview_path: string; idempotency_key: string } | undefined
  if (secondStoryboard) {
    const secondPrepared = await executeToolFixture(host, { callId: ToolCallId('prepare-second'), name: 'jubian_storyboard',
      arguments: { method: 'prepare_video', storyboard_id: 2, project_dir: root }, signal: new AbortController().signal })
    expect(secondPrepared.isError, JSON.stringify(secondPrepared.content)).toBe(false)
    const secondText = secondPrepared.content.find(block => block.type === 'text')
    if (secondText?.type !== 'text') throw new Error('Expected the second native preview')
    const parsedSecond = JSON.parse(secondText.text) as { preview_path: string; idempotencyKey: string }
    const secondPayload = (JSON.parse(await readFile(parsedSecond.preview_path, 'utf8')) as {
      payload: Record<string, unknown> }).payload
    const secondLedger = new JubianLedger({ root: join(root, 'ledger') })
    await secondLedger.begin({ idempotencyKey: parsedSecond.idempotencyKey, scriptId: 2708,
      method: 'storyboard_native_submit', requestSha256: bodyHash(secondPayload) })
    await secondLedger.settle(parsedSecond.idempotencyKey, { outcome: 'accepted', httpStatus: 200,
      applicationCode: 200, responseSha256: null })
    secondRequest = { preview_path: parsedSecond.preview_path, idempotency_key: parsedSecond.idempotencyKey }
  }
  const ledger = new JubianLedger({ root: join(root, 'ledger') })
  if (!initialDispatch) {
    await ledger.begin({ idempotencyKey, scriptId: 2708, method: 'storyboard_native_submit', requestSha256: bodyHash(payload) })
    await ledger.settle(idempotencyKey, { outcome: 'accepted', httpStatus: 200, applicationCode: 200, responseSha256: null })
  }
  const adapter = new MockAdapter([toolCallResponse('original-submit', 'jubian_storyboard',
    omitPreviewPath ? { method, storyboard_id: 1, project_dir: root, idempotency_key: idempotencyKey }
      : { method, preview_path, idempotency_key: idempotencyKey }),
  textResponse('Provider is generating the pack.'),
  ...(secondRequest === undefined ? [] : [toolCallResponse('second-submit', 'jubian_storyboard',
    { method, preview_path: secondRequest.preview_path, idempotency_key: secondRequest.idempotency_key }),
  textResponse('The second pack is generating.')]),
  ...script],
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
  let secondRun: GenerationWatchRun | undefined
  if (secondRequest !== undefined) {
    agent.model.select({ provider: selection.provider, model: 'second-model' })
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Submit the second pack.' }], source: { kind: 'user' } }))
    await agent.whenIdle()
    secondRun = (await store.listActive()).find(candidate => candidate.id !== run.id)
    if (secondRun?.binding === undefined) {
      throw new Error('The second submission did not record its own native binding: '
        + JSON.stringify(agent.session.snapshotEvents().filter(event => event.type === 'tool/result' || event.type === 'turn/end')))
    }
  }
  return { root, host, agent, adapter, store, run, binding: run.binding, bytes, calls, dispatchOrder, secondRun,
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
  // JSONL flushes and binding verification can exceed the default one-second poll window on Windows.
  await vi.waitFor(async () => {
    const run = await h.store.load(h.run.id)
    expect(run?.notice?.id).toEqual(expect.any(String))
    expect(h.agent.inbox.nextTurn.some(message => message.id === run?.notice?.id)).toBe(true)
  }, { timeout: 10_000 })
  const host = await h.reopen(true, false)
  await maintenance
  const saved = await h.store.load(h.run.id)
  if (saved?.notice === undefined) throw new Error('Expected the parked original notice')
  const projection = await registerGenerationWatchDelivery(host)
  const deliver = createNativeGenerationDelivery(host, projection, new GenerationSessionBindings(host))
  const resolved = await host.sessionController.resolveAgent(saved.sessionId)
  if ('error' in resolved) throw resolved.error
  expect(projection.stateOf(resolved.agent.session).notices[saved.notice.id]).toBe('guard-rejected')
  return { h, host, saved, notice: saved.notice, projection, deliver, agent: resolved.agent }
}

it('reconciles an original video from its automatic continuation without acquiring a second workspace owner', async () => {
  const h = await originalVideoFixture([
    () => toolCallResponse('continuation-submit', 'jubian_storyboard', h.originalRequest),
    textResponse('The original video remains verified without another paid request.'),
  ])
  const continued = Promise.withResolvers<undefined>()
  const detach = h.host.on('session/event', (_session, event) => {
    if (event.type === 'tool/result' && event.data.message.toolCallId === ToolCallId('continuation-submit')) continued.resolve(undefined)
  })
  onTestFinished(() => { detach() })
  h.complete()
  await continued.promise
  await h.agent.whenIdle()
  const result = h.agent.session.snapshotEvents().find(event => event.type === 'tool/result'
    && event.data.message.toolCallId === ToolCallId('continuation-submit'))
  if (result?.type !== 'tool/result') throw new Error('Expected the original-key reconciliation result')
  expect(result.data.message.isError, JSON.stringify(result.data.message.content)).toBe(false)
  const text = result.data.message.content.find(block => block.type === 'text')
  if (text?.type !== 'text') throw new Error('Expected the native reconciliation report')
  const report = JSON.parse(text.text) as Record<string, unknown>
  expect(report).toMatchObject({ status: 'submitted', replayed: true })
  expect(h.calls.filter(call => call.method === 'PUT')).toEqual([])
  expect(await new JubianLedger({ root: join(h.root, 'ledger') }).records()).toHaveLength(1)
})

it('keeps native submission available when a completion notice arrives during an ordinary running turn', async () => {
  const h = await originalVideoFixture([textResponse('The remaining cards are prepared.'), textResponse('The completed pack is verified.')])
  const entered = Promise.withResolvers<undefined>(), continueRequest = Promise.withResolvers<undefined>()
  const queued = Promise.withResolvers<undefined>()
  const stopObserving = h.host.on('session/event', (_session, event) => {
    if (event.type === 'agent/inbox/spliced' && event.data.inserted.some(message => message.source.kind === 'jubian-generation-watch')) {
      queued.resolve(undefined)
    }
  })
  onTestFinished(() => { stopObserving() })
  let waiting = true
  const detach = h.host.on('llm/stream', async function* (_options, next) {
    if (waiting) { waiting = false; entered.resolve(undefined); await continueRequest.promise }
    yield* next()
  })
  h.agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Continue preparing the remaining cards.' }], source: { kind: 'user' } }))
  try {
    await entered.promise
    h.complete()
    await queued.promise
    const result = await executeToolFixture(h.host, { callId: ToolCallId('running-turn-submit'), name: 'jubian_storyboard',
      arguments: h.originalRequest, signal: new AbortController().signal, agent: h.agent })
    expect(result.isError, JSON.stringify(result.content)).toBe(false)
    expect(h.calls.filter(call => call.method === 'PUT')).toEqual([])
  } finally {
    continueRequest.resolve(undefined)
    await h.agent.whenIdle()
    detach()
  }
})

it('cancels each execution reference independently and preserves model and directory guards until the last release', async () => {
  const h = await originalVideoFixture([])
  const bindings = new GenerationSessionBindings(h.host)
  const firstSignal = new AbortController()
  const first = await bindings.acquire(h.agent, h.binding, firstSignal.signal)
  const second = await bindings.acquire(h.agent, h.binding, new AbortController().signal)
  if (first === undefined || second === undefined) throw new Error('Expected both original execution references')
  try {
    firstSignal.abort(new Error('First operation cancelled'))
    expect(first.signal.aborted).toBe(true)
    second.assertCurrent()
    expect(second.signal.aborted).toBe(false)
    expect(() => { h.agent.model.select({ provider: 'mock', model: 'different' }) }).toThrow('guarded model')
    await expect(h.host.workingDirectory.set(h.agent, h.root)).rejects.toThrow('guarded directory')
    await expect(bindings.acquire(h.agent, { ...h.binding, model: { provider: 'mock', model: 'different' } },
      new AbortController().signal)).rejects.toThrow('differs from the held Session selection')
    await expect(h.host.generationWorkspaceAuthority.acquire(h.binding, new AbortController().signal))
      .rejects.toThrow('active continuation')
  } finally { first.release(); second.release() }
  const replacement = await bindings.acquire(h.agent, h.binding, new AbortController().signal)
  if (replacement === undefined) throw new Error('Expected the original execution guards to be available again')
  replacement.release()
})

it('shares pending execution acquisition when one caller cancels before the ownership guard is ready', async () => {
  const h = await originalVideoFixture([])
  const bindings = new GenerationSessionBindings(h.host)
  const entered = Promise.withResolvers<undefined>(), continueAcquire = Promise.withResolvers<undefined>()
  const authority = h.host.generationWorkspaceAuthority
  const originalAcquire = authority.acquire.bind(authority)
  const acquiring = vi.spyOn(authority, 'acquire').mockImplementation(async (...args) => {
    entered.resolve(undefined)
    await continueAcquire.promise
    return originalAcquire(...args)
  })
  const firstSignal = new AbortController()
  const first = bindings.acquire(h.agent, h.binding, firstSignal.signal)
  const firstOutcome = first.catch((error: unknown) => error)
  const second = bindings.acquire(h.agent, h.binding, new AbortController().signal)
  const secondOutcome = second.catch((error: unknown) => error)
  try {
    await entered.promise
    firstSignal.abort(new Error('First pending operation cancelled'))
    expect(await firstOutcome).toMatchObject({ message: 'First pending operation cancelled' })
    continueAcquire.resolve(undefined)
    const surviving = await second
    if (surviving === undefined) throw new Error('Expected the second pending operation to retain its guard')
    surviving.assertCurrent()
    surviving.release()
    expect(acquiring).toHaveBeenCalledTimes(1)
  } finally {
    continueAcquire.resolve(undefined)
    await Promise.all([firstOutcome, secondOutcome])
    acquiring.mockRestore()
  }
})

it('contains cancellation raised synchronously by the workspace owner during execution setup', async () => {
  const h = await originalVideoFixture([])
  const bindings = new GenerationSessionBindings(h.host)
  const caller = new AbortController(), authority = h.host.generationWorkspaceAuthority
  const originalAcquire = authority.acquire.bind(authority)
  const acquiring = vi.spyOn(authority, 'acquire').mockImplementationOnce(async (...args) => {
    caller.abort('Workspace setup cancelled')
    return originalAcquire(...args)
  })
  try {
    await expect(bindings.acquire(h.agent, h.binding, caller.signal)).rejects.toMatchObject({
      message: 'generation execution reference cancelled', cause: 'Workspace setup cancelled',
    })
    const restored = await bindings.acquire(h.agent, h.binding, new AbortController().signal)
    if (restored === undefined) throw new Error('Expected cancellation to leave the workspace available')
    restored.release()
  } finally { acquiring.mockRestore() }
})

it('rejects a shared reference when ownership is revoked before its pending retain resolves', async () => {
  const h = await originalVideoFixture([])
  const bindings = new GenerationSessionBindings(h.host)
  const authority = h.host.generationWorkspaceAuthority
  const originalAcquire = authority.acquire.bind(authority)
  let workspaceLease: GenerationWorkspaceLease | undefined
  const acquiring = vi.spyOn(authority, 'acquire').mockImplementationOnce(async (...args) => {
    workspaceLease = await originalAcquire(...args)
    return workspaceLease
  })
  try {
    const first = await bindings.acquire(h.agent, h.binding, new AbortController().signal)
    if (first === undefined || workspaceLease === undefined) throw new Error('Expected the original workspace guard')
    const pending = bindings.acquire(h.agent, h.binding, new AbortController().signal)
    first.release()
    workspaceLease.release()
    await expect(pending).rejects.toThrow('workspace ownership lease released')
    const restored = await bindings.acquire(h.agent, h.binding, new AbortController().signal)
    if (restored === undefined) throw new Error('Expected the revoked workspace guard to be released')
    restored.release()
  } finally { acquiring.mockRestore() }
})

it('revokes every shared execution reference when the original workspace membership is removed', async () => {
  const h = await originalVideoFixture([])
  const bindings = new GenerationSessionBindings(h.host)
  const first = await bindings.acquire(h.agent, h.binding, new AbortController().signal)
  const second = await bindings.acquire(h.agent, h.binding, new AbortController().signal)
  if (first === undefined || second === undefined) throw new Error('Expected the original execution references')
  const workspace = h.host.workspaceRegistry.get(h.binding.workspaceId)
  if (workspace === undefined) throw new Error('Expected the original workspace')
  await workspace.detachSession(h.agent.id)
  expect(first.signal.aborted).toBe(true)
  expect(second.signal.aborted).toBe(true)
  expect(() => { second.assertCurrent() }).toThrow()
  await expect(bindings.acquire(h.agent, h.binding, new AbortController().signal)).rejects.toThrow('membership changed')
})

it('aborts shared references and drains pending execution setup before their plugin owner is disposed', async () => {
  const h = await originalVideoFixture([])
  let bindings: GenerationSessionBindings | undefined
  const owner = h.host.plugin({ name: 'isolated-generation-binding-owner', apply(scope: Context) {
    bindings = new GenerationSessionBindings(scope)
  } })
  await owner
  if (bindings === undefined) throw new Error('Expected the isolated execution owner')
  const first = await bindings.acquire(h.agent, h.binding, new AbortController().signal)
  const second = await bindings.acquire(h.agent, h.binding, new AbortController().signal)
  if (first === undefined || second === undefined) throw new Error('Expected both isolated references')
  await owner.dispose()
  expect(first.signal.aborted).toBe(true)
  expect(second.signal.aborted).toBe(true)
  await expect(bindings.acquire(h.agent, h.binding, new AbortController().signal)).rejects.toThrow('owner unloaded')

  let pendingBindings: GenerationSessionBindings | undefined
  const pendingOwner = h.host.plugin({ name: 'pending-generation-binding-owner', apply(scope: Context) {
    pendingBindings = new GenerationSessionBindings(scope)
  } })
  await pendingOwner
  if (pendingBindings === undefined) throw new Error('Expected the pending execution owner')
  const entered = Promise.withResolvers<undefined>(), continueAcquire = Promise.withResolvers<undefined>()
  const authority = h.host.generationWorkspaceAuthority
  const originalAcquire = authority.acquire.bind(authority)
  const acquiring = vi.spyOn(authority, 'acquire').mockImplementation(async (...args) => {
    entered.resolve(undefined)
    await continueAcquire.promise
    return originalAcquire(...args)
  })
  const pending = pendingBindings.acquire(h.agent, h.binding, new AbortController().signal)
  const outcome = pending.catch((error: unknown) => error)
  let disposed = false
  try {
    await entered.promise
    const closing = pendingOwner.dispose().then(() => { disposed = true })
    expect(await outcome).toMatchObject({ message: 'generation execution owner unloaded' })
    expect(disposed).toBe(false)
    continueAcquire.resolve(undefined)
    await closing
    expect(disposed).toBe(true)
  } finally {
    continueAcquire.resolve(undefined)
    await outcome
    await pendingOwner.dispose()
    acquiring.mockRestore()
  }
})

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
    messages: [], purpose: 'compaction' })) chunks.push(chunk)
  expect(chunks).toEqual(textResponse('Auxiliary text.'))
  expect(h.adapter.requests).toHaveLength(3)
  expect(h.adapter.requests[2]?.sessionId).toBeUndefined()
  expect(h.adapter.requests[2]?.purpose).toBe('compaction')
  expect((await h.store.load(h.run.id))?.binding).toEqual(h.binding)
  expect(h.agent.session.snapshotEvents()).toEqual(before)
  expect(h.calls.filter(call => call.method === 'PUT')).toEqual([])
})

it('rejects a different model while an actual native continuation holds its execution binding', async () => {
  const f = await parkedNativeDelivery()
  const adapter = new MockAdapter([textResponse('Continue using the original model.')])
  f.host.llm.registerAdapter(['mock'], adapter)
  const entered = Promise.withResolvers<undefined>(), release = Promise.withResolvers<undefined>()
  const maintenance = f.agent.runMaintenance(async () => { entered.resolve(undefined); await release.promise })
  try {
    await entered.promise
    expect(await f.deliver(f.saved.sessionId, f.notice, new AbortController().signal, undefined, undefined, f.saved)).toBe('pending')
    await expect((async () => {
      for await (const _chunk of f.host.llm.stream({ sessionId: f.agent.id,
        provider: selection.provider, model: 'different-model', messages: [] })) {
        throw new Error('The changed model must not yield a chunk')
      }
    })()).rejects.toThrow('GENERATION_WATCH_BINDING_CHANGED: original model request changed')
    expect(adapter.requests).toEqual([])
    expect(f.agent.model.current()).toEqual(selection)
    expect(f.h.calls.filter(call => call.method === 'PUT')).toEqual([])
  } finally {
    release.resolve(undefined)
    await maintenance
    await f.agent.whenIdle()
  }
})

it('rejects a tool dispatch after the held native workspace membership is detached', async () => {
  const f = await parkedNativeDelivery()
  const entered = Promise.withResolvers<undefined>(), release = Promise.withResolvers<undefined>()
  const maintenance = f.agent.runMaintenance(async () => { entered.resolve(undefined); await release.promise })
  try {
    await entered.promise
    expect(await f.deliver(f.saved.sessionId, f.notice, new AbortController().signal, undefined, undefined, f.saved)).toBe('pending')
    const workspace = f.host.workspaceRegistry.get(f.h.binding.workspaceId)
    if (workspace === undefined) throw new Error('Original native workspace is missing')
    await workspace.detachSession(f.agent.id)
    expect(workspace.sessionIds).not.toContain(f.agent.id)
    const before = [...f.h.calls]
    const output = join(f.h.root, 'revoked-workspace.mp4')
    const result = await executeToolFixture(f.host, { callId: ToolCallId('revoked-workspace-download'), name: 'jubian_media',
      arguments: { method: 'download', media_url: video, media_kind: 'video', output_path: output, resume: true },
      signal: new AbortController().signal, agent: f.agent })
    expect(result.isError).toBe(true)
    expect(JSON.stringify(result.content)).toContain('GENERATION_WATCH_BINDING_CHANGED:')
    expect(f.h.calls).toEqual(before)
    await expect(readFile(output)).rejects.toMatchObject({ code: 'ENOENT' })
  } finally {
    release.resolve(undefined)
    await maintenance
    await f.agent.whenIdle()
  }
})

it('rechecks a settled native notice after a flush failure without starting another turn', async () => {
  const h = await originalVideoFixture([textResponse('Existing result reviewed.')])
  h.complete()
  await waitForState(async () => {
    expect((await h.store.load(h.run.id))?.notice?.deliveredAt).toEqual(expect.any(Number))
  })
  await h.agent.whenIdle()
  const saved = await h.store.load(h.run.id)
  if (saved?.notice === undefined) throw new Error('Expected the completed original notice')
  const host = await h.reopen(true, false)
  const adapter = new MockAdapter([])
  host.llm.registerAdapter(['mock'], adapter)
  const projection = await registerGenerationWatchDelivery(host)
  const deliver = createNativeGenerationDelivery(host, projection, new GenerationSessionBindings(host))
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
  }, { timeout: 5_000 })
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
    await waitForState(async () => {
      const recorded = await h.store.load(h.run.id)
      expect(recorded?.notice?.id).toEqual(expect.any(String))
      noticeId = recorded!.notice!.id
    })
    const recordedScans = scans.mock.calls.length
    await waitForState(() => { expect(scans.mock.calls.length).toBeGreaterThan(recordedScans) })
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
  await waitForState(async () => {
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

it('reuses one held native binding for a second notice of the same original Session', async () => {
  const f = await parkedNativeDelivery()
  f.host.llm.registerAdapter(['mock'], new MockAdapter([textResponse('Continue from the verified packs.')]))
  const entered = Promise.withResolvers<undefined>(), release = Promise.withResolvers<undefined>()
  const maintenance = f.agent.runMaintenance(async () => { entered.resolve(undefined); await release.promise })
  try {
    await entered.promise
    const signal = new AbortController().signal
    expect(await f.deliver(f.saved.sessionId, f.notice, signal, undefined, undefined, f.saved)).toBe('pending')
    const second = createGenerationWatchNotice('A second verified pack of the same run is ready.')
    expect(await f.deliver(f.saved.sessionId, second, signal, undefined, undefined, f.saved)).toBe('pending')
    const state = f.projection.stateOf(f.agent.session)
    expect(state.notices[f.notice.id]).toBe('queued')
    expect(state.notices[second.id]).toBe('queued')
    expect(f.agent.inbox.nextTurn.map(message => message.id)).toEqual([f.notice.id, second.id])
    expect(() => { f.agent.model.select({ provider: 'mock', model: 'another-model' }) }).toThrow('guarded model')
    release.resolve(undefined)
    await maintenance
    await f.agent.whenIdle()
    expect(f.h.calls.filter(call => call.method === 'PUT')).toEqual([])
  } finally {
    release.resolve(undefined)
    await maintenance
  }
}, 20_000)

it('refuses to start a native continuation while the Host is unloading', async () => {
  const f = await parkedNativeDelivery()
  const observed: string[] = []
  let failure: unknown
  const deliver = createNativeGenerationDelivery(f.host, f.projection, new GenerationSessionBindings(f.host))
  f.host.effect(() => async () => {
    try {
      observed.push(await deliver(f.saved.sessionId, f.notice, new AbortController().signal, undefined, undefined, f.saved))
    } catch (error: unknown) { failure = error }
  })
  await f.host.fiber.dispose()
  expect(failure).toBeUndefined()
  expect(observed).toEqual(['pending'])
  expect(f.agent.session.snapshotEvents().filter(event => event.type === 'user/message'
    && event.data.id === f.notice.id)).toEqual([])
})

it('refuses a notice whose original Session log is unavailable', async () => {
  const f = await parkedNativeDelivery()
  const detached = await realpath(await mkdtemp(join(tmpdir(), 'muse-native-notice-detached-')))
  onTestFinished(async () => { await rm(detached, { recursive: true, force: true }) })
  await cp(join(f.h.root, 'watches'), join(detached, 'watches'), { recursive: true })
  const host = await watchHost(detached, false, true)
  const store = new GenerationWatchStore(join(detached, 'watches'))
  const saved = await store.load(f.saved.id)
  if (saved?.notice === undefined) throw new Error('Expected the parked original notice')
  const projection = await registerGenerationWatchDelivery(host)
  const deliver = createNativeGenerationDelivery(host, projection, new GenerationSessionBindings(host))
  await expect(deliver(saved.sessionId, saved.notice, new AbortController().signal, undefined, undefined, saved))
    .rejects.toMatchObject({ code: 'session/not-found' })
  expect(host.agents.get(saved.sessionId)).toBeUndefined()
})

it('stays pending while the original Session has no persisted revision', async () => {
  const f = await parkedNativeDelivery()
  const id = SessionId('unpersisted-native-watch')
  const agent = await f.host.agentLoop.create(id, selection, { cwd: f.h.root })
  expect(await f.host.sessions.flush(agent.session)).toBe(true)
  const binding = f.saved.binding
  if (binding === undefined) throw new Error('Expected the parked original binding')
  const run = await f.h.store.create({ id: 'f'.repeat(64), sessionId: id, createdAt: 0, deadlineAt: 1,
    packs: [{ key: 'e'.repeat(64), previewPath: join(f.h.root, 'unpersisted-preview.json'), taskId: 7 }],
    binding: { ...binding, sessionId: id } })
  await rm(sessionDir(join(f.h.root, 'sessions'), f.h.root, id), { recursive: true, force: true })
  expect(await f.host.sessionPersistence.stat(id)).toBeUndefined()
  expect(await f.deliver(id, createGenerationWatchNotice('Continue the unpersisted pack.'), new AbortController().signal,
    undefined, undefined, run)).toBe('pending')
  expect(await f.host.sessionPersistence.stat(id)).toBeUndefined()
  expect(agent.session.snapshotEvents().some(event => event.type === 'user/message')).toBe(false)
})

it('stays pending while the Session log has no matching submission evidence', async () => {
  const f = await parkedNativeDelivery()
  const run = await f.h.store.create({ id: 'd'.repeat(64), sessionId: f.saved.sessionId, createdAt: 0, deadlineAt: 1,
    packs: [{ key: 'c'.repeat(64), previewPath: join(f.h.root, 'unrecorded-preview.json'), taskId: 9 }],
    binding: f.saved.binding })
  expect(await f.deliver(f.saved.sessionId, createGenerationWatchNotice('Continue the unrecorded pack.'),
    new AbortController().signal, undefined, undefined, run)).toBe('pending')
  expect(f.agent.session.snapshotEvents().some(event => event.type === 'user/message'
    && event.data.source.kind === 'jubian-generation-watch')).toBe(false)
})

it('forgets a rejected notice once another input waits for the next step', async () => {
  const f = await parkedNativeDelivery()
  const entered = Promise.withResolvers<undefined>(), release = Promise.withResolvers<undefined>()
  const maintenance = f.agent.runMaintenance(async () => { entered.resolve(undefined); await release.promise })
  try {
    await entered.promise
    expect(await f.deliver(f.saved.sessionId, f.notice, new AbortController().signal, undefined, undefined, f.saved)).toBe('pending')
    expect(f.projection.stateOf(f.agent.session).notices[f.notice.id]).toBe('queued')
    expect(f.agent.inbox.remove(MessageId(f.notice.id))).toBe(true)
    release.resolve(undefined)
    await maintenance
    await f.agent.whenIdle()
    expect(f.agent.inbox.nextTurn).toEqual([])
    const waiting = createUserMessage({ content: [{ type: 'text', text: 'Keep this instruction for the next step.' }],
      source: { kind: 'user' } })
    f.agent.inbox.append('next-step', waiting)
    expect(await f.deliver(f.saved.sessionId, f.notice, new AbortController().signal, undefined, undefined, f.saved))
      .toBe('needs-review')
    expect(f.agent.inbox.nextStep.map(message => message.id)).toEqual([waiting.id])
    expect(f.agent.inbox.nextTurn).toEqual([])
    expect(f.projection.stateOf(f.agent.session).notices[f.notice.id]).toBe('queued')
    expect(f.agent.session.snapshotEvents().filter(event => event.type === 'user/message'
      && event.data.id === f.notice.id)).toEqual([])
    const flushes: boolean[] = []
    const realFlush = f.host.sessions.flush.bind(f.host.sessions)
    const flushing = vi.spyOn(f.host.sessions, 'flush').mockImplementation(async (session) => {
      const result = await realFlush(session)
      flushes.push(result)
      return result
    })
    try { await f.host.fiber.dispose() } finally { flushing.mockRestore() }
    expect(flushes).toEqual([true])
  } finally {
    release.resolve(undefined)
    await maintenance
  }
}, 20_000)

async function deliveryOnlyHost(root: string): Promise<Context> {
  const { ctx } = await configurationFixture({ hmr: false, rows: [
    { id: 'prompt', name: 'cordis:prompt' }, { id: 'tools', name: 'cordis:tools' },
    { id: 'executor', name: 'cordis:executor' },
    { id: 'llm', name: 'cordis:llm' }, { id: 'sessions', name: 'cordis:sessions' },
    { id: 'projections', name: 'cordis:projections' }, { id: 'agents', name: 'cordis:agents' },
    { id: 'persistence', name: 'cordis:persistence', config: { root: join(root, 'sessions'), compression: 'none' } },
    { id: 'loop', name: 'cordis:loop', config: { agents: [], durableInboxClaims: true } },
    { id: 'controller', name: 'cordis:controller' },
  ], builtins: {
    prompt: SystemPrompt, tools: Tools, executor: NativeExecutor, llm: Llm, sessions: SessionStore,
    projections: SessionProjections, agents: AgentRegistry, loop: AgentLoop, persistence: JsonlSessionPersistence,
    controller: { inject: ['llm', 'sessions', 'sessionProjections', 'agents'], apply: async (scope: Context) => {
      await createSessionTestController(scope, { cwd: root, defaultModelSelection: () => selection })
    } },
  } })
  for (const entry of ctx.loader.entries()) await entry.fiber?.await()
  return ctx
}

it('stays pending when a concurrent write changes the Session revision during the evidence read', async () => {
  const f = await parkedNativeDelivery()
  const opened = f.host.sessionPersistence.open.bind(f.host.sessionPersistence)
  const racing = vi.spyOn(f.host.sessionPersistence, 'open').mockImplementation(async (id, access) => {
    const handle = await opened(id, access)
    if (access !== 'read') return handle
    const read = handle.read.bind(handle)
    Object.assign(handle, { read: async () => {
      const result = await read()
      f.agent.inbox.append('next-step', createUserMessage({ content: [{ type: 'text', text: 'Concurrent input.' }],
        source: { kind: 'user' } }))
      expect(await f.host.sessions.flush(f.agent.session)).toBe(true)
      return result
    } })
    return handle
  })
  try {
    expect(await f.deliver(f.saved.sessionId, f.notice, new AbortController().signal, undefined, undefined, f.saved)).toBe('pending')
  } finally { racing.mockRestore() }
  expect(f.agent.inbox.nextStep).toHaveLength(1)
})

it('stays pending when the Host holds no workspace authority', async () => {
  const f = await parkedNativeDelivery()
  const detached = await realpath(await mkdtemp(join(tmpdir(), 'muse-native-no-authority-')))
  onTestFinished(async () => { await rm(detached, { recursive: true, force: true }) })
  await cp(join(f.h.root, 'sessions'), join(detached, 'sessions'), { recursive: true })
  const saved = await f.h.store.load(f.saved.id)
  if (saved?.notice === undefined) throw new Error('Expected the parked original notice')
  const host = await deliveryOnlyHost(detached)
  const projection = await registerGenerationWatchDelivery(host)
  const deliver = createNativeGenerationDelivery(host, projection, new GenerationSessionBindings(host))
  try {
    expect(host.get('generationWorkspaceAuthority')).toBeUndefined()
    expect(host.get('agentLoop')?.config.durableInboxClaims).toBe(true)
    expect(await deliver(saved.sessionId, saved.notice, new AbortController().signal, undefined, undefined, saved))
      .toBe('pending')
    expect(host.agents.get(saved.sessionId)).toBeDefined()
    expect(host.sessions.get(saved.sessionId)?.snapshotEvents().some(event => event.type === 'user/message'
      && event.data.id === saved.notice?.id)).toBe(false)
  } finally { await host.fiber.dispose() }
})

it('releases the workspace lease when the caller cancels during acquisition', async () => {
  const f = await parkedNativeDelivery()
  const authority = f.host.generationWorkspaceAuthority
  const acquire = authority.acquire.bind(authority)
  const controller = new AbortController()
  const cancelling = vi.spyOn(authority, 'acquire').mockImplementation(async (identity, signal) => {
    const lease = await acquire(identity, signal)
    controller.abort(new Error('Host cancelled the continuation'))
    return lease
  })
  try {
    await expect(f.deliver(f.saved.sessionId, f.notice, controller.signal, undefined, undefined, f.saved))
      .rejects.toThrow('Host cancelled the continuation')
  } finally { cancelling.mockRestore() }
  expect(f.agent.session.snapshotEvents().filter(event => event.type === 'user/message'
    && event.data.id === f.notice.id)).toEqual([])
})

it('releases one held binding when its in-flight continuation fails during Host shutdown', async () => {
  const f = await parkedNativeDelivery()
  f.host.llm.registerAdapter(['mock'], new MockAdapter(['hang']))
  const resolve = f.host.sessionController.resolveAgent.bind(f.host.sessionController)
  const authority = f.host.generationWorkspaceAuthority
  const acquire = authority.acquire.bind(authority)
  let acquired = false
  let disposal: Promise<void> | undefined
  const watchingAuthority = vi.spyOn(authority, 'acquire').mockImplementation(async (identity, signal) => {
    const lease = await acquire(identity, signal)
    acquired = true
    return lease
  })
  const watching = vi.spyOn(f.host.sessionController, 'resolveAgent').mockImplementation(async (sessionId) => {
    const found = await resolve(sessionId)
    if (acquired) disposal ??= f.host.fiber.dispose()
    return found
  })
  try {
    await expect(f.deliver(f.saved.sessionId, f.notice, new AbortController().signal, undefined, undefined, f.saved))
      .rejects.toThrow('Automatic continuation producer unloaded')
  } finally { watching.mockRestore(); watchingAuthority.mockRestore() }
  await disposal
  expect(f.agent.session.snapshotEvents().filter(event => event.type === 'user/message'
    && event.data.id === f.notice.id)).toEqual([])
  expect(f.agent.inbox.nextTurn.map(message => message.id)).not.toContain(f.notice.id)
  expect(f.h.calls.filter(call => call.method === 'PUT')).toEqual([])
})

it('reports a native parking failure when the Session refuses the receipt and its flush', async () => {
  const f = await parkedNativeDelivery()
  const entered = Promise.withResolvers<undefined>(), release = Promise.withResolvers<undefined>()
  const maintenance = f.agent.runMaintenance(async () => { entered.resolve(undefined); await release.promise })
  try {
    await entered.promise
    expect(await f.deliver(f.saved.sessionId, f.notice, new AbortController().signal, undefined, undefined, f.saved)).toBe('pending')
    const before = f.agent.session.snapshotEvents().filter(event => event.type === 'jubian/generation-notice-parked').length
    const append = f.agent.session.append.bind(f.agent.session)
    // Preserve both native append overloads while failing the parked receipt.
    f.agent.session.append = new Proxy(append, { apply(target, receiver, args: unknown[]): unknown {
      if (args[0] === 'jubian/generation-notice-parked') throw new Error('Injected parked-receipt write failure')
      return Reflect.apply(target, receiver, args)
    } })
    const flushing = vi.spyOn(f.host.sessions, 'flush').mockResolvedValue(false)
    try {
      const disposal = f.host.fiber.dispose()
      release.resolve(undefined)
      await disposal
    } finally { flushing.mockRestore(); f.agent.session.append = append }
    expect(f.agent.session.snapshotEvents().filter(event => event.type === 'jubian/generation-notice-parked'))
      .toHaveLength(before)
    expect(f.agent.inbox.nextTurn.map(message => message.id)).not.toContain(f.notice.id)
  } finally {
    release.resolve(undefined)
    await maintenance
  }
}, 20_000)

it('records the original native submission without a projected preview path when the caller omits it', async () => {
  const h = await originalVideoFixture([textResponse('Continue with the verified pack.')], undefined, true, 'submit_video', true)
  const submitted = h.agent.session.snapshotEvents().find(event => event.type === 'tool/result'
    && event.data.message.toolCallId === ToolCallId('original-submit'))
  if (submitted?.type !== 'tool/result') throw new Error('Missing original submission result')
  expect(submitted.data.message.isError).not.toBe(true)
  // Current behavior: the tool-result projection needs an explicit preview_path, so an omitted
  // argument loses generationWatchId/submission even though the tool body succeeded.
  expect(submitted.data.meta).toBeUndefined()
  expect(h.run.id).toMatch(/^[a-f0-9]{64}$/u)
  expect(h.calls.filter(call => call.method === 'PUT')).toHaveLength(1)
  expect(h.calls.filter(call => call.method === 'PUT')).toEqual([{ method: 'PUT', path: '/aigc/storyboard' }])
})

it('stays pending when the held binding names a different submission of the same Session', async () => {
  const h = await originalVideoFixture([], undefined, false, 'submit_video', false, true)
  const second = h.secondRun
  if (second?.binding === undefined) throw new Error('Expected the second recorded submission')
  expect(h.run.binding?.model).toEqual(selection)
  expect(second.binding.model).toMatchObject({ provider: selection.provider, model: 'second-model' })
  expect(second.sessionId).toBe(h.run.sessionId)
  const host = await h.reopen(true, false)
  host.llm.registerAdapter(['mock'], new MockAdapter([textResponse('Continue the verified pack.')]))
  const projection = await registerGenerationWatchDelivery(host)
  const deliver = createNativeGenerationDelivery(host, projection, new GenerationSessionBindings(host))
  const resolved = await host.sessionController.resolveAgent(h.run.sessionId)
  if ('error' in resolved) throw resolved.error
  const held = createGenerationWatchNotice('Continue the second pack.')
  const entered = Promise.withResolvers<undefined>(), release = Promise.withResolvers<undefined>()
  const maintenance = resolved.agent.runMaintenance(async () => { entered.resolve(undefined); await release.promise })
  try {
    await entered.promise
    expect(await deliver(second.sessionId, held, new AbortController().signal, undefined, undefined, second)).toBe('pending')
    const conflicting = createGenerationWatchNotice('Continue the first pack.')
    expect(await deliver(h.run.sessionId, conflicting, new AbortController().signal, undefined, undefined, h.run))
      .toBe('pending')
    expect(resolved.agent.inbox.nextTurn.map(message => message.id)).toContain(held.id)
    expect(resolved.agent.inbox.nextTurn.map(message => message.id)).not.toContain(conflicting.id)
    expect(projection.stateOf(resolved.agent.session).notices[conflicting.id]).toBeUndefined()
    expect(h.calls.filter(call => call.method === 'PUT')).toEqual([])
  } finally {
    release.resolve(undefined)
    await maintenance
  }
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



async function isolatedNativeDelivery(script: AdapterScript = [textResponse('Continue the exact original operation.')],
  setup?: (ctx: Context) => void, withoutAuthority = false, reasoningEffort?: ReasoningEffortId) {
  const h = await originalVideoFixture(script, reasoningEffort)
  const producer = [...h.host.loader.entries()].find(entry => entry.options.id === 'jubian')!
  await producer.fiber!.dispose()
  let deliver!: NativeGenerationDelivery
  let bindings!: GenerationSessionBindings
  const owner = withoutAuthority ? h.host.isolate('generationWorkspaceAuthority') : h.host
  const scope = owner.plugin({ name: 'isolated-generation-delivery',
    inject: ['agents', 'agentLoop', 'tools', 'sessionProjections', 'sessionController', 'sessions', 'sessionPersistence', 'workingDirectory'],
    apply: async (ctx: Context) => {
      bindings = new GenerationSessionBindings(ctx)
      deliver = createNativeGenerationDelivery(ctx, await registerGenerationWatchDelivery(ctx), bindings)
      setup?.(ctx)
    } })
  await scope.await()
  return { ...h, scope, deliver, bindings,
    send: (notice = createGenerationWatchNotice('Continue the original submitted task.')) =>
      deliver(h.agent.id, notice, new AbortController().signal, undefined, undefined, h.run) }
}


it('refuses unbound, mismatched and archived native deliveries before resolving an Agent', async () => {
  const h = await isolatedNativeDelivery(), notice = createGenerationWatchNotice('Original task.')
  const resolve = vi.spyOn(h.host.sessionController, 'resolveAgent')
  const signal = new AbortController().signal
  expect(await h.deliver(h.agent.id, notice, signal)).toBe('needs-review')
  expect(await h.deliver(SessionId('other'), notice, signal, undefined, undefined, h.run)).toBe('needs-review')
  expect(await h.deliver(h.agent.id, notice, signal, undefined, 'old-receipt', h.run)).toBe('needs-review')
  expect(await h.deliver(h.agent.id, notice, signal, { roomId: 'room', workerBotId: 'worker', requesterBotId: 'other',
    requesterSessionId: 'other-session', exchangeId: 'exchange' }, undefined, h.run)).toBe('needs-review')
  expect(resolve).not.toHaveBeenCalled()
  await h.scope.dispose()
  await expect(h.send()).rejects.toThrow('Automatic continuation producer unloaded')
  resolve.mockRestore()
}, 20_000)


it('preserves native delivery when durable evidence is absent, changes revision or fails to flush', async () => {
  const h = await isolatedNativeDelivery()
  const flush = vi.spyOn(h.host.sessions, 'flush').mockResolvedValueOnce(false)
  await expect(h.send()).rejects.toThrow('Original video submission did not persist')
  flush.mockRestore()
  const stat = vi.spyOn(h.host.sessionPersistence, 'stat').mockResolvedValueOnce(undefined)
  expect(await h.send()).toBe('pending')
  stat.mockRestore()
  const observed = await h.host.sessionPersistence.stat(h.agent.id)
  if (observed === undefined) throw new Error('Original durable Session is absent')
  const changed = vi.spyOn(h.host.sessionPersistence, 'stat').mockResolvedValueOnce(observed)
    .mockResolvedValueOnce({ ...observed, revision: SessionPersistenceRevision('changed-while-reading') })
  expect(await h.send()).toBe('pending')
  changed.mockRestore()
  const notice = createGenerationWatchNotice('Resume only the original native execution.')
  expect(await h.send(notice)).toBe('pending')
  await h.agent.whenIdle()
  expect(await h.send(notice)).toBe('settled')
  const failedReceipt = vi.spyOn(h.host.sessions, 'flush').mockResolvedValueOnce(false)
  await expect(h.send(notice)).rejects.toThrow('Generation notice settlement did not persist')
  failedReceipt.mockRestore()
  expect(h.adapter.requests).toHaveLength(3)
}, 20_000)


it('refuses a live execution whose durable submission binding no longer matches', async () => {
  const h = await isolatedNativeDelivery(), notice = createGenerationWatchNotice('Original task.')
  const changed = { ...h.run, binding: { ...h.binding, model: { provider: 'mock', model: 'different' } } }
  expect(await h.deliver(h.agent.id, notice, new AbortController().signal, undefined, undefined, changed)).toBe('pending')
  expect(h.adapter.requests).toHaveLength(2)
}, 20_000)


it('refuses admission as its actual producer enters unloading', async () => {
  let admitted: Promise<string> | undefined
  const h = await isolatedNativeDelivery(undefined, (ctx) => {
    ctx.effect(() => () => { admitted = h.send() })
  })
  await h.scope.dispose()
  expect(await admitted).toBe('pending')
}, 20_000)


it('refuses a generation notice reaching pre-step without a held native execution', async () => {
  const h = await isolatedNativeDelivery()
  h.agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Unbound automatic notice.' }],
    source: { kind: 'jubian-generation-watch', form: 'notice', summary: 'Unbound fixture notice.' } }))
  await h.agent.whenIdle()
  const end = h.agent.session.snapshotEvents().filter(event => event.type === 'turn/end').at(-1)
  expect(end?.data.reason.kind).toBe('error')
  if (end?.data.reason.kind !== 'error') throw new Error('Unbound continuation was not rejected')
  expect(end.data.reason.error.message).toContain('binding is not held')
  expect(h.adapter.requests).toHaveLength(2)
}, 20_000)


it('checks held model dispatch and releases a delivery that fails while queued', async () => {
  const h = await isolatedNativeDelivery(), entered = Promise.withResolvers<undefined>(), leave = Promise.withResolvers<undefined>()
  onTestFinished(() => { leave.resolve(undefined) })
  const maintenance = h.agent.runMaintenance(async () => { entered.resolve(undefined); await leave.promise })
  await entered.promise
  expect(await h.send()).toBe('pending')
  const stream = async () => { for await (const chunk of h.host.llm.stream({ provider: 'mock', model: 'different',
    messages: [], sessionId: h.agent.id })) void chunk }
  await expect(stream()).rejects.toThrow('original model request changed')
  const resolve = vi.spyOn(h.host.sessionController, 'resolveAgent').mockRejectedValueOnce(new Error('owner read failed'))
  await expect(h.send()).rejects.toThrow('owner read failed')
  resolve.mockRestore()
  leave.resolve(undefined); await maintenance; await h.agent.whenIdle()
}, 20_000)


it('guards held pre-step selections and unscoped tool calls without changing their caller signal', async () => {
  const h = await isolatedNativeDelivery(), release = Promise.withResolvers<undefined>()
  onTestFinished(() => { release.resolve(undefined) })
  const maintenance = h.agent.runMaintenance(async () => { await release.promise })
  expect(await h.send()).toBe('pending')
  await expect(agentEvents(h.host, h.agent).waterfall('agent/pre-step', { messages: [], turn: 2, step: 1,
    signal: new AbortController().signal, modelSelection: { provider: 'mock', model: 'different' } }, async () => ({ kind: 'enter', messages: [] })))
    .rejects.toThrow('original model changed')
  const caller = new AbortController().signal
  const unregister = h.host.effect(() => h.host.tools.register(defineContentToolFixture({ name: 'native_signal_probe', description: 'Read the invocation signal.',
    parameters: {}, execute: async (_args, exec) => {
      expect(exec.signal.aborted).toBe(false)
      return [{ type: 'text', text: 'observed' }]
    } })))
  onTestFinished(async () => { await unregister() })
  expect((await executeToolFixture(h.host, { callId: ToolCallId('without-agent'), name: 'native_signal_probe', arguments: {}, signal: caller })).isError).toBe(false)
  const workspace = h.host.workspaceRegistry.get(h.binding.workspaceId)
  if (workspace === undefined) throw new Error('Original workspace is absent')
  await workspace.detachSession(h.agent.id)
  const denied = await executeToolFixture(h.host, { callId: ToolCallId('revoked-owner'), name: 'native_signal_probe', arguments: {},
    signal: caller, agent: h.agent })
  expect(denied.isError).toBe(true)
  expect(JSON.stringify(denied.content)).toContain('GENERATION_WATCH_BINDING_CHANGED')
  release.resolve(undefined); await maintenance; await h.agent.whenIdle()
}, 20_000)


it('preserves pending delivery without a workspace owner capability or durable inbox claims', async () => {
  const h = await isolatedNativeDelivery(undefined, undefined, true)
  expect(await h.send()).toBe('pending')
  const legacy = await watchHost(join(h.root, 'non-durable-host'), false)
  onTestFinished(async () => { await legacy.fiber.dispose() })
  const deliver = createNativeGenerationDelivery(legacy, await registerGenerationWatchDelivery(legacy),
    new GenerationSessionBindings(legacy))
  expect(await deliver(h.agent.id, createGenerationWatchNotice('Original task.'), new AbortController().signal,
    undefined, undefined, h.run)).toBe('pending')
}, 20_000)


it('propagates a stable Session resolution failure without starting a continuation', async () => {
  const h = await isolatedNativeDelivery()
  const failure = new RemoteError('session/not-found', 'Original Session is unavailable', { sessionId: h.agent.id })
  const resolve = vi.spyOn(h.host.sessionController, 'resolveAgent').mockResolvedValueOnce({ error: failure })
  await expect(h.send()).rejects.toBe(failure)
  resolve.mockRestore()
  expect(h.adapter.requests).toHaveLength(2)
}, 20_000)


it('drains an admitted delivery failure during producer shutdown before releasing its binding', async () => {
  const h = await isolatedNativeDelivery(), release = Promise.withResolvers<undefined>()
  onTestFinished(() => { release.resolve(undefined) })
  const maintenance = h.agent.runMaintenance(async () => { await release.promise })
  const entered = Promise.withResolvers<undefined>(), finish = Promise.withResolvers<undefined>()
  onTestFinished(() => { finish.resolve(undefined) })
  const flush = h.host.sessions.flush.bind(h.host.sessions)
  const failure = new Error('Notice persistence unavailable during shutdown')
  const ack = vi.spyOn(h.host.sessions, 'flush').mockImplementationOnce(flush).mockImplementationOnce(async () => {
    entered.resolve(undefined)
    await finish.promise
    throw failure
  })
  const sending = h.send()
  const rejected = expect(sending).rejects.toBe(failure)
  await entered.promise
  let stopped = false
  const stopping = h.scope.dispose().then(() => { stopped = true })
  await Promise.resolve()
  expect(stopped).toBe(false)
  finish.resolve(undefined)
  await rejected
  release.resolve(undefined)
  await maintenance; await stopping
  ack.mockRestore()
  expect(h.agent.inbox.nextTurn).toHaveLength(0)
}, 20_000)


it('refuses a concurrent owner and releases the admitted continuation when it becomes idle', async () => {
  const h = await isolatedNativeDelivery(), leave = Promise.withResolvers<undefined>()
  const enter = Promise.withResolvers<undefined>()
  const phases: string[] = []
  const waitFor = async (phase: string) => vi.waitFor(() => {
    expect(phases, `Waiting for ${phase}; observed ${JSON.stringify(phases)}`).toContain(phase)
  }, { timeout: 5000 })
  onTestFinished(() => { leave.resolve(undefined); enter.resolve(undefined) })
  const maintenance = h.agent.runMaintenance(async () => { phases.push('maintenance-entered'); await leave.promise })
  const authority = h.host.generationWorkspaceAuthority, acquire = authority.acquire.bind(authority)
  const leases: { lease: GenerationWorkspaceLease; release: ReturnType<typeof vi.spyOn> }[] = []
  const watching = vi.spyOn(authority, 'acquire').mockImplementation(async (...args) => {
    const lease = await acquire(...args)
    leases.push({ lease, release: vi.spyOn(lease, 'release') })
    phases.push('first-workspace-acquired')
    await enter.promise
    phases.push('workspace-returned')
    return lease
  })
  onTestFinished(() => { watching.mockRestore() })
  let first: ReturnType<typeof h.send> | undefined, second: ReturnType<typeof h.send> | undefined
  try {
    await waitFor('maintenance-entered')
    first = h.send()
    const firstResult = first.catch((error: unknown) => error)
    await waitFor('first-workspace-acquired')
    second = h.send()
    const secondResult = second.then(value => ({ kind: 'resolved' as const, value }), (error: unknown) => ({ kind: 'rejected' as const, error }))
      .finally(() => { phases.push('second-settled') })
    await waitFor('second-settled')
    const denied = await secondResult
    expect(denied.kind).toBe('rejected')
    if (denied.kind !== 'rejected' || !(denied.error instanceof Error)) throw new Error('The concurrent owner was not rejected with an Error')
    expect(denied.error.message).toContain('already has an active continuation')
    expect(denied.error).toMatchObject({ name: 'HarnessError', code: 'GENERATION_WATCH_CONTINUATION_BUSY' })
    expect(phases).not.toContain('workspace-returned')
    expect(leases).toHaveLength(1)
    enter.resolve(undefined)
    expect(await firstResult).toBe('pending')
    leave.resolve(undefined)
    await maintenance; await h.agent.whenIdle()
    for (const entry of leases) expect(entry.release).toHaveBeenCalled()
    h.agent.model.select({ provider: 'mock', model: 'next-after-continuation' })
  } finally {
    enter.resolve(undefined); leave.resolve(undefined)
    await Promise.allSettled([first, second, maintenance])
    await h.agent.whenIdle()
    watching.mockRestore()
  }
}, 20_000)


it('retains the replacement admission while an earlier cancelled acquisition returns', async () => {
  const h = await isolatedNativeDelivery(), caller = new AbortController()
  const leave = Promise.withResolvers<undefined>(), maintenanceEntered = Promise.withResolvers<undefined>()
  const firstAcquired = Promise.withResolvers<undefined>(), secondAcquired = Promise.withResolvers<undefined>()
  const publishFirst = Promise.withResolvers<undefined>(), publishSecond = Promise.withResolvers<undefined>()
  onTestFinished(() => { leave.resolve(undefined); publishFirst.resolve(undefined); publishSecond.resolve(undefined) })
  const maintenance = h.agent.runMaintenance(async () => { maintenanceEntered.resolve(undefined); await leave.promise })
  const acquire = h.bindings.acquire.bind(h.bindings)
  let calls = 0
  const acquiring = vi.spyOn(h.bindings, 'acquire').mockImplementation(async (...args) => {
    const call = ++calls
    const lease = await acquire(...args)
    if (lease === undefined) throw new Error('The fixture requires an owned execution')
    if (call === 1) { firstAcquired.resolve(undefined); await publishFirst.promise }
    else { secondAcquired.resolve(undefined); await publishSecond.promise }
    return lease
  })
  onTestFinished(() => { acquiring.mockRestore() })
  let first: ReturnType<typeof h.send> | undefined, second: ReturnType<typeof h.send> | undefined
  try {
    await maintenanceEntered.promise
    first = h.deliver(h.agent.id, createGenerationWatchNotice('Cancelled first result.'), caller.signal,
      undefined, undefined, h.run)
    const firstResult = first.catch((error: unknown) => error)
    await firstAcquired.promise
    const cancellation = new Error('First pending caller cancelled')
    caller.abort(cancellation)
    second = h.send()
    const secondResult = second.catch((error: unknown) => error)
    await secondAcquired.promise
    publishFirst.resolve(undefined)
    expect(await firstResult).toBe(cancellation)
    await expect(h.send()).rejects.toMatchObject({ name: 'HarnessError', code: 'GENERATION_WATCH_CONTINUATION_BUSY' })
    expect(calls).toBe(2)
    publishSecond.resolve(undefined)
    expect(await secondResult).toBe('pending')
    leave.resolve(undefined)
    await maintenance; await h.agent.whenIdle()
    h.agent.model.select({ provider: 'mock', model: 'after-pending-replacement' })
    expect(h.adapter.requests).toHaveLength(3)
  } finally {
    caller.abort(new Error('Fixture release'))
    publishFirst.resolve(undefined); publishSecond.resolve(undefined); leave.resolve(undefined)
    await Promise.allSettled([first, second, maintenance])
    await h.agent.whenIdle()
    acquiring.mockRestore()
  }
}, 20_000)


it('reuses a held continuation for another notice and preserves an explicitly selected reasoning effort', async () => {
  const h = await isolatedNativeDelivery([textResponse('Unscoped model request.'), textResponse('Continue both results.')],
    undefined, false, ReasoningEffortId('high'))
  const leave = Promise.withResolvers<undefined>()
  onTestFinished(() => { leave.resolve(undefined) })
  const maintenance = h.agent.runMaintenance(async () => { await leave.promise })
  expect(h.binding.model.reasoningEffort).toBe('high')
  const notice = createGenerationWatchNotice('Continue this existing submitted task.')
  expect(await h.send(notice)).toBe('pending')
  const queued = h.agent.inbox.nextTurn.find(message => message.id === notice.id)
  if (queued === undefined) throw new Error('The automatic notice was not queued')
  expect(h.agent.inbox.remove(MessageId(notice.id))).toBe(true)
  h.agent.inbox.append('next-step', queued)
  expect(await h.send(notice)).toBe('pending')
  const changed = async () => { for await (const chunk of h.host.llm.stream({ ...selection, messages: [],
    sessionId: h.agent.id, reasoningEffort: ReasoningEffortId('low') })) void chunk }
  await expect(changed()).rejects.toThrow('original model request changed')
  for await (const chunk of h.host.llm.stream({ ...selection, messages: [] })) void chunk
  leave.resolve(undefined)
  await maintenance; await h.agent.whenIdle()
}, 20_000)


it.each(['park', 'drain', 'flush'] as const)('releases the native binding after a shutdown %s failure', async (mode) => {
  const h = await isolatedNativeDelivery(['hang'])
  expect(await h.send()).toBe('pending')
  await waitForState(() => { expect(h.adapter.requests).toHaveLength(3) })
  const fail = new Error(`Native shutdown ${mode} unavailable`)
  const remove = mode === 'park' ? vi.spyOn(h.agent.inbox, 'remove').mockImplementationOnce(() => { throw fail }) : undefined
  const idle = mode === 'drain' ? vi.spyOn(h.agent, 'whenIdle').mockRejectedValueOnce(fail) : undefined
  const flush = mode === 'flush' ? vi.spyOn(h.host.sessions, 'flush').mockResolvedValueOnce(false) : undefined
  const stopping = h.scope.dispose()
  await stopping
  remove?.mockRestore(); idle?.mockRestore(); flush?.mockRestore()
  expect(h.agent.inbox.nextTurn).toHaveLength(0)
  h.agent.model.select({ provider: 'mock', model: 'after-cleanup' })
}, 20_000)


it.each(['caller-abort', 'revoked-lease'] as const)('rejects an owner revoked after acquisition: %s', async (mode) => {
  const h = await isolatedNativeDelivery(), caller = new AbortController()
  const acquire = h.bindings.acquire.bind(h.bindings)
  const acquiring = vi.spyOn(h.bindings, 'acquire').mockImplementation(async (...args) => {
    const lease = await acquire(...args)
    if (lease === undefined) throw new Error('The fixture requires an owned execution')
    if (mode === 'caller-abort') caller.abort(new Error('Caller cancelled before publication'))
    else lease.release()
    return lease
  })
  onTestFinished(() => { acquiring.mockRestore() })
  await expect(h.deliver(h.agent.id, createGenerationWatchNotice('Original task.'), caller.signal,
    undefined, undefined, h.run)).rejects.toThrow(mode === 'caller-abort' ? 'Caller cancelled before publication' : 'reference released')
  acquiring.mockRestore()
  h.agent.model.select({ provider: 'mock', model: 'after-rejected-publication' })
}, 20_000)


it('keeps a replacement held lease when an earlier cancelled delivery fails to persist', async () => {
  const h = await isolatedNativeDelivery(), caller = new AbortController(), leave = Promise.withResolvers<undefined>()
  const notice = createGenerationWatchNotice('Retry this original result.')
  const phases: string[] = []
  const waitFor = async (phase: string) => vi.waitFor(() => {
    if (!phases.includes(phase)) throw new Error(`Missing ${phase}; observed ${JSON.stringify(phases)}`)
  }, { timeout: 5000 })
  const secondAcquire = Promise.withResolvers<undefined>()
  const flushExit = Promise.withResolvers<undefined>()
  const publishFirst = Promise.withResolvers<undefined>()
  onTestFinished(() => {
    leave.resolve(undefined); secondAcquire.resolve(undefined); flushExit.resolve(undefined); publishFirst.resolve(undefined)
  })
  const maintenance = h.agent.runMaintenance(async () => { await leave.promise })
  const authority = h.host.generationWorkspaceAuthority, acquire = authority.acquire.bind(authority)
  let calls = 0
  const acquisition = vi.spyOn(authority, 'acquire').mockImplementation(async (...args) => {
    if (++calls === 2) {
      phases.push('second-acquire-entered')
      await secondAcquire.promise
      const lease = await acquire(...args)
      phases.push('second-workspace-acquired')
      return lease
    }
    const lease = await acquire(...args)
    phases.push('first-workspace-acquired')
    await publishFirst.promise
    return lease
  })
  const flush = h.host.sessions.flush.bind(h.host.sessions)
  let firstLeaseReady = false, captured = false
  const acquireBinding = h.bindings.acquire.bind(h.bindings)
  const binding = vi.spyOn(h.bindings, 'acquire').mockImplementation(async (...args) => {
    const lease = await acquireBinding(...args)
    phases.push('execution-binding-ready')
    firstLeaseReady = true
    return lease
  })
  const failure = new Error('Earlier notice could not persist')
  const ack = vi.spyOn(h.host.sessions, 'flush').mockImplementation(async (...args) => {
    if (firstLeaseReady && !captured) {
      captured = true; phases.push('notice-flush-entered')
      await flushExit.promise
      throw failure
    }
    return await flush(...args)
  })
  onTestFinished(() => { acquisition.mockRestore(); ack.mockRestore(); binding.mockRestore() })
  const first = h.deliver(h.agent.id, notice, caller.signal, undefined, undefined, h.run)
  const firstResult = first.catch((error: unknown) => { phases.push(`first-rejected:${String(error)}`); return error })
  let second: ReturnType<typeof h.send> | undefined
  try {
    await waitFor('first-workspace-acquired')
    publishFirst.resolve(undefined)
    await waitFor('notice-flush-entered')
    expect(h.agent.inbox.nextTurn.map(message => message.id)).toEqual([notice.id])
    caller.abort(new Error('First caller cancelled'))
    second = h.send(notice)
    const secondResult = second.then((value) => { phases.push('second-delivered'); return value }, (error: unknown) => {
      phases.push(`second-rejected:${String(error)}`)
      return error
    })
    await waitFor('second-acquire-entered')
    secondAcquire.resolve(undefined)
    await waitFor('second-delivered')
    expect(await secondResult).toBe('pending')
    flushExit.resolve(undefined)
    expect(await firstResult).toBe(failure)
    expect(await h.send(notice)).toBe('pending')
    expect(h.agent.inbox.nextTurn.map(message => message.id)).toEqual([notice.id])
    expect(calls).toBe(2)
    leave.resolve(undefined); await maintenance; await h.agent.whenIdle()
    h.agent.model.select({ provider: 'mock', model: 'after-replacement-idle' })
    expect(h.adapter.requests).toHaveLength(3)
    expect(h.adapter.requests[2]?.messages.filter(message => message.id === notice.id)).toHaveLength(1)
    expect(h.agent.session.snapshotEvents().filter(event => event.type === 'user/message' && event.data.id === notice.id)).toHaveLength(1)
  } finally {
    publishFirst.resolve(undefined); secondAcquire.resolve(undefined); flushExit.resolve(undefined); leave.resolve(undefined)
    caller.abort(new Error('Fixture release'))
    await Promise.allSettled([first, second, maintenance])
    acquisition.mockRestore(); ack.mockRestore(); binding.mockRestore()
  }
}, 20_000)


it('withholds another authenticated original binding while a continuation is held', async () => {
  const h = await isolatedNativeDelivery(), leave = Promise.withResolvers<undefined>()
  onTestFinished(() => { leave.resolve(undefined) })
  const maintenance = h.agent.runMaintenance(async () => { await leave.promise })
  expect(await h.send()).toBe('pending')
  const binding = { ...h.binding, model: { provider: 'mock', model: 'other-original-model' } }
  const pack = { key: 'c'.repeat(64), previewPath: join(h.root, 'other-original-preview.json') }
  const run = { ...h.run, id: 'd'.repeat(64), binding, packs: [pack] }
  const recorded = Session.create(h.agent.id, undefined, h.agent.session.header), callId = ToolCallId('other-original-call')
  const args = { method: 'submit_video', idempotency_key: pack.key, preview_path: pack.previewPath }
  recorded.append('turn/start', { turn: 1 }); recorded.append('step/start', { turn: 1, step: 1 })
  recorded.append('request/header', { reason: 'initial', header: { config: binding.model } })
  recorded.append('assistant/message', { turn: 1, step: 1, stream: [], message: createMessage({ role: 'assistant',
    content: [{ type: 'tool-call', id: callId, name: 'jubian_storyboard', arguments: JSON.stringify(args) }],
    source: { kind: 'model', ...binding.model } }) }, { surfaceOp: 'append' })
  recorded.append('tool/call', { turn: 1, step: 1, callId, name: 'jubian_storyboard', arguments: JSON.stringify(args) })
  recorded.append('tool/result', { turn: 1, step: 1, message: createToolResultMessage({ callId, content: [], isError: false }),
    meta: { [TOOL_BODY_META_KEY]: { generationWatchId: run.id, submission: args, binding } } }, { surfaceOp: 'append' })
  const open = h.host.sessionPersistence.open.bind(h.host.sessionPersistence)
  const reading = vi.spyOn(h.host.sessionPersistence, 'open').mockImplementationOnce(async (...args) => {
    const handle = await open(...args)
    const result = await handle.read()
    vi.spyOn(handle, 'read').mockResolvedValue({ ...result, events: recorded.snapshotEvents() })
    return handle
  })
  onTestFinished(() => { reading.mockRestore() })
  expect(await h.deliver(h.agent.id, createGenerationWatchNotice('Other original result.'), new AbortController().signal,
    undefined, undefined, run)).toBe('pending')
  reading.mockRestore()
  leave.resolve(undefined); await maintenance; await h.agent.whenIdle()
  expect(h.adapter.requests).toHaveLength(3)
}, 20_000)
