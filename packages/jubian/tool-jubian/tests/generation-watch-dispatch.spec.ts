/** Ordinary Host routing preserves the original watch and never repeats an unknown paid submission. */
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, onTestFinished, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import AgentRegistry, { modelSelectionProjectionDefinition } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { JubianLedger } from '@deepseek-ai/dsh-jubian'
import Llm, { ReasoningEffortId, ToolCallId, createUserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore, { Session, SessionId } from '@deepseek-ai/dsh-session'
import SessionProjections from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import Tools, { TOOL_BODY_META_KEY } from '@deepseek-ai/dsh-tools'
import { executeToolFixture } from '@deepseek-ai/dsh-tool-testkit'
import * as NativeExecutor from '@deepseek-ai/dsh-tool-executor-native'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import { createSessionTestController } from '../../../api/session-controller/tests/test-remote.ts'
import { MockAdapter, textResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import { MemoryCredentials } from '../../../credentials/credentials/tests/memory.ts'
import * as JsonlSessionPersistence from '../../../session/session-persistence-jsonl/src/index.ts'
import { configurationFixture } from '../../../settings/settings/tests/configuration-fixture.ts'
import * as Jubian from '../src/index.ts'
import { GenerationWatchStore } from '../src/generation-watch-store.ts'
import LocalFileSystem from '@deepseek-ai/dsh-fs-local'
import WorkingDirectory from '@deepseek-ai/dsh-working-directory'
import Storage from '@deepseek-ai/dsh-storage'
import * as JsonStorage from '@deepseek-ai/dsh-storage-json'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import WorkspaceRegistry from '@deepseek-ai/dsh-workspace'
import * as WorkspaceOwned from '../../../../apps/desktop-host/src/workspace-owned-storage.ts'
import { acquireGenerationSessionBinding, captureGenerationSessionBinding } from '../src/generation-binding.ts'
import { ReactLoopAgent } from '../../../core/agent-loop/src/agent.ts'
import { inboxProjectionDefinition } from '../../../core/agent-loop/src/inbox.ts'
import { GenerationWatchRuntime } from '../src/generation-watch.ts'

// This suite isolates native dispatch; handoff process visibility has dedicated process tests.
vi.mock('../../../../apps/desktop-host/src/workspace-handoff.ts', () => ({ assertWorkspaceMigrationHandoff: vi.fn(async () => undefined) }))
import { bodyHash } from '../src/write.ts'

const selection = { provider: 'mock', model: 'mock' }

async function host(options: { recorded?: boolean; reasoningEffort?: ReasoningEffortId } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'muse-watch-dispatch-'))
  const resources: { ctx?: Context; restoreTransport?: () => void } = {}
  onTestFinished(async () => {
    try { await resources.ctx?.fiber.dispose() }
    finally { resources.restoreTransport?.(); vi.unstubAllEnvs(); await rm(root, { recursive: true, force: true }) }
  })
  vi.stubEnv('DSH_HOME', root)
  const imageUrl = 'https://cdn.invalid/lead.png'
  const model = { platformId: 'YU_DIAN', modelId: 'doubao-seedance-2-0-260128', standardId: 11, genType: 3,
    modelGenerationTypeId: 7, videoStandardId: 91, duration: 8, ratio: '9:16', resolution: '720p', genNum: 1,
    materialList: [], backupModelList: [], prompt: '@[Lead](lead) waits quietly in the courtyard without dialogue.' }
  const board = { id: 1, scriptId: 2708, episodeId: 9, isGenerate: 0, storyboardName: 'EP09-P1',
    modelConfig: JSON.stringify(model), storyboardMaterialList: [{ assetId: 'asset-lead', materialAssetId: 81285,
      fileName: 'Lead', materialKey: 'lead', materialType: 'image', materialUrl: imageUrl, sortOrder: 1 }] }
  const requests: { method: string; path: string }[] = []
  const transport = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : input.toString())
    const method = String(init?.method), path = url.pathname
    requests.push({ method, path })
    if (url.origin !== 'https://watch-dispatch.invalid') throw new Error('Offline dispatch fixture rejects external traffic')
    if (method === 'PUT' && path === '/aigc/storyboard' && options.recorded === false) return Response.json({ code: 200, data: 1 })
    if (method !== 'GET') throw new Error('Offline dispatch fixture rejects unexpected writes')
    let data: unknown
    if (path === '/aigc/storyboard/1') data = board
    else if (path === '/model/charge/getSelectList') data = [{ id: 11, standardId: 11,
      modelId: model.modelId, platformId: model.platformId, genTypes: [{ id: 7, type: 3 }],
      videoStandards: [{ id: 91, ratio: '9:16', resolution: '720p', genNum: 1 }] }]
    else if (path === '/aigc/asset/81285') data = { id: 81285, scriptId: 2708, assetUrl: imageUrl, name: 'Lead' }
    else if (path === '/aigc/material/list') data = { total: 1, rows: [{ id: 1, scriptId: 2708,
      assetId: 81285, hsAssetId: 'asset-lead', assetUrl: imageUrl, assetName: 'Lead', hsAssetStatus: 'Active', isUsed: 1 }] }
    else if (path === '/admin/aigc/video/task/list') data = { total: 0, rows: [] }
    else throw new Error(`Unexpected offline route: ${method} ${path}`)
    return Response.json({ code: 200, data })
  })
  resources.restoreTransport = () => { transport.mockRestore() }
  await writeFile(join(root, 'project_config.json'), JSON.stringify({ jubian_script_id: 2708 }))
  const configured = await configurationFixture({ hmr: false, rows: [
    { id: 'prompt', name: 'cordis:prompt' }, { id: 'tools', name: 'cordis:tools' },
    { id: 'native', name: 'cordis:native-executor' },
    { id: 'credentials', name: 'cordis:credentials', config: { JUBIANAI_ADMIN_TOKEN: 'offline' } },
    { id: 'llm', name: 'cordis:llm' }, { id: 'sessions', name: 'cordis:sessions' },
    { id: 'projections', name: 'cordis:projections' }, { id: 'agents', name: 'cordis:agents' },
    { id: 'persistence', name: 'cordis:persistence', config: { root: join(root, 'sessions'), compression: 'none' } },
    { id: 'loop', name: 'cordis:loop', config: { agents: [] } },
    { id: 'controller', name: 'cordis:controller' },
    { id: 'jubian', name: 'cordis:jubian', config: { baseUrl: 'https://watch-dispatch.invalid', workspaceSecrets: false,
      ledgerRoot: join(root, 'ledger'), generationWatch: true, watchPollIntervalMs: 60_000, watchTimeoutMs: 60_000,
      videoBatchMaxItems: 2 } },
  ], builtins: { prompt: SystemPrompt, tools: Tools, 'native-executor': NativeExecutor, credentials: MemoryCredentials, llm: Llm, sessions: SessionStore,
    projections: SessionProjections, agents: AgentRegistry, loop: AgentLoop, persistence: JsonlSessionPersistence,
    controller: { inject: ['llm', 'sessions', 'sessionProjections', 'agents'], apply: async (scope: Context) => {
      await createSessionTestController(scope, { cwd: root, defaultModelSelection: () => selection })
    } }, jubian: Jubian } })
  resources.ctx = configured.ctx
  const current = configured.ctx
  for (const entry of current.loader.entries()) await entry.fiber?.await()
  current.llm.registerAdapter(['mock'], new MockAdapter(Array.from({ length: 4 }, () => textResponse('Keep the original operation.')),
    options.reasoningEffort === undefined ? undefined : { efforts: [{ id: options.reasoningEffort, name: 'High' }] }))
  await current.plugin(LocalFileSystem, { cwd: root })
  const directoryFiber = current.plugin(WorkingDirectory); await directoryFiber
  const agent = await current.agentLoop.create(SessionId('ordinary-production-owner'),
    { ...selection, ...options.reasoningEffort === undefined ? {} : { reasoningEffort: options.reasoningEffort } }, { cwd: root })
  agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Open the original production task.' }], source: { kind: 'user' } }))
  await agent.whenIdle()
  await current.sessions.flush(agent.session)
  await current.plugin(Storage)
  await current.plugin(JsonStorage, { root: join(root, 'storages') })
  await current.plugin(WorkspaceOwned, { sourceBackend: 'json', root: join(root, 'storages', 'workspace-owned-v1') })
  await current.plugin(StorageDomain, { backend: 'json', routes: { workspace: 'muse-workspace-owned' } })
  await current.plugin(WorkspaceRegistry)
  const workspace = await current.workspaceRegistry.create(root)
  await workspace.attachSession(agent.id)
  const invoke = (args: Record<string, unknown>, owned = true) => executeToolFixture(current, { callId: ToolCallId(`dispatch-${requests.length}`),
    name: 'jubian_storyboard', arguments: args, signal: new AbortController().signal, ...(owned ? { agent } : {}) })
  const ledger = new JubianLedger({ root: join(root, 'ledger') })
  const store = new GenerationWatchStore(join(root, 'jubian', 'generation-watches'))
  const prepared = await invoke({ method: 'prepare_video', storyboard_id: 1, project_dir: root }, false)
  if (prepared.isError) throw new Error(JSON.stringify(prepared.content))
  const plan = prepared.value as { preview_path: string; idempotencyKey: string }
  const frozen = JSON.parse(await readFile(plan.preview_path, 'utf8')) as { payload: Record<string, unknown> }
  if (options.recorded !== false) {
    await ledger.begin({ idempotencyKey: plan.idempotencyKey, scriptId: 2708, method: 'storyboard_native_submit', requestSha256: bodyHash(frozen.payload) })
    await ledger.settle(plan.idempotencyKey, { outcome: 'unknown', httpStatus: null, applicationCode: null, responseSha256: null })
  } else {
    await mkdir(ledger.root, { recursive: true })
    await writeFile(join(ledger.root, 'authorization.json'), JSON.stringify({ version: 1,
      projects: { 2708: { limit: '10', unit: 'CNY', estimates: { storyboard_native_submit: '1' } } } }))
  }
  return { ctx: current, root, requests, agent, store, ledger, plan, invoke, workspace, directoryFiber }
}

