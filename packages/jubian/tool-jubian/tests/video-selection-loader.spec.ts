/** Model-choice questions and appended context through the Loader and a real Agent loop. */
import { readFile } from 'node:fs/promises'
import { expect, it, vi } from 'vitest'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import Llm, { createUserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SessionProjections from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import UserQuestions from '@deepseek-ai/dsh-user-questions'
import Tools from '@deepseek-ai/dsh-tools'
import Subagents from '@deepseek-ai/dsh-subagent'
import * as Spawn from '@deepseek-ai/dsh-subagent-spawn-in-process'
import { MockAdapter, textResponse, toolCallResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import { MemoryCredentials } from '../../../credentials/credentials/tests/memory.ts'
import { configurationFixture } from '../../../settings/settings/tests/configuration-fixture.ts'
import * as Jubian from '../src/index.ts'
import { videoSelectionContext } from '../src/video-session.ts'

it('delivers a fresh subagent the parent video selection through the loaded service before its first request', async () => {
  const catalogue = JSON.parse(await readFile(new URL('../../jubian-api/tests/fixtures/catalogue-20261016.json', import.meta.url), 'utf8')) as Record<string, unknown>
  const { ctx, home } = await configurationFixture({ hmr: false, rows: [
    { id: 'prompt', name: 'cordis:prompt' }, { id: 'tools', name: 'cordis:tools' },
    { id: 'credentials', name: 'cordis:credentials', config: { JUBIANAI_ADMIN_TOKEN: 'fixture-token' } },
  ], builtins: { prompt: SystemPrompt, tools: Tools, credentials: MemoryCredentials, jubian: Jubian } })
  const requests: string[] = []
  const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
    const address = url instanceof Request ? url.url : url.toString()
    requests.push(`${init?.method} ${address}`)
    if (init?.method !== 'GET' || !address.includes('getSelectList?taskType=1')) throw new Error('Unexpected provider write')
    return new Response(JSON.stringify({ code: 200, data: catalogue['1'] }))
  })
  try {
    await ctx.plugin(Llm); await ctx.plugin(SessionStore); await ctx.plugin(SessionProjections)
    await ctx.plugin(AgentRegistry); await ctx.plugin(AgentLoop, { agents: [] })
    await ctx.plugin(Subagents); await ctx.plugin(Spawn, { providerName: 'spawn' })
    const entry = await ctx.loader.create({ name: 'cordis:jubian', config: { ledgerRoot: home, workspaceSecrets: false,
      sessionVideoSelection: true,
      defaultVideoModel: { modelId: 'doubao-seedance-2-5-260628', platformId: 'FANG_ZHOU', resolution: '480p' } } })
    await ctx.loader.await()
    for (const row of ctx.loader.entries()) await row.fiber?.await()
    const adapter = new MockAdapter([textResponse('按继承的视频模型完成核对。')])
    ctx.llm.registerAdapter(['mock'], adapter)
    const parent = await ctx.agentLoop.create(SessionId('video-child-parent'), { provider: 'mock', model: 'mock' }, { cwd: home })
    const service = ctx.jubianVideoSelection
    const choice = (await service.catalogue()).find(option => option.maxDurationSeconds === 15)!
    const selected = await service.select(parent, choice.key, 0)
    const before = requests.length
    const run = await ctx.subagents.start('spawn', { parent, prompt: [{ type: 'text', text: '核对当前模型与时长。' }], signal: new AbortController().signal })
    try {
      await run.result
      const child = ctx.agents.get(run.id)!
      expect(service.current(child)).toEqual(selected)
      expect(requests).toHaveLength(before)
      const contexts = adapter.requests[0]!.messages.filter(message => message.role === 'user'
        && (message.source?.kind === 'runtime-context' || message.source?.kind === 'jubian-video-selection'))
        .flatMap(message => message.content).flatMap(part => part.type === 'text' ? [part.text] : [])
      expect(contexts.join('\n')).toContain(videoSelectionContext(selected))
      expect({ choice: service.current(child), contexts }).toMatchSnapshot('spawned child current video choice')
    } finally { await run.dispose() }
    await ctx.loader.resolve(entry).fiber!.dispose()
    const afterDispose = (await ctx.agents.create({ sessionId: SessionId('video-child-after-dispose'), parentAgent: parent,
      agentOptions: { provider: 'mock', model: 'mock' }, meta: { cwd: home, origin: 'subagent', parentSession: parent.id } })).agent
    expect(afterDispose.session.snapshotEvents().some(event => event.type === 'jubian/video-selection')).toBe(false)
  } finally { fetch.mockRestore(); await ctx.fiber.dispose() }
})

