/** Native preview failures report local diagnostics through the Loader and Agent session. */
import * as NativeToolExecutor from '@deepseek-ai/dsh-tool-executor-native'
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, it, onTestFinished, vi } from 'vitest'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { JubianLedger } from '@deepseek-ai/dsh-jubian'
import { buildNativeVideoPreview, stableSha256, submissionSemantics } from '@deepseek-ai/dsh-jubian-api'
import Llm, { createUserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SessionProjections from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import Tools from '@deepseek-ai/dsh-tools'
import { MockAdapter, textResponse, toolCallResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import { MemoryCredentials } from '../../../credentials/credentials/tests/memory.ts'
import { configurationFixture } from '../../../settings/settings/tests/configuration-fixture.ts'
import * as Jubian from '../src/index.ts'
import { bodyHash } from '../src/write.ts'
// This offline provider fixture is loaded by cordis.yml and has no TypeScript declaration artifact.
// @ts-expect-error The runtime fixture intentionally has no declaration file.
import * as episodeFixtureModule from '../../../../snapshots/session/muse-native-episode-ownership/episode-fixture.mjs'

const { createEpisodeOwnershipTransport, episodeOwnershipInputs } = episodeFixtureModule as {
  createEpisodeOwnershipTransport: (root: string) => typeof fetch
  episodeOwnershipInputs: (storyboardId: number) => Parameters<typeof buildNativeVideoPreview>[0]
}

async function mountedNativeTools(options: { baseUrl?: string } = {}) {
  const { ctx, home } = await configurationFixture({ hmr: false, rows: [
    { id: 'tool-executor-native', name: 'cordis:native-executor' },
    { id: 'prompt', name: 'cordis:prompt' }, { id: 'tools', name: 'cordis:tools' },
    { id: 'credentials', name: 'cordis:credentials', config: { JUBIANAI_ADMIN_TOKEN: 'mock-token' } },
  ], builtins: { 'native-executor': NativeToolExecutor, prompt: SystemPrompt, tools: Tools, credentials: MemoryCredentials, jubian: Jubian } })
  const ledgerRoot = join(home, 'ledger')
  await ctx.loader.create({ name: 'cordis:jubian', config: { ledgerRoot, workspaceSecrets: false, ...options } })
  await ctx.loader.await()
  for (const entry of ctx.loader.entries()) await entry.fiber?.await()
  await ctx.plugin(Llm); await ctx.plugin(SessionStore); await ctx.plugin(SessionProjections)
  await ctx.plugin(AgentRegistry); await ctx.plugin(AgentLoop, { agents: [] })
  return { ctx, home, ledgerRoot }
}

it('records the empty-subject diagnostic without ledger or HTTP side effects', async () => {
  const { ctx, home, ledgerRoot } = await mountedNativeTools()
  const noNetwork = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Unexpected provider request'))
  try {
    const payload = { id: 1, scriptId: 2708, isGenerate: 1, storyboardMaterialList: [],
      modelConfig: JSON.stringify({ modelId: 'doubao-seedance-2-0-260128', platformId: 'YU_DIAN',
        standardId: 11, genType: 3, modelGenerationTypeId: 7, videoStandardId: 91,
        duration: 8, genNum: 1, ratio: '9:16', resolution: '720p', prompt: 'A quiet street', materialList: [] }) }
    const key = stableSha256(submissionSemantics(payload))
    await mkdir(join(home, 'video_tasks'))
    const previewPath = join(home, 'video_tasks', 'empty.storyboard-native.prepared.json')
    await writeFile(previewPath, JSON.stringify({ version: 1, operation: 'prepare_storyboard_native_video',
      status: 'prepared', createdAt: '2026-10-08T00:00:00Z', scriptId: 2708, storyboardId: 1,
      estimatedSubmissions: 1, assetSummary: { count: 0, orderedAssets: [] }, payload,
      idempotencyKey: key, nextAction: 'Review before submitting' }))
    const adapter = new MockAdapter([
      toolCallResponse('empty-preview', 'jubian_storyboard', { method: 'submit_video',
        preview_path: previewPath, idempotency_key: key }),
      textResponse('Stopped before submission.'),
    ])
    ctx.llm.registerAdapter(['mock'], adapter)
    const agent = await ctx.agentLoop.create(SessionId('empty-preview-owner'),
      { provider: 'mock', model: 'mock' }, { cwd: home })
    agent.followup(createUserMessage({ source: { kind: 'user' },
      content: [{ type: 'text', text: 'Check this prepared video.' }] }))
    await agent.whenIdle()
    expect(adapter.requests).toHaveLength(2)
    const results = agent.session.snapshotEvents().filter(event => event.type === 'tool/result')
      .map(event => ({ isError: event.data.message.isError, content: event.data.message.content }))
    expect(results).toHaveLength(1)
    expect(results[0]?.isError).toBe(true)
    expect(results).toMatchSnapshot('local empty-subject refusal')
    expect(noNetwork).not.toHaveBeenCalled()
    expect(await new JubianLedger({ root: ledgerRoot }).records()).toEqual([])
  } finally {
    noNetwork.mockRestore()
    await ctx.fiber.dispose()
  }
})

it('reports cross-page task duplication before a selection PUT through the Loader', async () => {
  const url = 'https://jubian-aigc.tos-cn-beijing.volces.com/prod/lead.jpg'
  const rows = Array.from({ length: 100 }, (_, index) => ({ id: index + 1, scriptId: 2708, taskType: 3 }))
  const pages: string[] = []
  const transport = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const address = new URL(input instanceof Request ? input.url : input.toString())
    const answer = (data: unknown) => new Response(JSON.stringify({ code: 200, data }))
    if (init?.method !== 'GET') throw new Error('Selection must stop before a write')
    if (address.pathname.endsWith('/aigc/storyboard/1')) return answer({ id: 1, scriptId: 2708,
      modelConfig: JSON.stringify({ prompt: '@[Lead](lead)', materialList: [] }), storyboardMaterialList: [] })
    if (address.pathname.endsWith('/aigc/asset/81285')) return answer({ id: 81285, scriptId: 2708, assetUrl: url, name: 'Lead' })
    if (address.pathname.endsWith('/aigc/material/list')) return answer({ total: 1, rows: [
      { id: 1, assetId: 81285, scriptId: 2708, hsAssetId: 'lead-id', assetUrl: url,
        assetName: 'Lead', hsAssetStatus: 'Active', isUsed: 1 },
    ] })
    if (address.pathname.endsWith('/admin/aigc/video/task/list')) {
      const page = address.searchParams.get('pageNum') ?? ''
      pages.push(page)
      return answer({ total: 101, rows: page === '1' ? rows : [rows[0]] })
    }
    throw new Error(`Unexpected selection request ${address.pathname}`)
  })
  onTestFinished(() => { transport.mockRestore() })
  const { ctx, home, ledgerRoot } = await mountedNativeTools({ baseUrl: 'https://selection-diagnostic.invalid/prod-api' })
  try {
    const adapter = new MockAdapter([
      toolCallResponse('select-with-duplicate-tasks', 'jubian_storyboard', { method: 'select_assets',
        storyboard_id: 1, idempotency_key: 'select-with-duplicate-tasks',
        selections: [{ material_key: 'lead', asset_id: 81285 }] }),
      textResponse('The binding was blocked before saving. Check the project task inventory.'),
    ])
    ctx.llm.registerAdapter(['mock'], adapter)
    const agent = await ctx.agentLoop.create(SessionId('selection-diagnostic-owner'),
      { provider: 'mock', model: 'mock' }, { cwd: home })
    agent.followup(createUserMessage({ source: { kind: 'user' },
      content: [{ type: 'text', text: 'Bind the selected project reference.' }] }))
    await agent.whenIdle()
    const results = agent.session.snapshotEvents().filter(event => event.type === 'tool/result')
    expect(results).toHaveLength(1)
    const result = results[0]?.data
    expect(result?.message.isError).toBe(true)
    const content = result?.message.content[0]
    if (content?.type !== 'text') throw new Error('Expected image selection diagnostic')
    expect(content.text).toMatchInlineSnapshot('"Error: Jubian response did not match the expected envelope: select_assets stage=before_save_task_audit. No selection PUT was sent by this call. Duplicate video task ID on inventory page 2."')
    expect(adapter.requests[1]?.messages.filter(message => message.role === 'tool').map(message => message.content))
      .toEqual([result?.message.content])
    expect(pages).toEqual(['1', '2'])
    expect(transport.mock.calls.map(([, init]) => init?.method)).toEqual(['GET', 'GET', 'GET', 'GET', 'GET'])
    expect(await new JubianLedger({ root: ledgerRoot }).records()).toEqual([])
  } finally {
    await ctx.fiber.dispose()
  }
})

