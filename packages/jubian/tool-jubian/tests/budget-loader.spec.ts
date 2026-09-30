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
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as DramaSettings from '@deepseek-ai/dsh-drama-settings'
import { JubianLedger } from '@deepseek-ai/dsh-jubian'
import Llm, { ToolCallId, createUserMessage } from '@deepseek-ai/dsh-llm'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SessionProjections from '@deepseek-ai/dsh-session-projection'
import { checkBudget } from '@deepseek-ai/dsh-jubian'
import { MockAdapter, textResponse, toolCallResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
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
    expect(result.isError).toBe(true)
    if (result.isError) expect(result.error.message).toContain('授权上限 0.00 CNY')
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

it('logs the approved project budget update and reads the same live amount in the project bible', async () => {
  const { ctx, home } = await configurationFixture({ hmr: false, rows: [
    { id: 'config-editor', name: 'cordis:editor' }, { id: 'settings', name: 'cordis:settings' },
    { id: 'prompt', name: 'cordis:prompt' }, { id: 'tools', name: 'cordis:tools' },
    { id: 'credentials', name: 'cordis:credentials', config: { JUBIANAI_ADMIN_TOKEN: 'test-token' } },
    { id: 'drama-settings', name: 'cordis:drama' },
  ], builtins: { prompt: SystemPrompt, tools: Tools, credentials: MemoryCredentials, drama: DramaSettings } })
  const ledgerRoot = join(home, 'ledger')
  await writeFile(join(home, 'project_config.json'), JSON.stringify({ jubian_script_id: 2708 }))
  const fiber = ctx.plugin(Jubian, { ledgerRoot, workspaceSecrets: false })
  await fiber
  await ctx.plugin(Llm); await ctx.plugin(SessionStore); await ctx.plugin(SessionProjections)
  await ctx.plugin(AgentRegistry); await ctx.plugin(AgentLoop, { agents: [] })
  const noNetwork = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('No provider requests in budget control'))
  try {
    const adapter = new MockAdapter([
      toolCallResponse('budget-read', 'jubian_budget', { action: 'read', script_id: 2708 }),
      (options) => {
        const result = options.messages.findLast(message => message.role === 'tool')
        const block = result?.content[0]
        if (block?.type !== 'text') throw new Error('Missing logged budget read')
        const value = JSON.parse(block.text) as { revision: string }
        return toolCallResponse('budget-update', 'jubian_budget', { action: 'update', script_id: 2708,
          project_dir: home, limit_cny: '5000', expected_revision: value.revision })
      },
      toolCallResponse('project-read', 'drama_project', { action: 'read', project_dir: home }),
      textResponse('项目预算已保存为5000元。'),
    ])
    ctx.llm.registerAdapter(['mock'], adapter)
    const agent = await ctx.agentLoop.create(SessionId('budget-owner'), { provider: 'mock', model: 'mock' }, { cwd: home })
    agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: '项目2708总预算调整为5000元，继续制作' }] }))
    await agent.whenIdle()
    expect(adapter.requests).toHaveLength(4)
    const outputs = agent.session.snapshotEvents().filter(event => event.type === 'tool/result').map((event) => {
      const message = event.data.message, block = message.content[0]
      if (block?.type !== 'text') throw new Error('Expected logged JSON budget result')
      const result = JSON.parse(block.text) as Record<string, unknown>
      const budget = message.toolCallId === ToolCallId('project-read') ? result.budget as Record<string, unknown> : result
      return { tool_call_id: message.toolCallId, limit_cents: budget.limit_cents, script_id: budget.script_id,
        source: budget.source, settled_cents: budget.settled_cents, reserved_cents: budget.reserved_cents }
    })
    expect(outputs).toEqual([
      { tool_call_id: 'budget-read', limit_cents: 400000, script_id: 2708, source: 'default', settled_cents: 0, reserved_cents: 0 },
      { tool_call_id: 'budget-update', limit_cents: 500000, script_id: 2708, source: 'project', settled_cents: 0, reserved_cents: 0 },
      { tool_call_id: 'project-read', limit_cents: 500000, script_id: 2708, source: 'project', settled_cents: 0, reserved_cents: 0 },
    ])
    await expect(`${JSON.stringify(outputs, null, 2)}\n`).toMatchFileSnapshot(fileURLToPath(new URL('./expected/project-budget-update.json', import.meta.url)))
    const ledger = new JubianLedger({ root: ledgerRoot, defaultLimitCents: () => seriesBudgetLimit(ctx) })
    expect(await checkBudget({ ledger, method: 'image_generate', scriptId: 2708,
      quote: { amount: '4500.00', unit: 'CNY' } })).toMatchObject({ status: 'authorized', limitCents: 500000 })
    expect(noNetwork).not.toHaveBeenCalled()
    await fiber.dispose()
    expect(ctx.tools.get('jubian_budget')).toBeUndefined()
    expect(ctx.get('jubianBudget')).toBeUndefined()
  } finally { noNetwork.mockRestore() }
})
