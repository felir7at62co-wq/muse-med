/** Explicit erasure estimates traverse the real Loader, budget gate and recorded tool pipeline. */
import { access } from 'node:fs/promises'
import { join } from 'node:path'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import * as DramaSettings from '@deepseek-ai/dsh-drama-settings'
import { JubianLedger } from '@deepseek-ai/dsh-jubian'
import Llm, { ToolCallId, createUserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SessionProjections from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import Tools from '@deepseek-ai/dsh-tools'
import { expect, it, onTestFinished, vi } from 'vitest'
import { MockAdapter, textResponse, toolCallResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import { MemoryCredentials } from '../../../credentials/credentials/tests/memory.ts'
import { configurationFixture } from '../../../settings/settings/tests/configuration-fixture.ts'
import { seriesBudgetLimit } from '../src/budget-settings.ts'
import * as Jubian from '../src/index.ts'

it.each([false, true])('records erasure with an explicit estimate: %s', async (estimated) => {
  const { ctx, home } = await configurationFixture({ hmr: false, rows: [
    { id: 'config-editor', name: 'cordis:editor' }, { id: 'settings', name: 'cordis:settings' },
    { id: 'prompt', name: 'cordis:prompt' }, { id: 'tools', name: 'cordis:tools' },
    { id: 'credentials', name: 'cordis:credentials', config: { JUBIANAI_ADMIN_TOKEN: 'offline-erasure-token' } },
    { id: 'drama-settings', name: 'cordis:drama' },
  ], builtins: { prompt: SystemPrompt, tools: Tools, credentials: MemoryCredentials,
    drama: DramaSettings, jubian: Jubian } })
  const ledgerRoot = join(home, 'ledger'), ledger = new JubianLedger({ root: ledgerRoot })
  const calls: { method: string; path: string }[] = []
  const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : input.toString())
    expect(url.origin, 'the fixture refuses external provider traffic').toBe('https://erase-loader.invalid')
    const method = init?.method ?? 'GET', path = url.pathname.replace('/prod-api', '')
    const body: unknown = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined
    calls.push({ method, path })
    let data: unknown
    if (method === 'GET' && path === '/admin/aigc/video/task/42') {
      data = { id: 42, scriptId: 2708, episodeId: 46744, episodeCount: 1 }
    } else if (method === 'POST' && path === '/admin/aigc/video/task/sub/list') {
      expect(body).toEqual({ aigcVideoTaskId: 42 })
      data = { total: 1, rows: [{ id: 990, aigcVideoTaskId: 42, taskStatus: 'succeeded',
        duration: 13.5, firstResultId: 123, parentResultId: 456,
        resultList: [{ taskType: 1, tosVideoUrl: 'https://media.example.test/source.mp4' }] }] }
    } else if (method === 'POST' && path === '/aigc/storyboard/subtitleEraser') {
      expect(estimated, 'no paid call may leave without an approved reservation').toBe(true)
      expect(body).toMatchObject({ scriptId: 2708, episodeId: 46744, firstResultId: 123,
        parentResultId: 456, duration: 13.5, videoUrl: 'https://media.example.test/source.mp4',
        taskType: 10, modelId: 'ark-erase-video-subtitle-pro', standardId: 67, platformId: 'AI_MEDIA_KIT' })
      expect(body).not.toHaveProperty('videoWidth')
      expect(body).not.toHaveProperty('videoHeight')
      expect(body).not.toHaveProperty('estimated_cost_cny')
      expect(body).not.toHaveProperty('estimate_basis')
      expect(await ledger.find('loader-erasure')).toMatchObject({ method: 'erase_subtitle',
        script_id: 2708, quoted_amount: '1.00', quote_unit: 'CNY', outcome: null })
      data = { taskId: 429001 }
    } else throw new Error(`Unexpected offline provider request: ${method} ${path}`)
    return new Response(JSON.stringify({ code: 200, data }), { status: 200 })
  })
  onTestFinished(() => { fetch.mockRestore() })
  try {
    await ctx.loader.create({ name: 'cordis:jubian', config: { ledgerRoot,
      workspaceSecrets: false, baseUrl: 'https://erase-loader.invalid/prod-api' } })
    await ctx.loader.await()
    for (const entry of ctx.loader.entries()) await entry.fiber?.await()
    expect(seriesBudgetLimit(ctx)).toBe(400_000)
    await expect(access(join(ledgerRoot, 'authorization.json'))).rejects.toMatchObject({ code: 'ENOENT' })
    await ctx.plugin(Llm); await ctx.plugin(SessionStore); await ctx.plugin(SessionProjections)
    await ctx.plugin(AgentRegistry); await ctx.plugin(AgentLoop, { agents: [] })
    const args = { method: 'erase_subtitle', task_id: 42, model_id: 'ark-erase-video-subtitle-pro',
      video_width: 480, video_height: 854, idempotency_key: 'loader-erasure',
      ...(estimated ? { estimated_cost_cny: '1.00',
        estimate_basis: 'Synthetic caller reservation for this offline test, not a provider quote.' } : {}) }
    const adapter = new MockAdapter([
      toolCallResponse('erase-submit', 'jubian_storyboard', args),
      ...(estimated ? [toolCallResponse('erase-replay', 'jubian_storyboard', args)] : []),
      toolCallResponse('erase-budget', 'jubian_budget', { action: 'read', script_id: 2708 }),
      textResponse(estimated ? 'Submitted one offline request with a caller estimate, not a provider quote.'
        : 'No erasure was submitted without an estimate.'),
    ])
    ctx.llm.registerAdapter(['mock'], adapter)
    const agent = await ctx.agentLoop.create(SessionId('erase-loader-owner'),
      { provider: 'mock', model: 'mock' }, { cwd: home })
    agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text',
      text: 'Use only the offline provider. If supplied, reserve the synthetic caller estimate once, then read the budget.' }] }))
    await agent.whenIdle()
    const results = agent.session.snapshotEvents().filter(event => event.type === 'tool/result')
      .map(event => event.data.message)
    expect(results).toHaveLength(estimated ? 3 : 2)
    expect(results[0], JSON.stringify(results[0]?.content)).toMatchObject({ toolCallId: ToolCallId('erase-submit'), isError: !estimated })
    const first = results[0]?.content[0]
    if (first?.type !== 'text') throw new Error('Missing recorded erasure result')
    if (estimated) {
      expect(JSON.parse(first.text)).toMatchObject({ replayed: false, outcome: 'accepted',
        accepted_task_id: '429001', budget: { status: 'authorized' } })
      expect(first.text).toContain('不是供应商报价或实际结算金额')
      const replay = results[1]?.content[0]
      if (replay?.type !== 'text') throw new Error('Missing recorded erasure replay')
      expect(results[1]?.isError).toBe(false)
      expect(JSON.parse(replay.text)).toMatchObject({ replayed: true, outcome: 'accepted' })
      expect(replay.text).not.toContain('本次按调用方声明')
      expect(await ledger.records()).toHaveLength(1)
      expect(await ledger.find('loader-erasure')).toMatchObject({ quoted_amount: '1.00', quote_unit: 'CNY', outcome: 'accepted' })
    } else {
      expect(first.text).toContain('没有报价')
      expect(await ledger.records()).toEqual([])
    }
    const budget = results.at(-1)?.content[0]
    if (budget?.type !== 'text') throw new Error('Missing recorded project budget')
    expect(JSON.parse(budget.text)).toMatchObject({ script_id: 2708, source: 'default', limit_cents: 400_000,
      settled_cents: estimated ? 100 : 0, reserved_cents: 0, accounting_complete: true })
    expect(adapter.requests).toHaveLength(estimated ? 4 : 3)
    expect(adapter.requests.at(-1)?.messages.filter(message => message.role === 'tool')
      .map(message => message.content)).toEqual(results.map(message => message.content))
    expect(calls.filter(call => call.path === '/aigc/storyboard/subtitleEraser')).toHaveLength(estimated ? 1 : 0)
    expect(calls).toHaveLength(estimated ? 3 : 2)
    const row = [...ctx.loader.entries()].find(entry => entry.options.name === 'cordis:jubian')
    await row?.fiber?.dispose()
    expect(ctx.tools.get('jubian_storyboard')).toBeUndefined()
  } finally {
    await ctx.fiber.dispose()
    fetch.mockRestore()
  }
})
