/**
 * The automatic ceiling in the real tool composition.
 *
 * The stack is booted from a real profile patch: the settings service, the drama
 * row that publishes the section, the credentials row and the Jubian tool row.
 * That composition is the point — the ceiling is read through the settings
 * service's own describe pass, so a drama row that publishes no namespace takes
 * the cap away without an error anywhere, and the paid call below is what shows
 * whether the composition still carries it.
 */
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
import { seriesBudgetLimit } from '../src/budget-settings.ts'
import { pinnedImageSelection } from '../src/image.ts'
import * as Jubian from '../src/index.ts'

it('mounts the drama default and enforces its current limit in the real tool composition', async () => {
  const root = await mkdtemp(join(tmpdir(), 'jubian-budget-loader-'))
  const ledgerRoot = join(root, 'ledger')
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
    const { ctx } = await configurationFixture({
      rows: [
        { id: 'config-editor', name: 'cordis:editor' },
        { id: 'settings', name: 'cordis:settings' },
        { id: 'system-prompt', name: 'cordis:prompt' },
        { id: 'tools', name: 'cordis:tools' },
        { id: 'credentials', name: 'cordis:credentials', config: { JUBIANAI_ADMIN_TOKEN: 'mocked-token' } },
        { id: 'drama-settings', name: 'cordis:drama' },
        { id: 'tool-jubian', name: 'cordis:jubian', config: { ledgerRoot, workspaceSecrets: false } },
      ],
      builtins: {
        prompt: SystemPrompt, tools: Tools, credentials: MemoryCredentials,
        drama: DramaSettings, jubian: Jubian,
      },
    })
    // The row is composed under the id every reader addresses, so its section is
    // both served to the Settings page and readable as the automatic ceiling.
    expect(ctx.settings.describe().map(row => row.ns)).toContain('drama-settings')
    expect(seriesBudgetLimit(ctx)).toBe(400_000)

    await ctx.settings.update('drama-settings', { seriesBudgetCents: 0 })
    expect(seriesBudgetLimit(ctx)).toBe(0)
    const tool = ctx.tools.get('jubian_video')
    expect(tool).toBeDefined()
    if (!tool) throw new Error('Missing Jubian video tool')
    const args = { method: 'image_generate', script_id: 2708, asset_name: 'x', asset_type: 1,
      prompt: 'p', idempotency_key: 'new-paid-image' }
    const result = await ctx.tools.execute({
      callId: ToolCallId('budget-loader'), name: 'jubian_video', arguments: args,
      signal: new AbortController().signal,
    })
    expect(result).toMatchObject({ isError: true, error: { message: expect.stringContaining('授权上限 0.00 CNY') } })
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(await new JubianLedger({ root: ledgerRoot }).records()).toEqual([])

    // The row the Settings page pinned is read per paid call, and it beats this
    // row's own composition config rather than merging with it.
    expect(pinnedImageSelection(ctx, { imageStandardId: 66 })).toEqual({ standardId: 66 })
    await ctx.settings.update('drama-settings', { imageStandardId: 76 })
    expect(pinnedImageSelection(ctx, { imageStandardId: 66 })).toEqual({ standardId: 76 })

    const toolRow = [...ctx.loader.entries()].find(row => row.options.name === 'cordis:jubian')
    await toolRow?.fiber?.dispose()
    expect(ctx.tools.get('jubian_video')).toBeUndefined()
  } finally {
    fetch.mockRestore()
    await rm(root, { recursive: true, force: true })
  }
})