it('keeps the original watch on replay without reviving an archived group', async () => {
  const f = await host()
  f.ctx.provide('museTeam', { captureGenerationWatchOrigin: () => { throw new Error('Archived group must not be used') } })
  const args = { method: 'submit_video_batch', video_previews: [{ preview_path: f.plan.preview_path, idempotency_key: f.plan.idempotencyKey }] }
  const first = await f.invoke(args)
  expect(first.isError, JSON.stringify(first.content)).toBe(false)
  expect(first.value).not.toHaveProperty('generation_watch_group_exchange_id')
  const id = String((first.value as Record<string, unknown>).generation_watch_id)
  const stored = await f.store.load(id)
  expect(stored?.groupOrigin).toBeUndefined()
  if (!stored) throw new Error('Missing persisted watch')
  await f.store.put({ ...stored, packs: stored.packs.map(pack => ({ ...pack, outcome: { status: 'unverified', detail: 'Original result remains unknown.' } })),
    notice: { id: 'bca2396b-8df0-47bb-ae89-e70cec282371', text: 'Original result remains unknown.', deliveredAt: Date.now() } })
  const replayed = await f.invoke(args)
  expect(replayed.isError, JSON.stringify(replayed.content)).toBe(false)
  expect(replayed.value).toMatchObject({ generation_watch_id: id })
  expect(replayed.value).not.toHaveProperty('generation_watch_group_exchange_id')
  expect((await f.store.load(id))?.notice?.text).toBe('Original result remains unknown.')
  expect(f.requests.every(row => row.method === 'GET')).toBe(true)
  expect(await f.ledger.records()).toHaveLength(1)
})