it.each([
  { label: 'prepares the authored multiline video prompt', brokenBinding: false },
  { label: 'reports malformed local project JSON', brokenBinding: true },
])('$label through the Loader without a paid request', async ({ brokenBinding }) => {
  const prompt = '@[Lead](lead)\n\n【镜头1】\n动作：先放下水桶，再说话。\n台词：Lead：慢一点。'
  const config = { modelId: 'doubao-seedance-2-0-260128', platformId: 'YU_DIAN', standardId: 11,
    genType: 3, modelGenerationTypeId: 7, videoStandardId: 91, duration: 8, genNum: 1,
    ratio: '9:16', resolution: '720p', prompt, materialList: [], backupModelList: [] }
  const url = 'https://jubian-aigc.tos-cn-beijing.volces.com/prod/lead.jpg'
  const material = { assetId: 'lead-id', materialAssetId: 81285, fileName: 'Lead', materialKey: 'lead',
    materialType: 'image', materialUrl: url, sortOrder: 1 }
  const methods: string[] = []
  const transport = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const address = new URL(input instanceof Request ? input.url : input.toString())
    methods.push(String(init?.method))
    const answer = (data: unknown) => new Response(JSON.stringify({ code: 200, data }), { status: 200 })
    if (init?.method !== 'GET') throw new Error('Preparation must not write remotely')
    if (address.pathname.endsWith('/aigc/storyboard/1')) return answer({ id: 1, scriptId: 2708,
      modelConfig: JSON.stringify(config), storyboardMaterialList: [material] })
    if (address.pathname.endsWith('/aigc/asset/81285')) return answer({ id: 81285, scriptId: 2708, assetUrl: url })
    if (address.pathname.endsWith('/aigc/material/list')) return answer({ total: 1, rows: [
      { id: 1, assetId: 81285, scriptId: 2708, hsAssetId: 'lead-id', assetUrl: url,
        hsAssetStatus: 'Active', isUsed: 1 },
    ] })
    if (address.pathname.endsWith('/model/charge/getSelectList')) return answer([
      { ...config, id: 11, genTypes: [{ id: 7, type: 3 }],
        videoStandards: [{ id: 91, ratio: '9:16', resolution: '720p', genNum: 1 }] },
    ])
    throw new Error(`Unexpected preparation request ${address.pathname}`)
  })
  onTestFinished(() => { transport.mockRestore() })
  const { ctx, home, ledgerRoot } = await mountedNativeTools()
  try {
    await writeFile(join(home, 'project_config.json'), brokenBinding
      ? '{private-project-config' : JSON.stringify({ jubian_script_id: 2708 }))
    const adapter = new MockAdapter([
      toolCallResponse('multiline-prepare', 'jubian_storyboard', { method: 'prepare_video', project_dir: home, storyboard_id: 1 }),
      textResponse(brokenBinding ? 'Check the local project configuration before preparing again.' : 'Prepared for review without submission.'),
    ])
    ctx.llm.registerAdapter(['mock'], adapter)
    const agent = await ctx.agentLoop.create(SessionId('multiline-prepare-owner'), { provider: 'mock', model: 'mock' }, { cwd: home })
    agent.followup(createUserMessage({ source: { kind: 'user' },
      content: [{ type: 'text', text: 'Prepare this card without generating video.' }] }))
    await agent.whenIdle()
    const results = agent.session.snapshotEvents().filter(event => event.type === 'tool/result')
    expect(results).toHaveLength(1)
    const result = results[0]?.data
    expect(result?.message.isError, JSON.stringify(result)).toBe(brokenBinding)
    const content = result?.message.content[0]
    if (content?.type !== 'text') throw new Error('Expected video preparation result')
    if (brokenBinding) {
      expect(result?.error).toEqual({ name: 'JubianProjectBindingError', code: 'PROJECT_BINDING_INVALID' })
      expect(content.text).toMatchInlineSnapshot('"Error: Muse 无法核对本地项目绑定: project_config.json 不是有效的 JSON。请核对原项目的配置文件。"')
      expect(await readdir(home)).not.toContain('video_tasks')
    } else {
      const prepared = JSON.parse(content.text) as { preview_path: string; payload: { modelConfig: string } }
      expect((JSON.parse(prepared.payload.modelConfig) as Record<string, unknown>).prompt).toBe(prompt)
      const saved = JSON.parse(await readFile(prepared.preview_path, 'utf8')) as typeof prepared
      expect((JSON.parse(saved.payload.modelConfig) as Record<string, unknown>).prompt).toBe(prompt)
    }
    expect(methods.length).toBeGreaterThan(0)
    expect(methods.every(method => method === 'GET')).toBe(true)
    expect(await new JubianLedger({ root: ledgerRoot }).records()).toEqual([])
  } finally {
    transport.mockRestore()
    await ctx.fiber.dispose()
  }
})

