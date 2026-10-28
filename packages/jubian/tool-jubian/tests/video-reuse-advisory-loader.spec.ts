/** Extraction requests reach the model unchanged; historical advice remains readable. */
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

async function fixture() {
  const configured = await configurationFixture({ hmr: false, rows: [
    { id: 'prompt', name: 'cordis:prompt' }, { id: 'tools', name: 'cordis:tools' },
    { id: 'credentials', name: 'cordis:credentials' },
  ], builtins: { prompt: SystemPrompt, tools: Tools, credentials: MemoryCredentials, jubian: Jubian } })
  const { ctx, home } = configured
  await ctx.loader.create({ name: 'cordis:jubian', config: { ledgerRoot: home, workspaceSecrets: false } })
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

it('passes extraction wording unchanged without a notice and permits ordinary tool execution', async () => {
  const { ctx, home } = await fixture()
  const extracted: number[] = []
  ctx.effect(() => ctx.tools.register(defineContentToolFixture({
    name: 'fixture_extract_voice', description: 'Local counter only; no provider traffic or generation.',
    parameters: { storyboard_id: { type: 'number', required: true } },
    execute: async (args) => {
      extracted.push(args.storyboard_id)
      return [{ type: 'text', text: 'Synthetic extraction completed.' }]
    },
  })))
  try {
    const adapter = new MockAdapter([
      toolCallResponse('synthetic-extraction', 'fixture_extract_voice', { storyboard_id: 2165139 }),
      textResponse('完成。'),
    ])
    ctx.llm.registerAdapter(['mock'], adapter)
    const agent = await ctx.agentLoop.create(SessionId('existing-video-no-keyword-hook'),
      { provider: 'mock', model: 'mock' }, { cwd: home })
    await send(agent, '从生出的视频提取')
    expect(extracted).toEqual([2165139])
    expect(adapter.requests).toHaveLength(2)
    expect(notices(agent)).toEqual([])
    const human = adapter.requests[0]!.messages.filter(message => message.source?.kind === 'user')
    expect(human).toMatchObject([{ content: [{ type: 'text', text: '从生出的视频提取' }] }])
    for (const request of adapter.requests) {
      expect(request.messages.some(message => message.source?.kind === 'jubian-video-reuse')).toBe(false)
    }
    expect(agent.session.snapshotEvents().filter(event => event.type === 'tool/result'))
      .toMatchObject([{ data: { message: { isError: false } } }])
    expect(ctx.tools.get('jubian_video')).toBeDefined()
    const loaded = [...ctx.loader.entries()].find(entry => entry.options.name === 'cordis:jubian')
    await loaded!.fiber!.dispose()
    expect(ctx.tools.get('jubian_video')).toBeUndefined()
  } finally { await ctx.fiber.dispose() }
})

it('adds no extraction notices for subsequent human requests', async () => {
  const { ctx, home } = await fixture()
  try {
    const requests = ['从已经生成的视频提取声线。', '现在重新生成第七集视频。', 'Extract voices from existing videos.']
    const adapter = new MockAdapter(requests.map(() => textResponse('收到。')))
    ctx.llm.registerAdapter(['mock'], adapter)
    const agent = await ctx.agentLoop.create(SessionId('existing-video-plain-requests'),
      { provider: 'mock', model: 'mock' }, { cwd: home })
    for (const text of requests) await send(agent, text)
    expect(adapter.requests).toHaveLength(requests.length)
    expect(notices(agent)).toEqual([])
    expect(adapter.requests.at(-1)!.messages.filter(message => message.source?.kind === 'user')
      .map(message => message.content)).toEqual(requests.map(text => [{ type: 'text', text }]))
  } finally { await ctx.fiber.dispose() }
})

it('preserves a recorded historical notice on a seeded continuation without producing another notice', async () => {
  const { ctx, home } = await fixture()
  try {
    const previous = ctx.sessions.create(SessionId('historical-video-advice'), { meta: { cwd: home } })
    const historical = createUserMessage({ source: { kind: 'jubian-video-reuse', form: 'notice', summary: '历史提示' },
      content: [{ type: 'text', text: '此前版本记录的已有视频提取提示。' }] })
    previous.append('turn/start', { turn: 1 })
    previous.append('step/start', { turn: 1, step: 1 })
    previous.append('user/message', historical, { surfaceOp: 'append' })
    previous.append('step/end', { turn: 1, step: 1 })
    previous.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    const adapter = new MockAdapter([textResponse('沿用原记录继续。')])
    ctx.llm.registerAdapter(['mock'], adapter)
    const { agent } = await ctx.agents.create({ sessionId: SessionId('continued-historical-video-advice'),
      agentOptions: { provider: 'mock', model: 'mock' }, seed: previous.snapshotEvents(), meta: { cwd: home } })
    await send(agent, '从已有视频提取声音。')
    expect(notices(agent)).toHaveLength(1)
    expect(notices(agent)[0]?.data).toEqual(historical)
    expect(adapter.requests[0]!.messages.filter(message => message.source?.kind === 'jubian-video-reuse'))
      .toEqual([historical])
  } finally { await ctx.fiber.dispose() }
})
