/** Keyless Loader coverage for automatic continuation after an original video receipt. */
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, onTestFinished, vi } from 'vitest'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { JubianLedger } from '@deepseek-ai/dsh-jubian'
import Llm, { createUserMessage, LlmError, ToolCallId } from '@deepseek-ai/dsh-llm'
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
import { GenerationWatchStore } from '../src/generation-watch-store.ts'
import { createGenerationWatchNotice, deliverGenerationWatchNotice, registerGenerationWatchDelivery } from '../src/generation-watch-delivery.ts'
import * as Jubian from '../src/index.ts'
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

async function watchHost(root: string, generationWatch = true): Promise<Context> {
  const { ctx } = await configurationFixture({ hmr: false, rows: [
    { id: 'prompt', name: 'cordis:prompt' }, { id: 'tools', name: 'cordis:tools' },
    { id: 'executor', name: 'cordis:executor' },
    { id: 'credentials', name: 'cordis:credentials', config: { JUBIANAI_ADMIN_TOKEN: 'offline-token' } },
    { id: 'llm', name: 'cordis:llm' }, { id: 'sessions', name: 'cordis:sessions' },
    { id: 'projections', name: 'cordis:projections' }, { id: 'agents', name: 'cordis:agents' },
    { id: 'persistence', name: 'cordis:persistence', config: { root: join(root, 'sessions'), compression: 'none' } },
    { id: 'loop', name: 'cordis:loop', config: { agents: [], durableInboxClaims: generationWatch } },
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

async function originalVideoFixture(script: AdapterScript) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'muse-generation-native-loader-')))
  let host: Context | undefined
  let finished = false
  const childHolder: { value?: Record<string, unknown> } = {}
  const calls: { method: string; path: string }[] = []
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
    if (path === '/admin/aigc/video/task/list') return answer(childHolder.value ? { total: 1, rows: [task] } : { total: 0, rows: [] })
    if (path === '/admin/aigc/video/task/42') return answer(task)
    if (path === '/admin/aigc/video/task/sub/list' && childHolder.value) return answer({ total: 1, rows: [{ ...childHolder.value, taskStatus,
      resultList: finished ? [{ tosVideoUrl: video, firstResultId: 61 }] : [] }] })
    throw new Error(`Unexpected provider route: ${method} ${path}`)
  })
  onTestFinished(async () => { await host?.fiber.dispose(); fetch.mockRestore(); await rm(root, { recursive: true, force: true }) })
  await mkdir(join(root, 'ledger'))
  await writeFile(join(root, 'project_config.json'), JSON.stringify({ jubian_script_id: 2708 }))
  host = await watchHost(root)
  const prepared = await executeToolFixture(host, { callId: ToolCallId('prepare-original'), name: 'jubian_storyboard',
    arguments: { method: 'prepare_video', storyboard_id: 1, project_dir: root }, signal: new AbortController().signal })
  expect(prepared.isError, JSON.stringify(prepared.content)).toBe(false)
  const text = prepared.content.find(block => block.type === 'text')
  if (text?.type !== 'text') throw new Error('Expected native preview')
  const { preview_path, idempotencyKey } = JSON.parse(text.text) as { preview_path: string; idempotencyKey: string }
  const { payload } = JSON.parse(await readFile(preview_path, 'utf8')) as { payload: Record<string, unknown> }
  childHolder.value = { id: 51, aigcVideoTaskId: 42, storyboardId: 1, resolution: '720p',
    modelConfig: payload.modelConfig, imageMaterials: payload.storyboardMaterialList }
  const ledger = new JubianLedger({ root: join(root, 'ledger') })
  await ledger.begin({ idempotencyKey, scriptId: 2708, method: 'storyboard_native_submit', requestSha256: bodyHash(payload) })
  await ledger.settle(idempotencyKey, { outcome: 'accepted', httpStatus: 200, applicationCode: 200, responseSha256: null })
  const adapter = new MockAdapter([toolCallResponse('original-submit', 'jubian_storyboard',
    { method: 'submit_video', preview_path, idempotency_key: idempotencyKey }), textResponse('Provider is generating the pack.'), ...script])
  host.llm.registerAdapter(['mock'], adapter)
  const agent = await host.agentLoop.create(SessionId('original-loader-owner'), selection, { cwd: root })
  await (await host.workspaceRegistry.create(root)).attachSession(agent.id)
  agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Continue EP43.' }], source: { kind: 'user' } }))
  await agent.whenIdle()
  expect(adapter.requests).toHaveLength(2)
  const store = new GenerationWatchStore(join(root, 'watches')), [run] = await store.listActive()
  if (run?.binding === undefined) throw new Error('The actual submission did not record its native binding: '+JSON.stringify(agent.session.snapshotEvents().filter(event => event.type === 'tool/result' || event.type === 'turn/end')))
  const workspace = host.workspaceRegistry.get(run.binding.workspaceId)
  expect(workspace?.sessionIds).toContain(agent.id)
  return { root, host, agent, adapter, store, run, binding: run.binding, bytes, calls,
    complete: () => { finished = true },
    reopen: async () => { await host?.fiber.dispose(); host = await watchHost(root); return host } }
}

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