it.each([0, 3])('leaves a batch of %s previews to normal preflight without enrolling a watch', async (count) => {
  const f = await host()
  const video_previews = Array.from({ length: count }, () => ({
    preview_path: f.plan.preview_path, idempotency_key: f.plan.idempotencyKey }))
  const result = await f.invoke({ method: 'submit_video_batch', video_previews })
  expect(result.isError).toBe(true)
  expect(await f.store.listActive()).toEqual([])
  expect(f.requests.every(row => row.method === 'GET')).toBe(true)
})

it('refuses a session that the Host cannot resolve before enrolling or dispatching', async () => {
  const f = await host()
  const resolve = vi.spyOn(f.ctx.sessionController, 'resolveAgent').mockResolvedValueOnce({
    error: new RemoteError('session/not-found', 'The ordinary owner is absent', { sessionId: f.agent.session.id }),
  })
  onTestFinished(() => { resolve.mockRestore() })
  const result = await f.invoke({ method: 'submit_video', preview_path: f.plan.preview_path, idempotency_key: f.plan.idempotencyKey })
  expect(result.isError).toBe(true)
  expect(result.content).toMatchObject([{ type: 'text', text: 'Error: Submit paid video from the ordinary owning Muse session so it can resume after restart.' }])
  expect(await f.store.listActive()).toEqual([])
})

