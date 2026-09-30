/** Uploaded audio preparation and validation through the registered Loader tools. */
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import Tools, { validateJsonSchemaValue } from '@deepseek-ai/dsh-tools'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { MemoryCredentials } from '../../../credentials/credentials/tests/memory.ts'
import { configurationFixture } from '../../../settings/settings/tests/configuration-fixture.ts'
import * as Jubian from '../src/index.ts'

it('prepares the original mixed-audio card and rejects invalid audio before any upload', async () => {
  const root = await mkdtemp(join(tmpdir(), 'jubian-audio-loader-'))
  let ctx: Context | undefined
  const image = { assetId: 'character-zhou', materialAssetId: 142,
    materialType: 'image', materialUrl: 'https://jubian-aigc.tos-cn-beijing.volces.com/prod/zhou.jpg',
    fileName: '周海生', materialKey: 'zhou', sortOrder: 1 }
  const audio = { materialType: 'audio', materialUrl: 'https://jubian-aigc.tos-cn-beijing.volces.com/prod/zhou.wav',
    fileName: '周海生声音', materialKey: 'zhou-voice', sortOrder: 1 }
  const model = { platformId: 'YU_DIAN', modelId: 'doubao-seedance-2-5-260628', standardId: 11,
    genType: 3, modelGenerationTypeId: 7, videoStandardId: 91, duration: 29,
    ratio: '9:16', resolution: '480p', genNum: 1,
    prompt: '@[周海生](zhou)走到门口，声音参照@[周海生声音](zhou-voice)', materialList: [image, audio] }
  const calls: string[] = []
  const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
    const target = new URL(url instanceof Request ? url.url : url.toString())
    calls.push(`${init?.method} ${target.pathname}`)
    let data: unknown
    if (target.pathname === '/prod-api/aigc/storyboard/1745324') data = {
      id: 1745324, scriptId: 2708, episodeId: 13, isGenerate: 0,
      modelConfig: JSON.stringify(model), storyboardMaterialList: [image, audio],
    }
    else if (target.pathname === '/prod-api/aigc/asset/142') data = {
      id: 142, scriptId: 2708, assetUrl: image.materialUrl,
    }
    else if (target.pathname === '/prod-api/aigc/material/list') data = { total: 1, rows: [{
      id: 12, assetId: 142, scriptId: 2708, assetName: '周海生', hsAssetId: 'character-zhou',
      assetUrl: image.materialUrl, hsAssetStatus: 'Active', isUsed: 1,
    }] }
    else if (target.pathname === '/prod-api/model/charge/getSelectList') data = [{
      id: 11, modelId: model.modelId, platformId: model.platformId, genTypes: [{ id: 7, type: 3 }],
      videoStandards: [{ id: 91, ratio: model.ratio, resolution: model.resolution, genNum: 1 }],
    }]
    else throw new Error(`Unexpected audio fixture request ${target.pathname}`)
    return new Response(JSON.stringify({ code: 200, data }))
  })
  try {
    await writeFile(join(root, 'project_config.json'), JSON.stringify({ jubian_script_id: 2708 }))
    await writeFile(join(root, 'invalid.wav'), 'not audio')
    const configured = await configurationFixture({ hmr: false, rows: [
      { id: 'prompt', name: 'cordis:prompt' }, { id: 'tools', name: 'cordis:tools' },
      { id: 'credentials', name: 'cordis:credentials', config: { JUBIANAI_ADMIN_TOKEN: 'mocked-token' } },
      { id: 'jubian', name: 'cordis:jubian', config: { ledgerRoot: join(root, 'ledger'), workspaceSecrets: false } },
    ], builtins: { prompt: SystemPrompt, tools: Tools, credentials: MemoryCredentials, jubian: Jubian } })
    ctx = configured.ctx
    const asset = ctx.tools.get('jubian_asset')
    if (!asset) throw new Error('Missing jubian_asset')
    const uploadArgs = { method: 'upload_audio', audio_path: join(root, 'invalid.wav') }
    expect(validateJsonSchemaValue(asset.parameters, uploadArgs, '')).toEqual([])
    const invalid = await ctx.tools.execute({ callId: ToolCallId('invalid-audio'), name: 'jubian_asset',
      arguments: uploadArgs, signal: new AbortController().signal })
    expect(invalid.isError).toBe(true)
    expect(invalid.content).toMatchSnapshot('invalid PCM audio diagnostic')
    expect(calls).toEqual([])
    const prepared = await ctx.tools.execute({ callId: ToolCallId('mixed-audio'), name: 'jubian_storyboard',
      arguments: { method: 'prepare_video', storyboard_id: 1745324, project_dir: root },
      signal: new AbortController().signal })
    if (prepared.isError) throw new Error(JSON.stringify(prepared.content))
    expect(prepared.value).toMatchObject({ status: 'prepared', storyboardId: 1745324,
      audio_references: [{ material_key: 'zhou-voice', material_url: audio.materialUrl,
        duration_seconds: null, duration_basis: 'unavailable', duration_verified: false }] })
    expect(calls).toEqual(['GET /prod-api/aigc/storyboard/1745324', 'GET /prod-api/aigc/asset/142',
      'GET /prod-api/aigc/material/list', 'GET /prod-api/model/charge/getSelectList'])
  } finally {
    fetch.mockRestore()
    await ctx?.fiber.dispose()
    await rm(root, { recursive: true, force: true })
  }
})
