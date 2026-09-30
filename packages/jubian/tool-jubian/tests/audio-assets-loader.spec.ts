/** Registered tools preserve the original card through audio registration, binding and removal. */
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

it('registers, binds, detaches and deletes audio through the original card and inspected tools', async () => {
  const root = await mkdtemp(join(tmpdir(), 'jubian-audio-chain-'))
  let ctx: Context | undefined
  const url = 'https://jubian-aigc.tos-cn-beijing.volces.com/prod/zhou.wav'
  const image = { materialType: 'image', materialKey: 'zhou', materialUrl: url.replace('.wav', '.jpg'),
    materialAssetId: 142, assetId: 'zhou-hs', fileName: '周海生', sortOrder: 1 }
  let asset: Record<string, unknown> | null = null
  let board: Record<string, unknown> = { id: 1745324, scriptId: 2708, episodeId: 13,
    storyboardName: 'EP13-P1', isGenerate: 0, storyboardMaterialList: [image],
    modelConfig: JSON.stringify({ modelId: 'doubao-seedance-2-5-260628', platformId: 'YU_DIAN',
      duration: 8, ratio: '9:16', resolution: '480p', prompt: '@[周海生](zhou)走到门口', materialList: [image] }) }
  const calls: { method: string; path: string; body: Record<string, unknown> | null }[] = []
  const transport = vi.spyOn(globalThis, 'fetch').mockImplementation(async (target, init) => {
    const path = new URL(target instanceof Request ? target.url : target.toString()).pathname.replace('/prod-api', '')
    const method = String(init?.method)
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) as Record<string, unknown> : null
    calls.push({ method, path, body })
    const answer = (data: unknown) => new Response(JSON.stringify({ code: 200, data }))
    if (method === 'GET' && path === '/aigc/asset/list') return answer({ total: asset ? 1 : 0, rows: asset ? [asset] : [] })
    if (method === 'GET' && path === '/aigc/asset/7') return answer(asset)
    if (method === 'GET' && path === '/aigc/material/selectNoPage') return answer([])
    if (method === 'POST' && path === '/aigc/asset') {
      asset = { id: 7, ...body, assetUrl: body?.url }
      return answer({ id: 7 })
    }
    if (method === 'GET' && path === '/aigc/storyboard/1745324') return answer(board)
    if (method === 'GET' && path === '/aigc/storyboard/list') return answer({ total: 1, rows: [board] })
    if (method === 'PUT' && path === '/aigc/storyboard' && body) { board = body; return answer(null) }
    if (method === 'DELETE' && path === '/aigc/asset/removeAsset/7') { asset = null; return answer(null) }
    throw new Error(`Unexpected request ${method} ${path}`)
  })
  try {
    await writeFile(join(root, 'project_config.json'), JSON.stringify({ jubian_script_id: 2708 }))
    const configured = await configurationFixture({ hmr: false, rows: [
      { id: 'prompt', name: 'cordis:prompt' }, { id: 'tools', name: 'cordis:tools' },
      { id: 'credentials', name: 'cordis:credentials', config: { JUBIANAI_ADMIN_TOKEN: 'mocked-token' } },
      { id: 'jubian', name: 'cordis:jubian', config: { ledgerRoot: join(root, 'ledger'), workspaceSecrets: false } },
    ], builtins: { prompt: SystemPrompt, tools: Tools, credentials: MemoryCredentials, jubian: Jubian } })
    ctx = configured.ctx
    const boundContext = ctx
    const invoke = async (name: string, args: Record<string, unknown>) => {
      const tool = boundContext.tools.get(name)
      if (!tool) throw new Error(`Missing ${name}`)
      expect(validateJsonSchemaValue(tool.parameters, args, '')).toEqual([])
      const result = await boundContext.tools.execute({ callId: ToolCallId(`audio-chain-${calls.length}`), name,
        arguments: args, signal: new AbortController().signal })
      return result
    }
    const registered = await invoke('jubian_asset', { method: 'register', script_id: 2708,
      asset_name: '周海生声线 v1', asset_type: 4, asset_url: url, idempotency_key: 'register-voice' })
    expect(registered.isError).not.toBe(true)
    expect(registered.value).toMatchObject({ created_asset_id: 7 })
    const voice = { materialType: 'audio', materialKey: 'zhou-voice', materialUrl: url,
      fileName: '周海生声线', sortOrder: 1, audioDuration: 2, audio_asset_id: 7 }
    const edit = await invoke('jubian_storyboard', { method: 'audio_preview', script_id: 2708, project_dir: root,
      storyboard_id: 1745324, prompt: '@[周海生](zhou)走到门口，声音参照@[周海生声线](zhou-voice)', audio_references: [voice] })
    expect(edit.isError).not.toBe(true)
    const plan = edit.value as Record<string, unknown>
    const edited = await invoke('jubian_storyboard', { method: 'audio_apply', script_id: 2708, project_dir: root,
      storyboard_id: 1745324,
      preview_path: plan.preview_path, expected_fingerprint: plan.fingerprint, idempotency_key: plan.fingerprint })
    expect(edited.isError, JSON.stringify(edited.content)).not.toBe(true)
    expect(board).toMatchObject({ id: 1745324, episodeId: 13, isGenerate: 0, storyboardMaterialList: [image, {
      materialType: 'audio', materialKey: 'zhou-voice', materialUrl: url, audioDuration: 2,
    }] })
    expect(JSON.parse(String(board.modelConfig))).toMatchObject({ duration: 8, modelId: 'doubao-seedance-2-5-260628' })
    const blocked = await invoke('jubian_asset', { method: 'audio_delete_apply', script_id: 2708, project_dir: root, asset_id: 7 })
    expect(blocked.isError).toBe(true)
    expect(blocked.content).toMatchSnapshot('unreviewed audio deletion')
    const referenceCheck = await invoke('jubian_asset', { method: 'audio_delete_preview', script_id: 2708,
      project_dir: root, asset_id: 7, delete_reason: '移除旧声音', authorization_basis: '用户要求删除资产7' })
    expect(referenceCheck.value).toMatchObject({ references: { storyboards: [{ storyboard_id: 1745324 }] } })
    const cleared = await invoke('jubian_storyboard', { method: 'audio_preview', script_id: 2708, project_dir: root,
      storyboard_id: 1745324, prompt: '@[周海生](zhou)走到门口', audio_references: [] })
    const clearPlan = cleared.value as Record<string, unknown>
    expect((await invoke('jubian_storyboard', { method: 'audio_apply', script_id: 2708, project_dir: root,
      storyboard_id: 1745324,
      preview_path: clearPlan.preview_path, expected_fingerprint: clearPlan.fingerprint,
      idempotency_key: clearPlan.fingerprint })).isError).not.toBe(true)
    const removal = await invoke('jubian_asset', { method: 'audio_delete_preview', script_id: 2708, project_dir: root,
      asset_id: 7, delete_reason: '移除未使用旧声音', authorization_basis: '用户要求删除资产7' })
    const removalPlan = removal.value as Record<string, unknown>
    expect((await invoke('jubian_asset', { method: 'audio_delete_apply', script_id: 2708, project_dir: root,
      asset_id: 7, checked_audio_asset_id: 7, preview_path: removalPlan.preview_path, idempotency_key: removalPlan.fingerprint })).value)
      .toMatchObject({ status: 'deleted', verified_readback: true })
    expect(calls.filter(call => call.method === 'POST').map(call => call.path)).toEqual(['/aigc/asset'])
    expect(calls.filter(call => call.method === 'PUT')).toHaveLength(2)
    expect(calls.filter(call => call.method === 'PUT').every(call => call.body?.isGenerate === 0 && call.body.id === 1745324)).toBe(true)
  } finally {
    transport.mockRestore()
    await ctx?.fiber.dispose()
    await rm(root, { recursive: true, force: true })
  }
})
