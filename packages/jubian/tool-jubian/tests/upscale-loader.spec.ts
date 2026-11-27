/** Live upscale prices reach the default budget through the real Loader and recorded tool pipeline. */
import * as NativeToolExecutor from '@deepseek-ai/dsh-tool-executor-native'
import { access, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { Context } from '@deepseek-ai/cordis'
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

const mediaKit = { modelId: 'AI MediaKit', platformId: 'AI_MEDIA_KIT', standardId: 27, videoStandardId: 165 }
const generativeMediaKit = { ...mediaKit, modelId: 'enhance-video-generative', standardId: 105, videoStandardId: 514 }

it('rejects a string MediaKit pilot switch at activation', async () => {
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  await expect(Reflect.apply(Jubian.apply, undefined, [ctx, { mediaKitPostprocess: 'false' }]))
    .rejects.toThrow('mediaKitPostprocess must be a boolean')
})

it.each([
  { scenario: 'a live MediaKit per-minute price', model: mediaKit, quote: { amount: '1.50', cents: 150 } },
  { scenario: 'a missing live MediaKit price', model: mediaKit, quote: null },
  { scenario: 'a live generative MediaKit standard price', model: generativeMediaKit, quote: { amount: '20.00', cents: 2000 } },
  { scenario: 'an approved direct MediaKit pilot', model: mediaKit, quote: { amount: '1.00', cents: 100 }, pilot: true },
])('records upscale results with $scenario under the default budget and no manual estimates', async ({ model, quote, pilot }) => {
  const priced = quote !== null
  const { ctx, home } = await configurationFixture({ hmr: false, rows: [
    { id: 'tool-executor-native', name: 'cordis:native-executor' },
    { id: 'config-editor', name: 'cordis:editor' }, { id: 'settings', name: 'cordis:settings' },
    { id: 'prompt', name: 'cordis:prompt' }, { id: 'tools', name: 'cordis:tools' },
    { id: 'credentials', name: 'cordis:credentials', config: { JUBIANAI_ADMIN_TOKEN: 'offline-upscale-token' } },
    { id: 'drama-settings', name: 'cordis:drama' },
  ], builtins: { 'native-executor': NativeToolExecutor, prompt: SystemPrompt, tools: Tools, credentials: MemoryCredentials,
    drama: DramaSettings, jubian: Jubian } })
  const ledgerRoot = join(home, 'ledger'), ledger = new JubianLedger({ root: ledgerRoot })
  const jobKey = 'b'.repeat(64)
  const downloadedPath = join(home, 'pilot.mp4')
  const mp4Header = Buffer.from('000000186674797069736f6d0000000069736f6d61766331', 'hex')
  let directSubmits = 0
  if (pilot) ctx.provide('museAccount', {
    previewMediaPostprocess: () => ({ state: 'ready', jobKey, amount: '1.00', unit: 'CNY' }),
    submitMediaPostprocess: () => { directSubmits++; return { state: 'accepted' } },
    statusMediaPostprocess: () => ({ state: 'completed',
      videoUrl: 'https://result.example.test/clip.mp4?signature=private', downloadOrigin: 'https://result.example.test' }),
    claimMediaPostprocessFallback: () => { throw Error('Accepted MediaKit work cannot claim the backup') },
  })
  const calls: { method: string; path: string }[] = []
  const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : input.toString())
    if (pilot && url.origin === 'https://result.example.test') {
      expect(init).toMatchObject({ method: 'GET', redirect: 'error', credentials: 'omit' })
      expect(init?.headers).toBeUndefined()
      expect(url.pathname).toBe('/clip.mp4')
      return new Response(Uint8Array.from(mp4Header))
    }
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
      data = [{ id: 55, modelId: '2074071626416742401', platformId: 'RUNNING_HUB', unit: '元/条', unitPrice: 1,
        genTypes: [], videoStandards: [{ id: 303, modelId: '2074071626416742401', resolution: '1080p' }] },
      { id: 27, modelId: 'AI MediaKit', platformId: 'AI_MEDIA_KIT', unit: '元/分钟(1系数)',
        ...(priced ? { unitPrice: 0.375 } : {}), genTypes: [], videoStandards: [
          { id: 165, modelId: 'AI MediaKit', resolution: '1080p', ratio: 'standard', height: 4, width: 0, frames: 31 },
          { id: 166, modelId: 'AI MediaKit', resolution: '720p', ratio: 'standard', height: 2, width: 0, frames: 31 }] },
      { id: 105, modelId: 'enhance-video-generative', platformId: 'AI_MEDIA_KIT', unit: '元/分钟(1系数)',
        unitPrice: 2.5, genTypes: [], videoStandards: [
          { id: 514, modelId: 'enhance-video-generative', resolution: '1080p', ratio: '', height: null, width: null, frames: 30, price: 5 },
          { id: 515, modelId: 'enhance-video-generative', resolution: '720p', ratio: '', height: null, width: null, frames: 30, price: 2.5 }] }]
    } else if (method === 'POST' && path === '/aigc/storyboard/hdConversion') {
      if (!quote) throw new Error('An unquoted operation cannot reach the paid endpoint')
      expect(body).toMatchObject({ scriptId: 2708,
        episodeId: 46744, firstResultId: 1007193, parentResultId: 1007193, duration: 13.5,
        videoUrl: 'https://media.example.test/source.mp4', taskType: 20, ...model })
      expect(await ledger.find('loader-upscale')).toMatchObject({ method: 'video_upscale',
        script_id: 2708, quoted_amount: quote.amount, quote_unit: 'CNY', quote_standard_id: model.standardId, outcome: null })
      data = 429001
    } else throw new Error(`Unexpected offline provider request: ${method} ${path}`)
    return new Response(JSON.stringify({ code: 200, data }), { status: 200 })
  })
  onTestFinished(() => { fetch.mockRestore() })
  try {
    await ctx.loader.create({ name: 'cordis:jubian', config: { ledgerRoot,
      workspaceSecrets: false, baseUrl: 'https://upscale-loader.invalid/prod-api',
      ...(pilot ? { mediaKitPostprocess: true } : {}) } })
    await ctx.loader.await()
    for (const entry of ctx.loader.entries()) await entry.fiber?.await()
    expect(seriesBudgetLimit(ctx)).toBe(400_000)
    await expect(access(join(ledgerRoot, 'authorization.json'))).rejects.toMatchObject({ code: 'ENOENT' })
    await ctx.plugin(Llm); await ctx.plugin(SessionStore); await ctx.plugin(SessionProjections)
    await ctx.plugin(AgentRegistry); await ctx.plugin(AgentLoop, { agents: [] })
    const args = { method: 'upscale', task_id: 42, idempotency_key: 'loader-upscale',
      ...(model === generativeMediaKit ? { model_id: model.modelId, platform_id: model.platformId, resolution: '1080p' } : {}) }
    const adapter = new MockAdapter([
      toolCallResponse('upscale-submit', 'jubian_video', args),
      ...(priced ? [toolCallResponse('upscale-replay', 'jubian_video', args)] : []),
      ...(pilot ? [toolCallResponse('upscale-status', 'jubian_media', { method: 'status', processing_job_key: jobKey })] : []),
      ...(pilot ? [toolCallResponse('upscale-download', 'jubian_media', {
        method: 'download_processed', processing_job_key: jobKey, output_path: downloadedPath,
      })] : []),
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
    expect(results).toHaveLength(pilot ? 5 : priced ? 3 : 2)
    expect(results[0]).toMatchObject({ toolCallId: ToolCallId('upscale-submit'), isError: !priced })
    const first = results[0]?.content[0]
    if (first?.type !== 'text') throw new Error('Missing recorded upscale result')
    if (pilot) {
      expect(JSON.parse(first.text)).toMatchObject({ processing_job_key: jobKey, status: 'accepted' })
      for (const index of [1, 2]) {
        const reported = results[index]?.content[0]
        if (reported?.type !== 'text') throw new Error('Missing recorded MediaKit result')
        expect(JSON.parse(reported.text)).toMatchObject({ processing_job_key: jobKey, status: 'completed' })
        expect(reported.text).not.toContain('signature')
      }
      const downloaded = results[3]?.content[0]
      if (downloaded?.type !== 'text') throw new Error('Missing saved MediaKit result')
      expect(JSON.parse(downloaded.text)).toMatchObject({ status: 'completed', path: downloadedPath, bytes: mp4Header.length })
      expect(downloaded.text).not.toContain('signature')
      expect(await readFile(downloadedPath)).toEqual(mp4Header)
      expect(directSubmits).toBe(1)
      expect(await ledger.records()).toMatchObject([{ method: 'video_upscale', script_id: 2708,
        quoted_amount: '1.00', outcome: 'accepted' }])
    } else if (priced) {
      expect(JSON.parse(first.text)).toMatchObject({ replayed: false, outcome: 'accepted',
        accepted_task_id: '429001', budget: { status: 'authorized' } })
      const replay = results[1]?.content[0]
      if (replay?.type !== 'text') throw new Error('Missing recorded upscale replay')
      expect(results[1]?.isError).toBe(false)
      expect(JSON.parse(replay.text)).toMatchObject({ replayed: true, outcome: 'accepted' })
      const records = await ledger.records()
      expect(records).toHaveLength(1)
      expect(records[0]).toMatchObject({ idempotency_key: 'loader-upscale', method: 'video_upscale',
        script_id: 2708, quoted_amount: quote.amount, quote_unit: 'CNY', quote_standard_id: model.standardId,
        outcome: 'accepted' })
      expect(Number.isFinite(Date.parse(records[0]?.quote_observed_at ?? ''))).toBe(true)
    } else {
      expect(first.text).toContain('没有报价')
      expect(await ledger.records()).toEqual([])
    }
    const budget = results.at(-1)?.content[0]
    if (budget?.type !== 'text') throw new Error('Missing recorded project budget')
    expect(JSON.parse(budget.text)).toMatchObject({ script_id: 2708, source: 'default', limit_cents: 400_000,
      settled_cents: quote?.cents ?? 0, reserved_cents: 0, accounting_complete: true })
    expect(adapter.requests).toHaveLength(pilot ? 6 : priced ? 4 : 3)
    expect(adapter.requests.at(-1)?.messages.filter(message => message.role === 'tool')
      .map(message => message.content)).toEqual(results.map(message => message.content))
    expect(calls.filter(call => call.path === '/model/charge/getSelectList')).toHaveLength(pilot ? 0 : 1)
    expect(calls.filter(call => call.path === '/aigc/storyboard/hdConversion')).toHaveLength(priced && !pilot ? 1 : 0)
    expect(calls).toHaveLength(pilot ? 2 : priced ? 4 : 3)
    const row = [...ctx.loader.entries()].find(entry => entry.options.name === 'cordis:jubian')
    await row?.fiber?.dispose()
    expect(ctx.tools.get('jubian_video')).toBeUndefined()
  } finally { fetch.mockRestore() }
})