it.each(['scan-limit', 'episode-conflict'])('records %s on replay without another paid PUT', async (kind) => {
  const config = { modelId: 'doubao-seedance-2-0-260128', platformId: 'YU_DIAN', standardId: 11,
    genType: 3, modelGenerationTypeId: 7, videoStandardId: 91, duration: 8, genNum: 1,
    ratio: '9:16', resolution: '720p', prompt: '@[Lead](lead)', materialList: [], backupModelList: [] }
  const url = 'https://jubian-aigc.tos-cn-beijing.volces.com/prod/lead.jpg'
  const preview = buildNativeVideoPreview({ createdAt: '2026-10-11T00:00:00Z',
    storyboard: { id: 1, scriptId: 2708, episodeId: kind === 'scan-limit' ? null : 93828,
      episodeCount: 76, modelConfig: JSON.stringify(config), storyboardMaterialList: [
        { assetId: 'lead-id', materialAssetId: 81285, fileName: 'Lead', materialKey: 'lead',
          materialType: 'image', materialUrl: url, sortOrder: 1 },
      ] },
    assets: [{ id: 81285, scriptId: 2708, assetUrl: url, hsAssetId: 'lead-id', hsAssetStatus: 'Active',
      isUsed: 1, official: true, asset_status: 'confirmed' }],
    models: [{ ...config, id: 11, genTypes: [{ id: 7, type: 3 }],
      videoStandards: [{ id: 91, ratio: '9:16', resolution: '720p', genNum: 1 }] }] })
  const count = kind === 'scan-limit' ? 101 : 1
  const rows = Array.from({ length: count }, (_, index) => ({ id: 100000 + index, scriptId: 2708,
    taskType: 1, ...(kind === 'episode-conflict' ? { episodeId: 93828, episodeCount: 85 } : {}) }))
  const requests: string[] = []
  const transport = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const address = new URL(input instanceof Request ? input.url : input.toString())
    requests.push(`${init?.method} ${address.pathname}`)
    if (kind === 'episode-conflict' && address.pathname.endsWith('/admin/aigc/video/task/100000') && init?.method === 'GET') {
      return Response.json({ code: 200, data: { ...rows[0], storyboardId: 1 } })
    }
    if (kind === 'episode-conflict' && address.pathname.endsWith('/admin/aigc/video/task/sub/list') && init?.method === 'POST') {
      return Response.json({ code: 200, data: { total: 1, rows: [{ id: 100001, aigcVideoTaskId: 100000, storyboardId: 1 }] } })
    }
    if (init?.method !== 'GET' || !address.pathname.endsWith('/admin/aigc/video/task/list')) {
      throw new Error('Unexpected provider write')
    }
    const page = Number(address.searchParams.get('pageNum'))
    return new Response(JSON.stringify({ code: 200, data: { total: rows.length,
      rows: rows.slice((page - 1) * 100, page * 100) } }))
  })
  onTestFinished(() => { transport.mockRestore() })
  const { ctx, home, ledgerRoot } = await mountedNativeTools()
  const ledger = new JubianLedger({ root: ledgerRoot })
  try {
    await writeFile(join(home, 'project_config.json'), JSON.stringify({ jubian_script_id: 2708 }))
    await mkdir(join(home, 'video_tasks'))
    const previewPath = join(home, 'video_tasks', 'prepared.storyboard-native.prepared.json')
    await writeFile(previewPath, JSON.stringify(preview))
    await ledger.begin({ idempotencyKey: preview.idempotencyKey, method: 'storyboard_native_submit',
      scriptId: 2708, requestSha256: bodyHash(preview.payload), quotedAmount: '1.00', quoteUnit: 'CNY' })
    const originalRecords = await ledger.records()
    const adapter = new MockAdapter([
      toolCallResponse('reconcile-preview', 'jubian_storyboard', { method: 'submit_video',
        preview_path: previewPath, idempotency_key: preview.idempotencyKey }),
      textResponse('Preserve the original key and reconcile task ownership.'),
    ])
    ctx.llm.registerAdapter(['mock'], adapter)
    const agent = await ctx.agentLoop.create(SessionId(`native-${kind}-owner`),
      { provider: 'mock', model: 'mock' }, { cwd: home })
    agent.followup(createUserMessage({ source: { kind: 'user' },
      content: [{ type: 'text', text: 'Reconcile this recorded submission without sending it again.' }] }))
    await agent.whenIdle()
    expect(adapter.requests).toHaveLength(2)
    const results = agent.session.snapshotEvents().filter(event => event.type === 'tool/result')
      .map(event => ({ isError: event.data.message.isError, content: event.data.message.content }))
    expect(results).toHaveLength(1)
    expect(results[0]?.isError).toBe(true)
    expect(results).toMatchSnapshot(`native ${kind} refusal`)
    expect(JSON.stringify(results)).toContain('Jubian video task ownership could not be safely verified')
    expect(JSON.stringify(results)).not.toContain('expected envelope')
    expect(requests).toHaveLength(kind === 'scan-limit' ? 2 : 3)
    expect(requests.every(request => request.startsWith('GET ') || request.endsWith('/admin/aigc/video/task/sub/list'))).toBe(true)
    expect(await ledger.records()).toEqual(originalRecords)
  } finally {
    transport.mockRestore()
    await ctx.fiber.dispose()
  }
})

