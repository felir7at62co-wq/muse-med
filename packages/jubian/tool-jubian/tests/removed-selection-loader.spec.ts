/** Removed remote references stop selection before a write and remain visible to the next model request. */
import { expect, it, vi } from 'vitest'
import { join } from 'node:path'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { JubianLedger } from '@deepseek-ai/dsh-jubian'
import Llm, { createUserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SessionProjections from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import Tools from '@deepseek-ai/dsh-tools'
import { MockAdapter, textResponse, toolCallResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import { MemoryCredentials } from '../../../credentials/credentials/tests/memory.ts'
import { configurationFixture } from '../../../settings/settings/tests/configuration-fixture.ts'
import * as Jubian from '../src/index.ts'

it('records the removed-asset cause without writing or charging', async () => {
  const { ctx, home } = await configurationFixture({ hmr: false, rows: [
    { id: 'prompt', name: 'cordis:prompt' }, { id: 'tools', name: 'cordis:tools' },
    { id: 'credentials', name: 'cordis:credentials', config: { JUBIANAI_ADMIN_TOKEN: 'mock-token' } },
  ], builtins: { prompt: SystemPrompt, tools: Tools, credentials: MemoryCredentials, jubian: Jubian } })
  const requests: { path: string; method: string }[] = []
  const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : input.toString())
    const method = init?.method ?? 'GET'
    requests.push({ path: url.pathname, method })
    let data: unknown
    if (method === 'GET' && url.pathname.endsWith('/aigc/storyboard/1878843')) data = {
      id: 1878843, scriptId: 4672, isGenerate: 1, storyboardMaterialList: [],
      modelConfig: JSON.stringify({ prompt: '@[李成](lead)' }),
    }
    else if (method === 'GET' && url.pathname.endsWith('/aigc/material/list')) data = { rows: [], total: 0 }
    else if (method === 'GET' && url.pathname.endsWith('/aigc/asset/163129')) data = {
      id: 163129, scriptId: 4672, delFlag: '1', hsAssetStatus: 'Active',
    }
    else throw new Error('Unexpected removed-asset request')
    return new Response(JSON.stringify({ code: 200, data }))
  })
  const ledgerRoot = join(home, 'ledger')
  try {
    await ctx.loader.create({ name: 'cordis:jubian', config: { ledgerRoot, workspaceSecrets: false } })
    await ctx.loader.await()
    for (const entry of ctx.loader.entries()) await entry.fiber?.await()
    await ctx.plugin(Llm); await ctx.plugin(SessionStore); await ctx.plugin(SessionProjections)
    await ctx.plugin(AgentRegistry); await ctx.plugin(AgentLoop, { agents: [] })
    const adapter = new MockAdapter([
      toolCallResponse('removed-reference', 'jubian_storyboard', { method: 'select_assets',
        storyboard_id: 1878843, idempotency_key: 'existing-subject-selection',
        selections: [{ material_key: 'lead', asset_id: 163129 }] }),
      textResponse('The reference was removed. Refresh the existing project assets before selecting another one.'),
    ])
    ctx.llm.registerAdapter(['mock'], adapter)
    const agent = await ctx.agentLoop.create(SessionId('removed-subject-owner'),
      { provider: 'mock', model: 'mock' }, { cwd: home })
    agent.followup(createUserMessage({ source: { kind: 'user' },
      content: [{ type: 'text', text: 'Bind the selected project reference.' }] }))
    await agent.whenIdle()
    const results = agent.session.snapshotEvents().filter(event => event.type === 'tool/result')
      .map(event => ({ isError: event.data.message.isError, content: event.data.message.content }))
    expect(results).toHaveLength(1)
    expect(results[0]?.isError).toBe(true)
    expect(results).toMatchSnapshot('removed subject refusal before PUT')
    expect(adapter.requests).toHaveLength(2)
    expect(adapter.requests[1]!.messages.filter(message => message.role === 'tool')
      .map(message => message.content)).toEqual(results.map(result => result.content))
    expect(requests).toEqual([
      { path: '/prod-api/aigc/storyboard/1878843', method: 'GET' },
      { path: '/prod-api/aigc/material/list', method: 'GET' },
      { path: '/prod-api/aigc/asset/163129', method: 'GET' },
    ])
    expect(await new JubianLedger({ root: ledgerRoot }).records()).toEqual([])
  } finally {
    fetch.mockRestore()
    await ctx.fiber.dispose()
  }
})
