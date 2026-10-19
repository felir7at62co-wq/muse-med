/** Live upscale prices reach the default budget through the real Loader and recorded tool pipeline. */
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

it.each([
  { scenario: 'a live per-video price', priced: true },
  { scenario: 'a missing live price', priced: false },
])('records upscale results with $scenario under the default budget and no manual estimates', async ({ priced }) => {
  const { ctx, home } = await configurationFixture({ hmr: false, rows: [
    { id: 'config-editor', name: 'cordis:editor' }, { id: 'settings', name: 'cordis:settings' },
    { id: 'prompt', name: 'cordis:prompt' }, { id: 'tools', name: 'cordis:tools' },
    { id: 'credentials', name: 'cordis:credentials', config: { JUBIANAI_ADMIN_TOKEN: 'offline-upscale-token' } },
    { id: 'drama-settings', name: 'cordis:drama' },
  ], builtins: { prompt: SystemPrompt, tools: Tools, credentials: MemoryCredentials,
    drama: DramaSettings, jubian: Jubian } })
  const ledgerRoot = join(home, 'ledger'), ledger = new JubianLedger({ root: ledgerRoot })
  const calls: { method: string; path: string }[] = []
  const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : input.toString())
    expect(url.origin, 'the fixture refuses external provider traffic').toBe('https://upscale-loader.invalid')
    const method = init?.method ?? 'GET', path = url.pathname.replace('/prod-api', '')
    const body: unknown = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined
    calls.push({ method, path })
    let data: unknown
    if (method === 'GET' && path === '/admin/aigc/video/task/42') {
      data = { id: 42, scriptId: 2708, episodeId: 46744, episodeCount: 1 }
    } else if (method === 'POST' && path === '/admin/aigc/video/task/sub/list') {
      expect(body).toEqual({ aigcVideoTaskId: 42 })
      data = { total: 1, rows: [{ id: 990, aigcVideoTaskId: 42, taskStatus: 'succeeded',
        duration: 13.5, firstResultId: 1007193, parentResultId: 1007193,
        resultList: [{ tosVideoUrl: 'https://media.example.test/source.mp4' }] }] }
    } else if (method === 'GET' && path === '/model/charge/getSelectList') {
      expect(url.searchParams.get('taskType')).toBe('20')
      data = [{ id: 55, modelId: '2074071626416742401', platformId: 'RUNNING_HUB',
        unit: '元/条', ...(priced ? { unitPrice: 1 } : {}), genTypes: [],
        videoStandards: [{ id: 303, modelId: '2074071626416742401', resolution: '1080p' }] }]
    } else if (method === 'POST' && path === '/aigc/storyboard/hdConversion') {
      expect(priced, 'an unquoted operation cannot reach the paid endpoint').toBe(true)
      expect(body).toMatchObject({ scriptId: 2708,
        episodeId: 46744, firstResultId: 1007193, parentResultId: 1007193, duration: 13.5,
        videoUrl: 'https://media.example.test/source.mp4', taskType: 20, standardId: 55,
        modelId: '2074071626416742401', platformId: 'RUNNING_HUB', videoStandardId: 303 })
      expect(await ledger.find('loader-upscale')).toMatchObject({ method: 'video_upscale',
        script_id: 2708, quoted_amount: '1.00', quote_unit: 'CNY', quote_standard_id: 55, outcome: null })
      data = 429001
    } else throw new Error(`Unexpected offline provider request: ${method} ${path}`)
    return new Response(JSON.stringify({ code: 200, data }), { status: 200 })
  })
  onTestFinished(() => { fetch.mockRestore() })
  try {
    await ctx.loader.create({ name: 'cordis:jubian', config: { ledgerRoot,
      workspaceSecrets: false, baseUrl: 'https://upscale-loader.invalid/prod-api' } })
    await ctx.loader.await()
    for (const entry of ctx.loader.entries()) await entry.fiber?.await()
    expect(seriesBudgetLimit(ctx)).toBe(400_000)
    await expect(access(join(ledgerRoot, 'authorization.json'))).rejects.toMatchObject({ code: 'ENOENT' })
    await ctx.plugin(Llm); await ctx.plugin(SessionStore); await ctx.plugin(SessionProjections)
    await ctx.plugin(AgentRegistry); await ctx.plugin(AgentLoop, { agents: [] })
    const args = { method: 'upscale', task_id: 42, idempotency_key: 'loader-upscale' }
    const adapter = new MockAdapter([
      toolCallResponse('upscale-submit', 'jubian_video', args),
      ...(priced ? [toolCallResponse('upscale-replay', 'jubian_video', args)] : []),
      toolCallResponse('upscale-budget', 'jubian_budget', { action: 'read', script_id: 2708 }),
      textResponse(priced ? 'The offline upscale was submitted once and its cost is recorded.'
        : 'No upscale was submitted because its price is missing.'),
    ])
    ctx.llm.registerAdapter(['mock'], adapter)
    const agent = await ctx.agentLoop.create(SessionId('upscale-loader-owner'),
      { provider: 'mock', model: 'mock' }, { cwd: home })
    agent.followup(createUserMessage({ source: { kind: 'user' },
      content: [{ type: 'text', text: 'Upscale task 42 once using the offline provider, then read the project budget.' }] }))
    await agent.whenIdle()
    const results = agent.session.snapshotEvents().filter(event => event.type === 'tool/result')
      .map(event => event.data.message)
    expect(results).toHaveLength(priced ? 3 : 2)
    expect(results[0]).toMatchObject({ toolCallId: ToolCallId('upscale-submit'), isError: !priced })
    const first = results[0]?.content[0]
    if (first?.type !== 'text') throw new Error('Missing recorded upscale result')
    if (priced) {
      expect(JSON.parse(first.text)).toMatchObject({ replayed: false, outcome: 'accepted',
        accepted_task_id: '429001', budget: { status: 'authorized' } })
      const replay = results[1]?.content[0]
      if (replay?.type !== 'text') throw new Error('Missing recorded upscale replay')
      expect(results[1]?.isError).toBe(false)
      expect(JSON.parse(replay.text)).toMatchObject({ replayed: true, outcome: 'accepted' })
      const records = await ledger.records()
      expect(records).toHaveLength(1)
      expect(records[0]).toMatchObject({ idempotency_key: 'loader-upscale', method: 'video_upscale',
        script_id: 2708, quoted_amount: '1.00', quote_unit: 'CNY', quote_standard_id: 55,
        outcome: 'accepted' })
      expect(Number.isFinite(Date.parse(records[0]?.quote_observed_at ?? ''))).toBe(true)
    } else {
      expect(first.text).toContain('没有报价')
      expect(await ledger.records()).toEqual([])
    }
    const budget = results.at(-1)?.content[0]
    if (budget?.type !== 'text') throw new Error('Missing recorded project budget')
    expect(JSON.parse(budget.text)).toMatchObject({ script_id: 2708, source: 'default', limit_cents: 400_000,
      settled_cents: priced ? 100 : 0, reserved_cents: 0, accounting_complete: true })
    expect(adapter.requests).toHaveLength(priced ? 4 : 3)
    expect(adapter.requests.at(-1)?.messages.filter(message => message.role === 'tool')
      .map(message => message.content)).toEqual(results.map(message => message.content))
    expect(calls.filter(call => call.path === '/model/charge/getSelectList')).toHaveLength(1)
    expect(calls.filter(call => call.path === '/aigc/storyboard/hdConversion')).toHaveLength(priced ? 1 : 0)
    expect(calls).toHaveLength(priced ? 4 : 3)
    const row = [...ctx.loader.entries()].find(entry => entry.options.name === 'cordis:jubian')
    await row?.fiber?.dispose()
    expect(ctx.tools.get('jubian_video')).toBeUndefined()
  } finally { fetch.mockRestore() }
})