it.each(['submit_video', 'submit_video_batch', 'generate'] as const)('fences a new %s once and retains its exact submission metadata', async (method) => {
  const f = await host({ recorded: false, ...method === 'generate' ? {} : { reasoningEffort: ReasoningEffortId('high') } })
  const item = { preview_path: f.plan.preview_path, idempotency_key: f.plan.idempotencyKey }
  const args = method === 'submit_video_batch' ? { method, video_previews: [item] } : { method, ...item }
  const result = await f.invoke(args)
  expect(result.isError, JSON.stringify(result.content)).toBe(false)
  expect(f.requests.filter(row => row.method === 'PUT')).toEqual([{ method: 'PUT', path: '/aigc/storyboard' }])
  const [watch] = await f.store.listAll()
  expect(watch?.binding?.model).toEqual({ ...selection, ...method === 'generate' ? {} : { reasoningEffort: 'high' } })
  expect(result.meta).toMatchObject({ [TOOL_BODY_META_KEY]: { generationWatchId: watch?.id, submission: args,
    binding: { sessionId: f.agent.id, model: watch?.binding?.model } } })
  expect((await f.ledger.find(item.idempotency_key))?.outcome).toBe('accepted')
  const replay = await f.invoke(args)
  expect(replay.isError, JSON.stringify(replay.content)).toBe(false)
  expect(f.requests.filter(row => row.method === 'PUT')).toHaveLength(1)
})

it('keeps an inferred preview path out of explicit-path submission metadata', async () => {
  const f = await host()
  const result = await f.invoke({ method: 'submit_video', project_dir: f.root, storyboard_id: 1,
    idempotency_key: f.plan.idempotencyKey })
  expect(result.isError, JSON.stringify(result.content)).toBe(false)
  expect(result.meta ?? {}).not.toHaveProperty(TOOL_BODY_META_KEY)
  expect(await f.store.listAll()).toHaveLength(1)
})

it('does not construct watch metadata for primitive or unbound presentation arguments', async () => {
  const f = await host()
  const output = f.ctx.tools.get('jubian_storyboard')?.output
  expect(output?.presentationMeta?.(null, { generation_watch_id: 'untrusted-watch' })).toBeUndefined()
  expect(output?.presentationMeta?.('submit_video', { generation_watch_id: 'untrusted-watch' })).toBeUndefined()
  expect(output?.presentationMeta?.({}, { generation_watch_id: 'untrusted-watch' })).toBeUndefined()
})

it('refuses a new submission without the original working-directory owner capability', async () => {
  const f = await host({ recorded: false })
  await f.directoryFiber.dispose()
  const result = await f.invoke({ method: 'submit_video', preview_path: f.plan.preview_path, idempotency_key: f.plan.idempotencyKey })
  expect(result.isError).toBe(true)
  expect(result.content).toMatchObject([{ type: 'text', text: 'Error: Video submission requires the original native Session, model and owned Workspace' }])
  expect(f.requests.every(row => row.method === 'GET')).toBe(true)
  expect(await f.store.listAll()).toEqual([])
})

it('does not capture a native binding before its first model request or after membership removal', async () => {
  const f = await host()
  const fresh = await f.ctx.agentLoop.create(SessionId('not-yet-requested'), selection, { cwd: f.root })
  const signal = new AbortController().signal
  expect(await captureGenerationSessionBinding(f.ctx, fresh, signal)).toBeUndefined()
  await f.workspace.detachSession(f.agent.id)
  expect(await captureGenerationSessionBinding(f.ctx, f.agent, signal)).toBeUndefined()
})

it('does not acquire a binding for a different or unregistered native Session', async () => {
  const f = await host()
  const signal = new AbortController().signal
  const captured = await captureGenerationSessionBinding(f.ctx, f.agent, signal)
  if (!captured) throw new Error('Expected owned native binding')
  captured.lease.release()
  await expect(acquireGenerationSessionBinding(f.ctx, f.agent, { ...captured.binding, sessionId: SessionId('different-session') }, signal))
    .rejects.toThrow('does not name the live native Session')
  const session = Session.create(SessionId('unregistered-binding'), [], { ...f.agent.session.header, id: SessionId('unregistered-binding') })
  const model = await f.ctx.sessionProjections.register(modelSelectionProjectionDefinition)
  const inbox = await f.ctx.sessionProjections.register(inboxProjectionDefinition)
  const agent = new ReactLoopAgent(f.ctx, session.id, selection, session,
    { modelSelection: model.readerFor(session), inbox: inbox.readerFor(session) }, 0)
  onTestFinished(async () => { await agent.scope.dispose() })
  await expect(acquireGenerationSessionBinding(f.ctx, agent, { ...captured.binding, sessionId: agent.id }, signal))
    .rejects.toThrow('does not name the live native Session')
})

it('returns no binding when a capability unloads while workspace capture is in flight', async () => {
  const f = await host()
  const capture = f.ctx.generationWorkspaceAuthority.capture.bind(f.ctx.generationWorkspaceAuthority)
  vi.spyOn(f.ctx.generationWorkspaceAuthority, 'capture').mockImplementationOnce(async (...args) => {
    const identity = await capture(...args)
    await f.directoryFiber.dispose()
    return identity
  })
  expect(await captureGenerationSessionBinding(f.ctx, f.agent, new AbortController().signal)).toBeUndefined()
})

