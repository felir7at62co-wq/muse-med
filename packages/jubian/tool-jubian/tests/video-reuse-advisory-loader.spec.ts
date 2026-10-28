/** Existing-video advice is logged without changing tool execution or later user intent. */
import { expect, it } from 'vitest'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import Llm, { createUserMessage } from '@deepseek-ai/dsh-llm'
import Sessions, { SessionId } from '@deepseek-ai/dsh-session'
import SessionProjections from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import Tools, { defineContentToolFixture } from '@deepseek-ai/dsh-tools'
import { MockAdapter, textResponse, toolCallResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import { MemoryCredentials } from '../../../credentials/credentials/tests/memory.ts'
import { configurationFixture } from '../../../settings/settings/tests/configuration-fixture.ts'
import * as Jubian from '../src/index.ts'
import { registerVideoReuseAdvisory } from '../src/video-reuse-advisory.ts'

async function fixture(existingVideoAdvisory = true) {
  const configured = await configurationFixture({ hmr: false, rows: [
    { id: 'prompt', name: 'cordis:prompt' }, { id: 'tools', name: 'cordis:tools' },
    { id: 'credentials', name: 'cordis:credentials' },
  ], builtins: { prompt: SystemPrompt, tools: Tools, credentials: MemoryCredentials, jubian: Jubian } })
  const { ctx, home } = configured
  await ctx.loader.create({ name: 'cordis:jubian', config: {
    ledgerRoot: home, workspaceSecrets: false, existingVideoAdvisory,
  } })
  await ctx.loader.await()
  for (const entry of ctx.loader.entries()) await entry.fiber?.await()
  await ctx.plugin(Llm); await ctx.plugin(Sessions); await ctx.plugin(SessionProjections)
  await ctx.plugin(AgentRegistry); await ctx.plugin(AgentLoop, { agents: [] })
  return configured
}

function notices(agent: Agent) {
  return agent.session.snapshotEvents().filter(event => event.type === 'user/message')
    .filter(event => event.data.source.kind === 'jubian-video-reuse')
}

async function send(agent: Agent, text: string) {
  agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text }] }))
  await agent.whenIdle()
}

it('logs one notice before the first request, permits a tool call, and removes the hook with its plugin', async () => {
  const { ctx, home } = await fixture()
  const submissions: number[] = []
  ctx.effect(() => ctx.tools.register(defineContentToolFixture({
    name: 'fixture_submit_video', description: 'Local counter only; never contacts a provider or spends money.',
    parameters: { storyboard_id: { type: 'number', required: true } },
    execute: async (args) => {
      submissions.push(args.storyboard_id)
      return [{ type: 'text', text: 'Synthetic submission completed.' }]
    },
  })))
  const extra = registerVideoReuseAdvisory(ctx)
  try {
    const adapter = new MockAdapter([
      toolCallResponse('synthetic-submit', 'fixture_submit_video', { storyboard_id: 2165139 }),
      textResponse('完成。'), textResponse('按新的生成要求处理。'), textResponse('插件已卸载。'),
    ])
    ctx.llm.registerAdapter(['mock'], adapter)
    const agent = await ctx.agentLoop.create(SessionId('video-reuse-hook'),
      { provider: 'mock', model: 'mock' }, { cwd: home })
    await send(agent, '从生出的视频提取')
    expect(submissions).toEqual([2165139])
    expect(adapter.requests).toHaveLength(2)
    expect(notices(agent)).toHaveLength(1)
    const notice = notices(agent)[0]
    expect(notice).toMatchObject({ type: 'user/message', data: {
      source: { kind: 'jubian-video-reuse', form: 'notice' },
    } })
    const offered = adapter.requests[0]!.messages.filter(message => message.source?.kind === 'jubian-video-reuse')
    expect(offered).toHaveLength(1)
    expect(notice?.data).toEqual(offered[0])
    expect(JSON.stringify(offered)).toContain('查询不完整或身份未核时保持未知')
    expect(JSON.stringify(offered)).toContain('此提示不拦截工具调用')
    expect(agent.session.snapshotEvents().filter(event => event.type === 'tool/result'))
      .toMatchObject([{ data: { message: { isError: false } } }])

    await send(agent, '现在重新生成第七集视频。')
    expect(notices(agent)).toHaveLength(1)
    extra()
    const loaded = [...ctx.loader.entries()].find(entry => entry.options.name === 'cordis:jubian')
    expect(loaded?.fiber).toBeDefined()
    await loaded!.fiber!.dispose()
    expect(ctx.tools.get('jubian_video')).toBeUndefined()
    await send(agent, '从已经生成的视频提取声线。')
    expect(notices(agent)).toHaveLength(1)
    expect(adapter.requests).toHaveLength(4)
  } finally { extra(); await ctx.fiber.dispose() }
})

it('limits advice to the latest human request and skips negative or unrelated extraction requests', async () => {
  const { ctx, home } = await fixture()
  try {
    const cases = [
      ['从已经生成的视频提取声线', true],
      ['从成片里截取王老头的声音', true],
      ['复用原片的音频', true],
      ['Extract voices from existing videos.', true],
      ['不要重新生成，直接从已有视频提取声音。', true],
      ['生成第七集视频。', false],
      ['提取剧本中的人物台词。', false],
      ['提取剧本文本，然后生成视频。', false],
      ['不要从视频中提取声音。', false],
      ['不提取音频。', false],
      ["Don't extract audio from videos.", false],
    ] as const
    const adapter = new MockAdapter([...cases.map(() => textResponse('收到。')), textResponse('收到后台通知。')])
    ctx.llm.registerAdapter(['mock'], adapter)
    const agent = await ctx.agentLoop.create(SessionId('video-reuse-applicability'),
      { provider: 'mock', model: 'mock' }, { cwd: home })
    let expected = 0
    for (const [request, applies] of cases) {
      await send(agent, request)
      expected += Number(applies)
      expect(notices(agent), request).toHaveLength(expected)
    }
    agent.followup(createUserMessage({ source: { kind: 'jubian-video-selection' },
      content: [{ type: 'text', text: '从已有视频提取声音' }] }))
    await agent.whenIdle()
    expect(notices(agent)).toHaveLength(expected)
  } finally { await ctx.fiber.dispose() }
})

it('keeps extraction requests unchanged when the deployment disables the notice', async () => {
  const { ctx, home } = await fixture(false)
  try {
    const adapter = new MockAdapter([textResponse('按已有来源处理。')])
    ctx.llm.registerAdapter(['mock'], adapter)
    const agent = await ctx.agentLoop.create(SessionId('video-reuse-disabled'),
      { provider: 'mock', model: 'mock' }, { cwd: home })
    await send(agent, '从生出的视频提取')
    expect(notices(agent)).toHaveLength(0)
    expect(adapter.requests).toHaveLength(1)
  } finally { await ctx.fiber.dispose() }
})
