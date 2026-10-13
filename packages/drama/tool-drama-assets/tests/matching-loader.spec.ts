/** Matching through a real profile/Loader composition, with only credentials and HTTP mocked. */
import { rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { encodeVoiceSlot } from '@deepseek-ai/dsh-jubian-api'
import { expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import Tools, { validateJsonSchemaValue } from '@deepseek-ai/dsh-tools'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { MemoryCredentials } from '../../../credentials/credentials/tests/memory.ts'
import { configurationFixture } from '../../../settings/settings/tests/configuration-fixture.ts'
import * as Assets from '../src/index.ts'
import { matchingProject, provider, tree } from './matching-fixture.ts'

it('discovers and executes match_preview under Loader without modifying any project file', async () => {
  const root = await matchingProject(), before = await tree(root), mock = provider()
  const transport = vi.spyOn(globalThis, 'fetch').mockImplementation(mock.fetch)
  let ctx: Context | undefined
  try {
    const loaded = await configurationFixture({ hmr: false, rows: [
      { id: 'prompt', name: 'cordis:prompt' }, { id: 'tools', name: 'cordis:tools' },
      { id: 'credentials', name: 'cordis:credentials', config: { JUBIANAI_ADMIN_TOKEN: 'offline-test-token' } },
      { id: 'assets', name: 'cordis:assets', config: { workspaceSecrets: false, matchPageSize: 1 } },
    ], builtins: { prompt: SystemPrompt, tools: Tools, credentials: MemoryCredentials, assets: Assets } })
    ctx = loaded.ctx
    const definition = ctx.tools.get('drama_assets')!
    expect(definition).toBeDefined()
    const args = { method: 'match_preview', project_dir: root, requirements_path: 'requirements.json' }
    expect(validateJsonSchemaValue(definition.parameters, args, '')).toEqual([])
    const result = await ctx.tools.execute({ callId: ToolCallId('match-preview-loader'), name: 'drama_assets',
      arguments: args, signal: new AbortController().signal })
    expect(result.isError, JSON.stringify(result.content)).not.toBe(true)
    expect(validateJsonSchemaValue(definition.output.schema, result.value, '')).toEqual([])
    expect(result.value).toMatchObject({ method: 'match_preview', status: 'reuse_ready',
      counts: { reuse_ready: 3 }, paid_requests: 0, local_writes: 0, remote_writes: 0 })
    expect(mock.calls).toHaveLength(8)
    expect(mock.calls.every(call => call.method === 'GET')).toBe(true)
    expect(await tree(root)).toEqual(before)
    const tools = ctx.tools
    await ctx.fiber.dispose()
    expect(tools.get('drama_assets')).toBeUndefined()
  } finally {
    await ctx?.fiber.dispose()
    transport.mockRestore()
    await rm(root, { recursive: true, force: true })
  }
})

it('rejects invalid matching deployment limits before registering tools', async () => {
  const loaded = await configurationFixture({ hmr: false, rows: [
    { id: 'prompt', name: 'cordis:prompt' }, { id: 'tools', name: 'cordis:tools' },
    { id: 'credentials', name: 'cordis:credentials', config: {} },
  ], builtins: { prompt: SystemPrompt, tools: Tools, credentials: MemoryCredentials } })
  try {
    expect(() => { Assets.apply(loaded.ctx, { matchPageSize: 1001 }) }).toThrow('Matching limits')
    expect(() => { Assets.apply(loaded.ctx, { matchPageLimit: 0 }) }).toThrow('Matching limits')
    expect(loaded.ctx.tools.get('drama_assets')).toBeUndefined()
  } finally { await loaded.ctx.fiber.dispose() }
})

it('queries local voice gaps and asset uses through Loader without provider credentials or writes', async () => {
  const root = await matchingProject(), before = await tree(root)
  const loaded = await configurationFixture({ hmr: false, rows: [
    { id: 'prompt', name: 'cordis:prompt' }, { id: 'tools', name: 'cordis:tools' },
    { id: 'credentials', name: 'cordis:credentials', config: {} },
    { id: 'assets', name: 'cordis:assets', config: { workspaceSecrets: false } },
  ], builtins: { prompt: SystemPrompt, tools: Tools, credentials: MemoryCredentials, assets: Assets } })
  try {
    const definition = loaded.ctx.tools.get('drama_assets')!
    const result = await loaded.ctx.tools.execute({ callId: ToolCallId('usage-loader'), name: 'drama_assets',
      arguments: { method: 'usage_preview', project_dir: root }, signal: new AbortController().signal })
    expect(result.isError, JSON.stringify(result.content)).not.toBe(true)
    expect(validateJsonSchemaValue(definition.output.schema, result.value, '')).toEqual([])
    expect(result.value).toMatchObject({ method: 'usage_preview', total: 1, paid_requests: 0, remote_writes: 0, local_writes: 0 })
    expect(await tree(root)).toEqual(before)
    const tools = loaded.ctx.tools
    await loaded.ctx.fiber.dispose()
    expect(tools.get('drama_assets')).toBeUndefined()
  } finally { await loaded.ctx.fiber.dispose(); await rm(root, { recursive: true, force: true }) }
})

it('projects shared current package uses through the registered JSON tool without mutations', async () => {
  const root = await matchingProject()
  await writeFile(join(root, 'project_config.json'), JSON.stringify({ jubian_script_id: 2708 }))
  const before = await tree(root)
  const records: Record<string, Record<string, unknown>[]> = {
    asset: [13, 14].map(id => ({ id, scriptId: 2708, assetType: 4, delFlag: '0',
      assetName: `Voice ${id} ${encodeVoiceSlot(2708, 'lu', 'adult')}`, assetUrl: `https://example.invalid/${id}.wav` })),
    material: [], episode: [{ id: 51, scriptId: 2708, episodeCount: 54 }],
    storyboard: [{ id: 91, scriptId: 2708, episodeId: 51,
      storyboardMaterialList: [{ materialType: 'audio', materialUrl: 'https://example.invalid/13.wav' }] }],
  }
  const requests: string[] = []
  const transport = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const target = new URL(input instanceof Request ? input.url : input.toString())
    if (init?.method !== 'GET') throw new Error('Read-only fixture rejects writes')
    requests.push(target.pathname)
    const rows = records[target.pathname.split('/').at(-2) ?? '']
    if (!rows) throw new Error('Unexpected inventory')
    return new Response(JSON.stringify({ code: 200, data: { rows, total: rows.length } }))
  })
  let ctx: Context | undefined
  try {
    const loaded = await configurationFixture({ hmr: false, rows: [
      { id: 'prompt', name: 'cordis:prompt' }, { id: 'tools', name: 'cordis:tools' },
      { id: 'credentials', name: 'cordis:credentials', config: { JUBIANAI_ADMIN_TOKEN: 'offline-test-token' } },
      { id: 'assets', name: 'cordis:assets', config: { workspaceSecrets: false, matchRequirementLimit: 1 } },
    ], builtins: { prompt: SystemPrompt, tools: Tools, credentials: MemoryCredentials, assets: Assets } })
    ctx = loaded.ctx
    const definition = ctx.tools.get('drama_assets')!
    const result = await ctx.tools.execute({ callId: ToolCallId('shared-usage-loader'), name: 'drama_assets',
      arguments: { method: 'shared_usage_preview', project_dir: root, character_id: 'lu' }, signal: new AbortController().signal })
    expect(result.isError, JSON.stringify(result.content)).toBe(false)
    expect(validateJsonSchemaValue(definition.output.schema, result.value, '')).toEqual([])
    expect(result.value).toMatchObject({ method: 'shared_usage_preview', complete: true, query_complete: false, totals: { assets: 2, uses: 1 },
      assets: [{ asset_id: 13, package_count: 1 }],
      pagination: { output_offset: 0, output_limit: 1, next_offset: 1 },
      duplicate_audio_groups: [{ preferred_asset_id: 13, delete_allowed: false }],
      uses: [{ storyboard_id: 91, episode_number: 54 }] })
    const paged = await ctx.tools.execute({ callId: ToolCallId('shared-usage-next-page'), name: 'drama_assets',
      arguments: { method: 'shared_usage_preview', project_dir: root, character_id: 'lu', output_offset: 1 }, signal: new AbortController().signal })
    expect(paged.isError, JSON.stringify(paged.content)).toBe(false)
    expect(validateJsonSchemaValue(definition.output.schema, paged.value, '')).toEqual([])
    expect(paged.value).toMatchObject({ complete: true, query_complete: false, totals: { assets: 2, uses: 1 },
      pagination: { output_offset: 1, output_limit: 1, next_offset: null },
      assets: [{ asset_id: 14, package_count: 0 }], uses: [] })
    expect(JSON.stringify(paged.value)).toMatch(/"query_sha256":"[a-f0-9]{64}"/)
    const filtered = await ctx.tools.execute({ callId: ToolCallId('shared-usage-by-asset'), name: 'drama_assets',
      arguments: { method: 'shared_usage_preview', project_dir: root, asset_id: 14 }, signal: new AbortController().signal })
    expect(filtered.isError, JSON.stringify(filtered.content)).toBe(false)
    expect(filtered.value).toMatchObject({ assets: [{ asset_id: 14, package_count: 0 }], uses: [] })
    expect(requests).toHaveLength(24)
    expect(await tree(root)).toEqual(before)
  } finally {
    await ctx?.fiber.dispose()
    transport.mockRestore()
    await rm(root, { recursive: true, force: true })
  }
})
