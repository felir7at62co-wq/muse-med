/** Unverified creation references are refused; the model can create and select official assets afterward. */
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

it('records the refusal and recovers through official subject selection without generating', async () => {
  const { ctx, home } = await configurationFixture({ hmr: false, rows: [
    { id: 'prompt', name: 'cordis:prompt' }, { id: 'tools', name: 'cordis:tools' },
    { id: 'credentials', name: 'cordis:credentials', config: { JUBIANAI_ADMIN_TOKEN: 'mock-token' } },
  ], builtins: { prompt: SystemPrompt, tools: Tools, credentials: MemoryCredentials, jubian: Jubian } })
  const url = 'https://example.test/official-character.jpg'
  const emptyBody = { scriptId: 2708, episodeId: 1, storyboardName: 'EP01-P1', sortOrder: 0,
    modelConfig: JSON.stringify({ prompt: '@[林子明](lead) 走进茶社', materialList: [] }), storyboardMaterialList: [] }
  let board: Record<string, unknown> = { ...emptyBody, id: 916953 }
  const writes: { method: string; body: Record<string, unknown> }[] = []
  const transport = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const path = new URL(input instanceof Request ? input.url : input.toString()).pathname
    const method = init?.method ?? 'GET'
    let data: unknown
    if (method === 'POST' && path.endsWith('/aigc/storyboard')) {
      if (typeof init?.body !== 'string') throw new Error('Expected a JSON request body')
      const body = JSON.parse(init.body) as Record<string, unknown>
      writes.push({ method, body }); board = { ...body, id: 916953 }; data = 916953
    } else if (method === 'PUT' && path.endsWith('/aigc/storyboard')) {
      if (typeof init?.body !== 'string') throw new Error('Expected a JSON request body')
      const body = JSON.parse(init.body) as Record<string, unknown>
      writes.push({ method, body }); board = body; data = null
    } else if (method === 'GET' && path.endsWith('/aigc/storyboard/916953')) data = board
    else if (method === 'GET' && path.endsWith('/aigc/material/list')) data = { total: 1, rows: [
      { id: 1, scriptId: 2708, assetId: 81285, hsAssetId: 'official-lead', assetUrl: url,
        assetName: '林子明', assetType: 1, hsAssetStatus: 'Active', isUsed: 1 },
    ] }
    else if (method === 'GET' && path.endsWith('/aigc/asset/81285')) data = {
      id: 81285, scriptId: 2708, assetType: 1, assetName: '林子明', assetUrl: url, delFlag: 0,
    }
    else if (method === 'GET' && path.endsWith('/video/task/list')) data = { total: 0, rows: [] }
    else throw new Error('Unexpected material identity request: ' + method + ' ' + path)
    return new Response(JSON.stringify({ code: 200, data }))
  })
  try {
    await ctx.loader.create({ name: 'cordis:jubian', config: { ledgerRoot: home, workspaceSecrets: false } })
    await ctx.loader.await()
    for (const entry of ctx.loader.entries()) await entry.fiber?.await()
    await ctx.plugin(Llm); await ctx.plugin(SessionStore); await ctx.plugin(SessionProjections)
    await ctx.plugin(AgentRegistry); await ctx.plugin(AgentLoop, { agents: [] })
    const adapter = new MockAdapter([
      toolCallResponse('unchecked-create', 'jubian_storyboard', { method: 'create', idempotency_key: 'unchecked',
        body: { ...emptyBody, storyboardMaterialList: [{ assetId: 'unrelated', materialAssetId: 123,
          fileName: '林子明', materialType: 'image', materialUrl: 'https://example.test/hall.jpg', materialKey: 'lead' }] } }),
      toolCallResponse('empty-create', 'jubian_storyboard', { method: 'create', idempotency_key: 'empty', body: emptyBody }),
      toolCallResponse('official-select', 'jubian_storyboard', { method: 'select_assets', idempotency_key: 'official',
        storyboard_id: 916953, selections: [{ material_key: 'lead', asset_id: 81285 }] }),
      textResponse('The unchecked reference was not written. The card now uses the verified project character; no video was generated.'),
    ])
    ctx.llm.registerAdapter(['mock'], adapter)
    const agent = await ctx.agentLoop.create(SessionId('material-identity-owner'), { provider: 'mock', model: 'mock' }, { cwd: home })
    agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Create this card with the correct character reference. Do not generate video.' }] }))
    await agent.whenIdle()
    const results = agent.session.snapshotEvents().filter(event => event.type === 'tool/result')
      .map(event => ({ isError: event.data.message.isError, content: event.data.message.content }))
    expect(results.map(result => Boolean(result.isError))).toEqual([true, false, false])
    expect(results[0]).toMatchSnapshot('unverified material refusal before creation')
    expect(adapter.requests).toHaveLength(4)
    expect(adapter.requests[1]!.messages.filter(message => message.role === 'tool').map(message => message.content))
      .toEqual([results[0]!.content])
    expect(writes.map(write => write.method)).toEqual(['POST', 'PUT'])
    expect(writes.every(write => write.body.isGenerate === 0)).toBe(true)
    expect(writes[0]!.body.storyboardMaterialList).toEqual([])
    expect(writes[1]!.body.storyboardMaterialList).toEqual([
      { assetId: 'official-lead', materialAssetId: 81285, fileName: '林子明', materialKey: 'lead',
        materialType: 'image', materialUrl: url, sortOrder: 1 },
    ])
  } finally {
    transport.mockRestore()
    await ctx.fiber.dispose()
  }
})
