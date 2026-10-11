/** Unconfirmed image candidates remain distinguishable from adopted assets in model requests. */
import { expect, it, vi } from 'vitest'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
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

it('records an active candidate without confirming its casting or charging again', async () => {
  const { ctx, home } = await configurationFixture({ hmr: false, rows: [
    { id: 'prompt', name: 'cordis:prompt' }, { id: 'tools', name: 'cordis:tools' },
    { id: 'credentials', name: 'cordis:credentials', config: { JUBIANAI_ADMIN_TOKEN: 'mock-token' } },
  ], builtins: { prompt: SystemPrompt, tools: Tools, credentials: MemoryCredentials, jubian: Jubian } })
  await writeFile(join(home, 'authorization.json'), JSON.stringify({ version: 1,
    projects: { '4672': { limit: '1', unit: 'CNY' } } }))
  const clock = vi.spyOn(Date, 'now').mockReturnValue(1_700_000_000_000)
  const requests: { url: string; method: string }[] = []
  const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = input instanceof Request ? input.url : input.toString()
    const method = init?.method ?? 'GET'
    requests.push({ url, method })
    let data: unknown
    if (url.includes('getSelectList')) data = [{ id: 66, modelId: 'gpt-image-2', platformId: 'KU_AI',
      unitPrice: 0.12, unit: '张', genTypes: [{ id: 97, type: 3 }],
      videoStandards: [{ id: 362, ratio: '16:9', resolution: '1K', width: 2048, height: 1152, genNum: 1 }] }]
    else if (method === 'POST' && url.endsWith('/aigc/asset')) data = 163126
    else if (method === 'GET' && url.endsWith('/aigc/asset/163126')) data = {
      id: 163126, name: 'EP02｜角色｜李成3D', assetType: 1, hsLocal: 0, hsAssetStatus: null }
    else if (url.includes('getGeneratedImageByAssetId?assetId=163126')) data = [{
      id: 166646, assetId: 163126, assetUrl: 'https://images.example.test/lead-3d.png',
      hsAssetStatus: 'Active', isUsed: 0 }]
    else throw new Error('Unexpected image readback request')
    return new Response(JSON.stringify({ code: 200, data }))
  })
  try {
    await ctx.loader.create({ name: 'cordis:jubian', config: {
      ledgerRoot: home, workspaceSecrets: false, imagePlatformId: 'KU_AI' } })
    await ctx.loader.await()
    for (const entry of ctx.loader.entries()) await entry.fiber?.await()
    await ctx.plugin(Llm); await ctx.plugin(SessionStore); await ctx.plugin(SessionProjections)
    await ctx.plugin(AgentRegistry); await ctx.plugin(AgentLoop, { agents: [] })
    const adapter = new MockAdapter([
      toolCallResponse('pilot', 'jubian_video', { method: 'image_generate', script_id: 4672,
        asset_name: 'EP02｜角色｜李成3D', asset_type: 1, prompt: 'Visible 3D CG character model.',
        idempotency_key: 'lead-3d-pilot' }),
      textResponse('The candidate is ready for visual review; casting has not been confirmed.'),
    ])
    ctx.llm.registerAdapter(['mock'], adapter)
    const agent = await ctx.agentLoop.create(SessionId('image-readback-owner'),
      { provider: 'mock', model: 'mock' }, { cwd: home })
    agent.followup(createUserMessage({ source: { kind: 'user' },
      content: [{ type: 'text', text: 'Generate one 3D character reference and leave casting unconfirmed.' }] }))
    await agent.whenIdle()
    const results = agent.session.snapshotEvents().filter(event => event.type === 'tool/result')
      .map(event => ({ isError: event.data.message.isError, content: event.data.message.content }))
    expect(results).toHaveLength(1)
    expect(results[0], JSON.stringify(results[0]!.content)).toMatchObject({ isError: false })
    expect(results).toMatchSnapshot('unconfirmed active image candidate')
    expect(adapter.requests).toHaveLength(2)
    expect(adapter.requests[1]!.messages.filter(message => message.role === 'tool')
      .map(message => message.content)).toEqual(results.map(result => result.content))
    expect(requests.filter(request => request.method === 'POST')).toHaveLength(1)
    expect(requests).toHaveLength(4)
  } finally {
    fetch.mockRestore()
    clock.mockRestore()
    await ctx.fiber.dispose()
  }
})
