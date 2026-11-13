/** Keyless Loader coverage for automatic continuation after an original video receipt. */
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, onTestFinished, vi } from 'vitest'
import AgentRegistry, { agentEvents } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { JubianLedger } from '@deepseek-ai/dsh-jubian'
import Llm, { createMessage, createToolResultMessage, createUserMessage, LlmError, MessageId, ReasoningEffortId, ToolCallId } from '@deepseek-ai/dsh-llm'
import SessionStore, { Session, SessionId } from '@deepseek-ai/dsh-session'
import SessionProjections from '@deepseek-ai/dsh-session-projection'
import { SessionPersistenceRevision } from '@deepseek-ai/dsh-session-persistence'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import LocalFileSystem from '@deepseek-ai/dsh-fs-local'
import WorkingDirectory from '@deepseek-ai/dsh-working-directory'
import Storage from '@deepseek-ai/dsh-storage'
import * as JsonStorage from '@deepseek-ai/dsh-storage-json'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import WorkspaceRegistry from '@deepseek-ai/dsh-workspace'
import * as WorkspaceOwned from '../../../../apps/desktop-host/src/workspace-owned-storage.ts'
import Tools, { TOOL_BODY_META_KEY } from '@deepseek-ai/dsh-tools'
import { defineContentToolFixture, executeToolFixture } from '@deepseek-ai/dsh-tool-testkit'
import { Context } from '@deepseek-ai/cordis'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import { createSessionTestController } from '../../../api/session-controller/tests/test-remote.ts'
import { MockAdapter, textResponse, toolCallResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import { MemoryCredentials } from '../../../credentials/credentials/tests/memory.ts'
import * as JsonlSessionPersistence from '../../../session/session-persistence-jsonl/src/index.ts'
import * as NativeExecutor from '@deepseek-ai/dsh-tool-executor-native'
import { configurationFixture } from '../../../settings/settings/tests/configuration-fixture.ts'
import { GenerationWatchStore } from '../src/generation-watch-store.ts'
import { createGenerationWatchNotice, deliverGenerationWatchNotice, registerGenerationWatchDelivery } from '../src/generation-watch-delivery.ts'
import { createNativeGenerationDelivery, type NativeGenerationDelivery } from '../src/generation-watch-native-delivery.ts'
import type { GenerationWorkspaceLease } from '../src/generation-binding.ts'
import * as GenerationBinding from '../src/generation-binding.ts'
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

async function originalVideoFixture(script: AdapterScript, reasoningEffort?: ReasoningEffortId) {
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
    { method: 'submit_video', preview_path, idempotency_key: idempotencyKey }), textResponse('Provider is generating the pack.'), ...script],
  reasoningEffort === undefined ? undefined : { efforts: [{ id: reasoningEffort, name: 'High' }] })
  host.llm.registerAdapter(['mock'], adapter)
  const agent = await host.agentLoop.create(SessionId('original-loader-owner'),
    { ...selection, ...reasoningEffort === undefined ? {} : { reasoningEffort } }, { cwd: root })
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

async function isolatedNativeDelivery(script: AdapterScript = [textResponse('Continue the exact original operation.')],
  setup?: (ctx: Context) => void, withoutAuthority = false, reasoningEffort?: ReasoningEffortId) {
  const h = await originalVideoFixture(script, reasoningEffort)
  const producer = [...h.host.loader.entries()].find(entry => entry.options.id === 'jubian')!
  await producer.fiber!.dispose()
  let deliver!: NativeGenerationDelivery
  const owner = withoutAuthority ? h.host.isolate('generationWorkspaceAuthority') : h.host
  const scope = owner.plugin({ name: 'isolated-generation-delivery',
    inject: ['agents', 'agentLoop', 'tools', 'sessionProjections', 'sessionController', 'sessions', 'sessionPersistence', 'workingDirectory'],
    apply: async (ctx: Context) => {
      deliver = createNativeGenerationDelivery(ctx, await registerGenerationWatchDelivery(ctx))
      setup?.(ctx)
    } })
  await scope.await()
  return { ...h, scope, deliver,
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
  const deliver = createNativeGenerationDelivery(legacy, await registerGenerationWatchDelivery(legacy))
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
  await vi.waitFor(() => { expect(h.adapter.requests).toHaveLength(3) })
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
  const acquire = GenerationBinding.acquireGenerationSessionBinding
  const acquiring = vi.spyOn(GenerationBinding, 'acquireGenerationSessionBinding').mockImplementation(async (...args) => {
    const lease = await acquire(...args)
    if (lease === undefined) throw new Error('The fixture requires an owned execution')
    if (mode === 'caller-abort') caller.abort(new Error('Caller cancelled before publication'))
    else lease.release()
    return lease
  })
  onTestFinished(() => { acquiring.mockRestore() })
  await expect(h.deliver(h.agent.id, createGenerationWatchNotice('Original task.'), caller.signal,
    undefined, undefined, h.run)).rejects.toThrow(mode === 'caller-abort' ? 'Caller cancelled before publication' : 'binding released')
  acquiring.mockRestore()
  h.agent.model.select({ provider: 'mock', model: 'after-rejected-publication' })
}, 20_000)

it('keeps a replacement held lease when an earlier cancelled delivery fails to persist', async () => {
  const h = await isolatedNativeDelivery(), caller = new AbortController(), leave = Promise.withResolvers<undefined>()
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
  const acquireBinding = GenerationBinding.acquireGenerationSessionBinding
  const binding = vi.spyOn(GenerationBinding, 'acquireGenerationSessionBinding').mockImplementation(async (...args) => {
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
  const first = h.deliver(h.agent.id, createGenerationWatchNotice('First result.'), caller.signal, undefined, undefined, h.run)
  const firstResult = first.catch((error: unknown) => { phases.push(`first-rejected:${String(error)}`); return error })
  let second: ReturnType<typeof h.send> | undefined
  try {
    // Observation I/O may reorder callers; pin the cancellable owner before starting its replacement.
    await waitFor('first-workspace-acquired')
    second = h.send()
    const secondResult = second.then((value) => { phases.push('second-delivered'); return value }, (error: unknown) => {
      phases.push(`second-rejected:${String(error)}`)
      return error
    })
    await waitFor('second-acquire-entered')
    publishFirst.resolve(undefined)
    await waitFor('notice-flush-entered')
    caller.abort(new Error('First caller cancelled'))
    secondAcquire.resolve(undefined)
    await waitFor('second-delivered')
    expect(await secondResult).toBe('pending')
    flushExit.resolve(undefined)
    expect(await firstResult).toBe(failure)
    expect(await h.send()).toBe('pending')
    expect(calls).toBe(2)
    leave.resolve(undefined); await maintenance; await h.agent.whenIdle()
    h.agent.model.select({ provider: 'mock', model: 'after-replacement-idle' })
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
