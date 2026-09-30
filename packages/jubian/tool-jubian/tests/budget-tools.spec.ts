import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as DramaSettings from '@deepseek-ai/dsh-drama-settings'
import { JubianLedger } from '@deepseek-ai/dsh-jubian'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import Tools from '@deepseek-ai/dsh-tools'
import { expect, it, vi } from 'vitest'
import { MemoryCredentials } from '../../../credentials/credentials/tests/memory.ts'
import { configurationFixture } from '../../../settings/settings/tests/configuration-fixture.ts'
import { DRAMA_SETTINGS_NAMESPACE } from '../src/budget-settings.ts'
import * as Jubian from '../src/index.ts'

it('applies the live drama budget before a paid image request without an authorization file', async () => {
  const root = await mkdtemp(join(tmpdir(), 'jubian-settings-budget-'))
  const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
    const path = url instanceof Request ? url.url : url.toString()
    if (!path.includes('/model/charge/getSelectList?taskType=2')) {
      throw new Error(`Unexpected provider request: ${path}`)
    }
    return new Response(JSON.stringify({ code: 200, data: [{ id: 42, standardId: 42, modelId: 'gpt-image-2',
      platformId: 'YU_DIAN', unitPrice: 0.5, unit: '张', genTypes: [{ id: 7, type: 3 }],
      videoStandards: [{ id: 91, ratio: '16:9', resolution: '1K', width: 1280, height: 720, genNum: 1 }] }] }),
    { status: 200 })
  })
  try {
    const { ctx } = await configurationFixture({ rows: [
      { id: 'config-editor', name: 'cordis:editor' }, { id: 'settings', name: 'cordis:settings' },
      { id: 'prompt', name: 'cordis:prompt' }, { id: 'tools', name: 'cordis:tools' },
      { id: 'credentials', name: 'cordis:credentials', config: { JUBIANAI_ADMIN_TOKEN: 'token' } },
      { id: 'drama-settings', name: 'cordis:drama' },
      { id: 'jubian', name: 'cordis:jubian', config: { ledgerRoot: root, workspaceSecrets: false,
        baseUrl: 'https://jubian.example.test' } },
    ], builtins: { prompt: SystemPrompt, tools: Tools, credentials: MemoryCredentials, drama: DramaSettings, jubian: Jubian } })
    await ctx.settings.update(DRAMA_SETTINGS_NAMESPACE, { seriesBudgetCents: 0 })
    const result = await ctx.tools.execute({ callId: ToolCallId('budget-zero'), name: 'jubian_video',
      arguments: { method: 'image_generate', script_id: 2708, asset_name: 'x', asset_type: 1,
        prompt: 'p', idempotency_key: 'new-paid-image' }, signal: new AbortController().signal })
    expect(result.isError).toBe(true)
    if (result.isError) expect(result.error.message).toContain('授权上限 0.00 CNY')
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(await new JubianLedger({ root }).records()).toEqual([])
  } finally {
    fetch.mockRestore()
    await rm(root, { recursive: true, force: true })
  }
})
