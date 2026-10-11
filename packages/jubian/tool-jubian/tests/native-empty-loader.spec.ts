/** Native preview failures report local diagnostics through the Loader and Agent session. */
import { mkdir, writeFile } from 'node:fs/promises'
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

async function mountedNativeTools() {
  const { ctx, home } = await configurationFixture({ hmr: false, rows: [
    { id: 'prompt', name: 'cordis:prompt' }, { id: 'tools', name: 'cordis:tools' },
    { id: 'credentials', name: 'cordis:credentials', config: { JUBIANAI_ADMIN_TOKEN: 'mock-token' } },
  ], builtins: { prompt: SystemPrompt, tools: Tools, credentials: MemoryCredentials, jubian: Jubian } })
  const ledgerRoot = join(home, 'ledger')
  await ctx.loader.create({ name: 'cordis:jubian', config: { ledgerRoot, workspaceSecrets: false } })
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
    if (init?.method !== 'GET' || !address.pathname.endsWith('/admin/aigc/video/task/list')) {
      throw new Error('Unexpected provider write or detail request')
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
    expect(requests).toHaveLength(kind === 'scan-limit' ? 2 : 1)
    expect(requests.every(request => request.startsWith('GET '))).toBe(true)
    expect(await ledger.records()).toEqual(originalRecords)
  } finally {
    transport.mockRestore()
    await ctx.fiber.dispose()
  }
})
