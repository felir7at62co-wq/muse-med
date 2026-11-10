/** Ordinary Host routing preserves the original watch and never repeats an unknown paid submission. */
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, onTestFinished, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { JubianLedger } from '@deepseek-ai/dsh-jubian'
import Llm, { ToolCallId } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SessionProjections from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import Tools from '@deepseek-ai/dsh-tools'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import { createSessionTestController } from '../../../api/session-controller/tests/test-remote.ts'
import { MockAdapter, textResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import { MemoryCredentials } from '../../../credentials/credentials/tests/memory.ts'
import JsonlSessionPersistence from '../../../session/session-persistence-jsonl/src/index.ts'
import { configurationFixture } from '../../../settings/settings/tests/configuration-fixture.ts'
import * as Jubian from '../src/index.ts'
import { GenerationWatchStore } from '../src/generation-watch-store.ts'
import { bodyHash } from '../src/write.ts'

const selection = { provider: 'mock', model: 'mock' }
const group = { roomId: 'production-room', workerBotId: 'worker', requesterBotId: 'director',
  requesterSessionId: 'requester', exchangeId: 'approved-exchange' }

async function host() {
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
    if (url.origin !== 'https://watch-dispatch.invalid' || method !== 'GET') throw new Error('Offline dispatch fixture rejects writes and external traffic')
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
    { id: 'credentials', name: 'cordis:credentials', config: { JUBIANAI_ADMIN_TOKEN: 'offline' } },
    { id: 'llm', name: 'cordis:llm' }, { id: 'sessions', name: 'cordis:sessions' },
    { id: 'projections', name: 'cordis:projections' }, { id: 'agents', name: 'cordis:agents' },
    { id: 'persistence', name: 'cordis:persistence', config: { root: join(root, 'sessions'), compression: 'none' } },
    { id: 'loop', name: 'cordis:loop', config: { agents: [] } },
    { id: 'controller', name: 'cordis:controller' },
    { id: 'jubian', name: 'cordis:jubian', config: { baseUrl: 'https://watch-dispatch.invalid', workspaceSecrets: false,
      ledgerRoot: join(root, 'ledger'), generationWatch: true, watchPollIntervalMs: 60_000, watchTimeoutMs: 60_000,
      videoBatchMaxItems: 2 } },
  ], builtins: { prompt: SystemPrompt, tools: Tools, credentials: MemoryCredentials, llm: Llm, sessions: SessionStore,
    projections: SessionProjections, agents: AgentRegistry, loop: AgentLoop, persistence: JsonlSessionPersistence,
    controller: { inject: ['llm', 'sessions', 'sessionProjections', 'agents'], apply: (scope: Context) => {
      createSessionTestController(scope, { cwd: root, defaultModelSelection: () => selection })
    } }, jubian: Jubian } })
  resources.ctx = configured.ctx
  const current = configured.ctx
  for (const entry of current.loader.entries()) await entry.fiber?.await()
  current.llm.registerAdapter(['mock'], new MockAdapter(Array.from({ length: 4 }, () => textResponse('Keep the original operation.'))))
  const agent = await current.agentLoop.create(SessionId('ordinary-production-owner'), selection, { cwd: root })
  const invoke = (args: Record<string, unknown>, owned = true) => current.tools.execute({ callId: ToolCallId(`dispatch-${requests.length}`),
    name: 'jubian_storyboard', arguments: args, signal: new AbortController().signal, ...(owned ? { agent } : {}) })
  const ledger = new JubianLedger({ root: join(root, 'ledger') })
  const store = new GenerationWatchStore(join(root, 'jubian', 'generation-watches'))
  const prepared = await invoke({ method: 'prepare_video', storyboard_id: 1, project_dir: root }, false)
  if (prepared.isError) throw new Error(JSON.stringify(prepared.content))
  const plan = prepared.value as { preview_path: string; idempotencyKey: string }
  const frozen = JSON.parse(await readFile(plan.preview_path, 'utf8')) as { payload: Record<string, unknown> }
  await ledger.begin({ idempotencyKey: plan.idempotencyKey, scriptId: 2708, method: 'storyboard_native_submit', requestSha256: bodyHash(frozen.payload) })
  await ledger.settle(plan.idempotencyKey, { outcome: 'unknown', httpStatus: null, applicationCode: null, responseSha256: null })
  return { ctx: current, root, requests, agent, store, ledger, plan, invoke }
}

it('captures the room origin on a replayed paid batch and keeps its existing watch on the next invocation', async () => {
  const f = await host()
  f.ctx.provide('museTeam', { captureGenerationWatchOrigin: () => group })
  const args = { method: 'submit_video_batch', video_previews: [{ preview_path: f.plan.preview_path, idempotency_key: f.plan.idempotencyKey }] }
  const first = await f.invoke(args)
  expect(first.isError, JSON.stringify(first.content)).toBe(false)
  expect(first.value).toMatchObject({ generation_watch_group_exchange_id: group.exchangeId })
  const id = String((first.value as Record<string, unknown>).generation_watch_id)
  const stored = await f.store.load(id)
  expect(stored?.groupOrigin).toEqual(group)
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