it.each([{ storyboardId: 916953, blocked: false }, { storyboardId: 916954, blocked: true }])(
  'records historical task ownership for card $storyboardId through the Loader', async ({ storyboardId, blocked }) => {
    const transport = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Provider fixture is not mounted yet'))
    onTestFinished(() => { transport.mockRestore() })
    const { ctx, home, ledgerRoot } = await mountedNativeTools({ baseUrl: 'https://episode-ownership.invalid/prod-api' })
    transport.mockImplementation(createEpisodeOwnershipTransport(home))
    try {
      await writeFile(join(home, 'project_config.json'), JSON.stringify({ jubian_script_id: 2708 }))
      await mkdir(join(home, 'video_tasks'))
      await mkdir(ledgerRoot, { recursive: true })
      await writeFile(join(ledgerRoot, 'authorization.json'), JSON.stringify({ version: 1,
        projects: { '2708': { limit: '0.5', unit: 'CNY' } } }))
      const preview = buildNativeVideoPreview(episodeOwnershipInputs(storyboardId))
      const previewPath = join(home, 'video_tasks', 'prepared.storyboard-native.prepared.json')
      const frozen = JSON.stringify(preview)
      await writeFile(previewPath, frozen)
      const args = { method: 'submit_video', preview_path: previewPath, idempotency_key: preview.idempotencyKey,
        estimated_cost_cny: '0.50', estimate_basis: 'Synthetic offline fixture; no real billed request' }
      const adapter = new MockAdapter([
        toolCallResponse('episode-submit', 'jubian_storyboard', args),
        ...blocked ? [] : [toolCallResponse('episode-replay', 'jubian_storyboard', args)],
        textResponse(blocked ? 'Preserve the original card and key; inspect task 100001.'
          : 'Submitted task 500000 once; reconciliation sent no second PUT.'),
      ])
      ctx.llm.registerAdapter(['mock'], adapter)
      const agent = await ctx.agentLoop.create(SessionId(`episode-ownership-${storyboardId}`),
        { provider: 'mock', model: 'mock' }, { cwd: home })
      agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text',
        text: 'Submit this approved offline card and preserve its original key when reconciling historical tasks.' }] }))
      await agent.whenIdle()
      const results = agent.session.snapshotEvents().filter(event => event.type === 'tool/result')
      expect(results).toHaveLength(blocked ? 1 : 2)
      expect(results.every(event => event.data.message.isError === blocked), JSON.stringify(results)).toBe(true)
      if (blocked) {
        expect(JSON.stringify(results)).toContain('task_id=100001; storyboard_id=916954; ownership=same_storyboard;')
      } else {
        for (const result of results) {
          const content = result.data.message.content[0]
          if (content?.type !== 'text') throw new Error('Expected native submission result')
          expect(JSON.parse(content.text)).toMatchObject({ status: 'submitted', task_id: '500000' })
        }
      }
      expect(JSON.parse(await readFile(join(home, 'submission-proof.json'), 'utf8'))).toEqual({
        paid_puts: { 916953: blocked ? 0 : 1, 916954: 0 }, historical_details_read: [blocked ? 100001 : 100000],
      })
      expect(await new JubianLedger({ root: ledgerRoot }).records()).toHaveLength(blocked ? 0 : 1)
      expect(await readFile(previewPath, 'utf8')).toBe(frozen)
    } finally {
      transport.mockRestore()
      await ctx.fiber.dispose()
    }
  },
)
