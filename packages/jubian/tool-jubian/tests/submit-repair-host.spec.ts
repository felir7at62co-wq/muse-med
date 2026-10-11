/** Exercise the registered tools in an isolated Host with only in-memory provider responses. */
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { JubianLedger } from '@deepseek-ai/dsh-jubian'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import Tools from '@deepseek-ai/dsh-tools'
import { MemoryCredentials } from '../../../credentials/credentials/tests/memory.ts'
import { configurationFixture } from '../../../settings/settings/tests/configuration-fixture.ts'
import * as Jubian from '../src/index.ts'

it('keeps an accepted image pending and resolves only verified numeric video parents through the Host', async () => {
  const { ctx, home } = await configurationFixture({ hmr: false, rows: [
    { id: 'prompt', name: 'cordis:prompt' }, { id: 'tools', name: 'cordis:tools' },
    { id: 'credentials', name: 'cordis:credentials', config: { JUBIANAI_ADMIN_TOKEN: 'mock-token' } },
  ], builtins: { prompt: SystemPrompt, tools: Tools, credentials: MemoryCredentials, jubian: Jubian } })
  const ledgerRoot = join(home, 'ledger')
  await mkdir(ledgerRoot)
  await writeFile(join(ledgerRoot, 'authorization.json'), JSON.stringify({ version: 1, projects: {
    '2708': { limit: '100', unit: 'CNY', estimates: { image_generate: '1' } },
  } }))
  await writeFile(join(home, 'project_config.json'), JSON.stringify({ jubian_script_id: 2708 }))
  const imageUrl = 'https://example.test/lead.png'
  const modelConfig = { platformId: 'YU_DIAN', modelId: 'doubao-seedance-2-0-260128', standardId: 11,
    genType: 3, modelGenerationTypeId: 7, videoStandardId: 91, duration: 8, ratio: '9:16', resolution: '720p',
    genNum: 1, prompt: 'A quiet street @[Lead](lead)', materialList: [], backupModelList: [] }
  const board = { id: 1, scriptId: 2708, isGenerate: 1, modelConfig: JSON.stringify(modelConfig),
    storyboardMaterialList: [{ assetId: 'asset-lead', materialAssetId: null, fileName: 'Lead',
      materialKey: 'lead', materialType: 'image', materialUrl: imageUrl, sortOrder: 1 }] }
  let subjectRows: Record<string, unknown>[] = [{ id: 1, assetId: 81285, scriptId: 2708,
    hsAssetId: 'asset-lead', assetUrl: imageUrl, hsAssetStatus: 'Active', isUsed: 1 }]
  const calls: { method: string; path: string }[] = []
  const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
    const address = typeof url === 'string' ? url : url instanceof URL ? url.href : url.url
    const requestUrl = new URL(address)
    const path = requestUrl.pathname + requestUrl.search
    const method = String(init?.method)
    calls.push({ method, path })
    let data: unknown
    if (path.includes('getSelectList?taskType=2')) data = [{ id: 66, modelId: 'gpt-image-2', platformId: 'KU_AI',
      unitPrice: 0.12, unit: '张', genTypes: [{ id: 7, type: 3 }],
      videoStandards: [{ id: 93, ratio: '16:9', resolution: '1K', width: 1280, height: 720, genNum: 1 }] }]
    else if (method === 'POST' && path.endsWith('/aigc/asset')) data = 83749
    else if (path.endsWith('/aigc/asset/83749')) data = { id: 83749, hsAssetStatus: 'Pending' }
    else if (path.endsWith('/aigc/storyboard/1')) data = board
    else if (path.includes('/aigc/material/list?')) data = { total: subjectRows.length, rows: subjectRows }
    else if (path.endsWith('/aigc/asset/81285')) data = { id: 81285, scriptId: 2708, assetUrl: imageUrl }
    else if (path.includes('getSelectList?taskType=1')) data = [{ id: 11,
      modelId: 'doubao-seedance-2-0-260128', platformId: 'YU_DIAN', duration: 8, genNum: 1,
      genTypes: [{ id: 7, type: 3 }], videoStandards: [{ id: 91, ratio: '9:16', resolution: '720p', genNum: 1 }] }]
    else throw new Error(`Unexpected mocked route: ${method} ${path}`)
    return new Response(JSON.stringify({ code: 200, data }), { status: 200 })
  })
  try {
    await ctx.loader.create({ name: 'cordis:jubian', config: { ledgerRoot, workspaceSecrets: false,
      imageActiveTimeoutMs: 10, imageActivePollMs: 100 } })
    await ctx.loader.await()
    for (const entry of ctx.loader.entries()) await entry.fiber?.await()
    await ctx.credentials.set(credentialRef('JUBIANAI_ADMIN_TOKEN'), 'mock-token')
    const signal = new AbortController().signal
    const image = await ctx.tools.execute({ callId: ToolCallId('repair-image'), name: 'jubian_video',
      arguments: { method: 'image_generate', script_id: 2708, asset_name: 'Lead', asset_type: 1,
        prompt: 'A portrait', idempotency_key: 'host-image-original' }, signal })
    expect(image.isError, JSON.stringify(image.content)).toBe(false)
    const imageText = image.content.find(block => block.type === 'text')
    if (imageText?.type !== 'text') throw new Error('Expected image tool text')
    expect(JSON.parse(imageText.text)).toMatchObject({ outcome: 'accepted', asset_status: 'timeout',
      generation_status: 'submitted_pending', idempotency_key: 'host-image-original', parent_asset_id: 83749 })
    expect(calls.filter(call => call.method === 'POST' && call.path.endsWith('/aigc/asset'))).toHaveLength(1)
    expect((await new JubianLedger({ root: ledgerRoot }).find('host-image-original'))?.outcome).toBe('accepted')
    const prepared = await ctx.tools.execute({ callId: ToolCallId('repair-video-ready'), name: 'jubian_storyboard',
      arguments: { method: 'prepare_video', storyboard_id: 1, project_dir: home }, signal })
    expect(prepared.isError, JSON.stringify(prepared.content)).toBe(false)
    const previewText = prepared.content.find(block => block.type === 'text')
    if (previewText?.type !== 'text') throw new Error('Expected preview tool text')
    expect(JSON.parse(previewText.text)).toMatchObject({ status: 'prepared', assetSummary: {
      orderedAssets: [{ assetId: 'asset-lead', materialAssetId: 81285 }],
    } })
    subjectRows = []
    const blocked = await ctx.tools.execute({ callId: ToolCallId('repair-video-blocked'), name: 'jubian_storyboard',
      arguments: { method: 'prepare_video', storyboard_id: 1, project_dir: home }, signal })
    expect(blocked.isError).toBe(true)
    expect(JSON.stringify(blocked.content)).toContain('stage=subject_identity')
    expect(calls.some(call => call.path.includes('/aigc/asset/asset-'))).toBe(false)
    expect(calls.some(call => call.method === 'PUT')).toBe(false)
  } finally {
    fetch.mockRestore()
    await ctx.fiber.dispose()
  }
})