it.each(['agent', 'session'] as const)('rechecks an advanced native %s owner before a side effect', async (owner) => {
  const f = await host()
  const id = SessionId(`advanced-binding-${owner}`)
  const session = Session.create(id, f.agent.session.snapshotEvents(), { ...f.agent.session.header, id })
  const model = await f.ctx.sessionProjections.register(modelSelectionProjectionDefinition)
  const inbox = await f.ctx.sessionProjections.register(inboxProjectionDefinition)
  const agent = new ReactLoopAgent(f.ctx, id, selection, session,
    { modelSelection: model.readerFor(session), inbox: inbox.readerFor(session) }, 0)
  const detachSession = f.ctx.sessions.enter(session)
  const detachAgent = f.ctx.agents.enter(agent, undefined)
  onTestFinished(async () => { detachAgent(); detachSession(); await agent.scope.dispose() })
  await f.workspace.attachSession(id)
  const captured = await captureGenerationSessionBinding(f.ctx, agent, new AbortController().signal)
  if (!captured) throw new Error('Expected advanced native binding')
  try {
    if (owner === 'agent') detachAgent()
    if (owner === 'session') detachSession()
    expect(() => { captured.lease.assertCurrent() }).toThrow('generation Session owner changed')
  } finally { captured.lease.release() }
})

it('revokes the native lease synchronously when its announced Session directory changes', async () => {
  const f = await host()
  const captured = await captureGenerationSessionBinding(f.ctx, f.agent, new AbortController().signal)
  if (!captured) throw new Error('Expected owned native binding')
  f.agent.session.append('working-directory/change', { cwd: join(f.root, 'moved') })
  expect(captured.lease.signal.aborted).toBe(true)
  expect(() => { captured.lease.assertCurrent() }).toThrow()
  captured.lease.release()
})

it('does not allow a subagent to inherit an ordinary Session generation binding', async () => {
  const f = await host()
  const signal = new AbortController().signal
  const captured = await captureGenerationSessionBinding(f.ctx, f.agent, signal)
  if (!captured) throw new Error('Expected owned native binding')
  captured.lease.release()
  const child = await f.ctx.agents.create({ sessionId: SessionId('generation-binding-child'), parentAgent: f.agent,
    meta: { origin: 'subagent', cwd: f.root }, agentOptions: selection })
  await expect(acquireGenerationSessionBinding(f.ctx, child.agent, { ...captured.binding, sessionId: child.agent.id }, signal))
    .rejects.toThrow('does not name the live native Session')
})

it('keeps the repeated-dispatch fence when its paid ledger disappears after enrollment', async () => {
  const f = await host({ recorded: false })
  const args = { method: 'submit_video', preview_path: f.plan.preview_path, idempotency_key: f.plan.idempotencyKey }
  expect((await f.invoke(args)).isError).toBe(false)
  // oxlint-disable-next-line typescript/unbound-method -- apply preserves the runtime receiver in this decorator.
  const enroll = GenerationWatchRuntime.prototype.enroll
  const decorated = vi.spyOn(GenerationWatchRuntime.prototype, 'enroll').mockImplementation(async function (this: GenerationWatchRuntime, ...args) {
    const result = await enroll.apply(this, args)
    if (!result.initial) for (const name of await readdir(f.ledger.root)) {
      if (name.endsWith('.ndjson')) await rm(join(f.ledger.root, name))
    }
    return result
  })
  try {
    const replay = await f.invoke(args)
    expect(replay.isError).toBe(true)
    const [content] = replay.content
    expect(content?.type).toBe('text')
    if (content?.type === 'text') expect(content.text).toContain('original video dispatch is already owned')
  } finally { decorated.mockRestore() }
  expect(f.requests.filter(row => row.method === 'PUT')).toHaveLength(1)
})

it('releases the workspace reservation when an original model selection no longer matches', async () => {
  const f = await host()
  const signal = new AbortController().signal
  const captured = await captureGenerationSessionBinding(f.ctx, f.agent, signal)
  if (!captured) throw new Error('Expected owned native binding')
  captured.lease.release()
  f.agent.model.select({ provider: 'mock', model: 'changed' })
  await expect(acquireGenerationSessionBinding(f.ctx, f.agent, captured.binding, signal)).rejects.toThrow('guarded model selection does not match')
  const workspace = await f.ctx.generationWorkspaceAuthority.acquire(captured.binding, signal)
  workspace.assertCurrent()
  workspace.release()
})