it('asks about shorter duration, applies the human answer and appends context without replacing the system prompt', async () => {
  const catalogue = JSON.parse(await readFile(new URL('../../jubian-api/tests/fixtures/catalogue-20261016.json', import.meta.url), 'utf8')) as Record<string, unknown>
  const { ctx, home } = await configurationFixture({ hmr: false, rows: [
    { id: 'prompt', name: 'cordis:prompt' }, { id: 'tools', name: 'cordis:tools' },
    { id: 'credentials', name: 'cordis:credentials', config: { JUBIANAI_ADMIN_TOKEN: 'fixture-token' } },
  ], builtins: { prompt: SystemPrompt, tools: Tools, credentials: MemoryCredentials, jubian: Jubian } })
  const requests: string[] = []
  const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
    const address = url instanceof Request ? url.url : url.toString()
    requests.push(`${init?.method} ${address}`)
    if (init?.method !== 'GET' || !address.includes('getSelectList?taskType=1')) throw new Error('Unexpected provider write')
    return new Response(JSON.stringify({ code: 200, data: catalogue['1'] }))
  })
  try {
    await ctx.plugin(Llm); await ctx.plugin(SessionStore); await ctx.plugin(SessionProjections)
    await ctx.plugin(AgentRegistry); await ctx.plugin(AgentLoop, { agents: [] }); await ctx.plugin(UserQuestions)
    await ctx.loader.create({ name: 'cordis:jubian', config: { ledgerRoot: home, workspaceSecrets: false,
      sessionVideoSelection: true, imageAllowedStandardIds: [76, 66, 86],
      defaultVideoModel: { modelId: 'doubao-seedance-2-5-260628', platformId: 'FANG_ZHOU', resolution: '480p' } } })
    await ctx.loader.await()
    for (const entry of ctx.loader.entries()) await entry.fiber?.await()
    const adapter = new MockAdapter([textResponse('ready'),
      toolCallResponse('choose-model', 'jubian_video_model', { method: 'duration_conflict', reason: '三张25秒视频包超过当前15秒上限', duration_seconds: 25 }),
      textResponse('已按你选择的30秒模型保留原包。')])
    ctx.llm.registerAdapter(['mock'], adapter)
    const agent = await ctx.agentLoop.create(SessionId('video-selection-owner'), { provider: 'mock', model: 'mock' }, { cwd: home })
    await vi.waitFor(() =>{  expect(ctx.jubianVideoSelection).toBeDefined() })
    const service = ctx.jubianVideoSelection
    expect(await service.initialize(agent)).toMatchObject({ resolution: '480p', maxDurationSeconds: 30, revision: 1 })
    const initial = (await service.catalogue()).find(option => option.maxDurationSeconds === 15)!
    await service.select(agent, initial.key, 1)
    expect(adapter.requests).toHaveLength(0)
    agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: '你好' }] }))
    await agent.whenIdle()
    const questions: string[] = []
    ctx.on('user-questions/request', (request) => {
      questions.push(request.questions[0]!.question)
      const chosen = questions.length === 1 ? '更换模型，保留原视频包' : request.questions[0]!.options![0]!.label
      return Promise.resolve({ answers: [{ id: request.questions[0]!.id, selected: [chosen] }] })
    }, { global: true })
    agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: '当前的25秒包怎么办' }] }))
    await agent.whenIdle()
    expect(adapter.requests).toHaveLength(3)
    expect(service.current(agent)).toMatchObject({ maxDurationSeconds: 30, revision: 3 })
    expect(questions).toHaveLength(2)
    const system = adapter.requests.map(request => request.messages.filter(message => message.role === 'system'))
    expect(system[0]).toEqual(system[1]); expect(system[1]).toEqual(system[2])
    const contexts = adapter.requests.map(request => request.messages.filter(message => message.role === 'user' && message.source?.kind === 'runtime-context'))
    expect(JSON.stringify(contexts[0])).toContain('上限 15 秒')
    expect(JSON.stringify(contexts[2])).toContain('上限 30 秒')
    const results = agent.session.snapshotEvents().filter(event => event.type === 'tool/result')
    expect(results).toHaveLength(1)
    expect(results[0]!.data.message.isError).toBeFalsy()
    expect(results[0]!.data.message.content).toMatchSnapshot('explicit longer-model answer')
    expect(requests.every(request => request.startsWith('GET '))).toBe(true)
    expect(agent.session.snapshotEvents().filter(event => event.type === 'jubian/video-selection').map(event => event.data.selection.maxDurationSeconds)).toEqual([30, 15, 30])
  } finally { fetch.mockRestore(); await ctx.fiber.dispose() }
})
