/** Project settings and display episode numbers reach the next model request through the Loader. */
import { expect, it, vi } from 'vitest'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import Llm, { createUserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SessionProjections from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import Tools from '@deepseek-ai/dsh-tools'
import { MockAdapter, textResponse, toolCallResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import { MemoryCredentials } from '../../../credentials/credentials/tests/memory.ts'
import { configurationFixture } from '../../../settings/settings/tests/configuration-fixture.ts'
import * as Jubian from '../src/index.ts'

it('records saved global settings and display episode numbers without remote writes', async () => {
  const { ctx, home } = await configurationFixture({ hmr: false, rows: [
    { id: 'prompt', name: 'cordis:prompt' }, { id: 'tools', name: 'cordis:tools' },
    { id: 'credentials', name: 'cordis:credentials', config: { JUBIANAI_ADMIN_TOKEN: 'mock-token' } },
  ], builtins: { prompt: SystemPrompt, tools: Tools, credentials: MemoryCredentials, jubian: Jubian } })
  const requests: string[] = []
  const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    expect(init?.method).toBe('GET')
    const url = input instanceof Request ? input.url : input.toString()
    requests.push(url)
    let data: unknown
    if (url.endsWith('/aigc/script/4672')) data = { id: 4672, scriptName: '重生八零',
      globalConfig: JSON.stringify({ modelId: 'doubao-seedance-2-5-260628', platformId: 'FANG_ZHOU',
        ratio: '9:16', resolution: '480p' }) }
    else if (url.includes('/aigc/episode/list?')) data = { total: 300, rows: [
      { id: 93257, episodeCount: 3, episodeName: '分家' },
      { id: 93256, episodeCount: 2, episodeName: null },
    ] }
    else throw new Error('Unexpected catalogue request')
    return new Response(JSON.stringify({ code: 200, data }))
  })
  try {
    await ctx.loader.create({ name: 'cordis:jubian', config: { ledgerRoot: home, workspaceSecrets: false } })
    await ctx.loader.await()
    for (const entry of ctx.loader.entries()) await entry.fiber?.await()
    await ctx.plugin(Llm); await ctx.plugin(SessionStore); await ctx.plugin(SessionProjections)
    await ctx.plugin(AgentRegistry); await ctx.plugin(AgentLoop, { agents: [] })
    const adapter = new MockAdapter([
      toolCallResponse('project', 'jubian_catalog', { method: 'script', script_id: 4672 }),
      toolCallResponse('episodes', 'jubian_catalog', { method: 'episodes', script_id: 4672 }),
      textResponse('Episode 2 uses remote ID 93256; the saved project ratio remains 9:16.'),
    ])
    ctx.llm.registerAdapter(['mock'], adapter)
    const agent = await ctx.agentLoop.create(SessionId('catalog-owner'),
      { provider: 'mock', model: 'mock' }, { cwd: home })
    agent.followup(createUserMessage({ source: { kind: 'user' },
      content: [{ type: 'text', text: 'Read this project and identify its second episode.' }] }))
    await agent.whenIdle()
    const results = agent.session.snapshotEvents().filter(event => event.type === 'tool/result')
      .map(event => ({ isError: event.data.message.isError, content: event.data.message.content }))
    expect(results).toHaveLength(2)
    expect(results.every(result => !result.isError)).toBe(true)
    expect(results).toMatchSnapshot('read-only project and episode discovery')
    expect(adapter.requests).toHaveLength(3)
    expect(adapter.requests[2]!.messages.filter(message => message.role === 'tool')
      .map(message => message.content)).toEqual(results.map(result => result.content))
    expect(requests).toHaveLength(2)
  } finally {
    fetch.mockRestore()
    await ctx.fiber.dispose()
  }
})
