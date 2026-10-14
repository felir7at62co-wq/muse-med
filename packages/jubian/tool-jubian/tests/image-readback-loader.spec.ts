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
  let submittedStyle: unknown
  const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = input instanceof Request ? input.url : input.toString()
    const method = init?.method ?? 'GET'
    requests.push({ url, method })
    if (method === 'POST' && typeof init?.body === 'string') {
      const body: unknown = JSON.parse(init.body)
      if (body !== null && typeof body === 'object' && 'modelConfig' in body && typeof body.modelConfig === 'string') {
        const model: unknown = JSON.parse(body.modelConfig)
        if (model !== null && typeof model === 'object' && 'style' in model) submittedStyle = model.style
      }
    }
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
        asset_name: 'EP02｜角色｜李成3D', asset_type: 1, image_style: 'anime', prompt: '3D动漫／风格化三维动画，Visible 3D CG character model.',
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
    expect(submittedStyle).toBe(1)
    expect(requests).toHaveLength(4)
  } finally {
    fetch.mockRestore()
    clock.mockRestore()
    await ctx.fiber.dispose()
  }
})

it('logs a failed image task with its original identity instead of an envelope error', async () => {
  const { ctx, home } = await configurationFixture({ hmr: false, rows: [
    { id: 'prompt', name: 'cordis:prompt' }, { id: 'tools', name: 'cordis:tools' },
    { id: 'credentials', name: 'cordis:credentials', config: { JUBIANAI_ADMIN_TOKEN: 'mock-token' } },
  ], builtins: { prompt: SystemPrompt, tools: Tools, credentials: MemoryCredentials, jubian: Jubian } })
  const requests: string[] = []
  const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = input instanceof Request ? input.url : input.toString()
    if (init?.method !== 'GET' || !url.endsWith('getGeneratedImageByAssetId?assetId=163134')) {
      throw new Error('Unexpected image task read')
    }
    requests.push(url)
    return new Response(JSON.stringify({ code: 200, data: [{ assetId: 163134, id: null, assetUrl: null,
      taskId: 545217, resultId: 1104411, resultStatus: 'failed',
      resultMsg: '酷爱AI平台创建生图任务失败: 最多输入5张图' }] }))
  })
  try {
    await ctx.loader.create({ name: 'cordis:jubian', config: { ledgerRoot: home, workspaceSecrets: false } })
    await ctx.loader.await()
    for (const entry of ctx.loader.entries()) await entry.fiber?.await()
    await ctx.plugin(Llm); await ctx.plugin(SessionStore); await ctx.plugin(SessionProjections)
    await ctx.plugin(AgentRegistry); await ctx.plugin(AgentLoop, { agents: [] })
    const adapter = new MockAdapter([
      toolCallResponse('read-failed', 'jubian_asset', { method: 'generated_image', asset_id: 163134 }),
      textResponse('The original task failed; reduce the reference count before preparing a revised request.'),
    ])
    ctx.llm.registerAdapter(['mock'], adapter)
    const agent = await ctx.agentLoop.create(SessionId('image-failure-owner'),
      { provider: 'mock', model: 'mock' }, { cwd: home })
    agent.followup(createUserMessage({ source: { kind: 'user' },
      content: [{ type: 'text', text: 'Read the existing image task. Do not regenerate it.' }] }))
    await agent.whenIdle()
    const results = agent.session.snapshotEvents().filter(event => event.type === 'tool/result')
      .map(event => ({ isError: event.data.message.isError, content: event.data.message.content }))
    expect(results).toHaveLength(1)
    expect(results[0]).toMatchObject({ isError: false })
    expect(results).toMatchSnapshot('failed original image task')
    expect(adapter.requests).toHaveLength(2)
    expect(adapter.requests[1]!.messages.filter(message => message.role === 'tool')
      .map(message => message.content)).toEqual(results.map(result => result.content))
    expect(requests).toHaveLength(1)
  } finally {
    fetch.mockRestore()
    await ctx.fiber.dispose()
  }
})

it('tells the model to create a missing reference file before any upload', async () => {
  const { ctx, home } = await configurationFixture({ hmr: false, rows: [
    { id: 'prompt', name: 'cordis:prompt' }, { id: 'tools', name: 'cordis:tools' },
    { id: 'credentials', name: 'cordis:credentials', config: { JUBIANAI_ADMIN_TOKEN: 'mock-token' } },
  ], builtins: { prompt: SystemPrompt, tools: Tools, credentials: MemoryCredentials, jubian: Jubian } })
  const fetch = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Unexpected reference upload request'))
  const imagePath = join(home, 'private-reference-directory', 'missing-panorama.png')
  try {
    await ctx.loader.create({ name: 'cordis:jubian', config: { ledgerRoot: home, workspaceSecrets: false } })
    await ctx.loader.await()
    for (const entry of ctx.loader.entries()) await entry.fiber?.await()
    await ctx.plugin(Llm); await ctx.plugin(SessionStore); await ctx.plugin(SessionProjections)
    await ctx.plugin(AgentRegistry); await ctx.plugin(AgentLoop, { agents: [] })
    const adapter = new MockAdapter([
      toolCallResponse('upload-missing-reference', 'jubian_asset', { method: 'upload_reference', image_path: imagePath }),
      textResponse('The local reference file is missing. Verify the image export before retrying the upload.'),
    ])
    ctx.llm.registerAdapter(['mock'], adapter)
    const agent = await ctx.agentLoop.create(SessionId('missing-reference-owner'),
      { provider: 'mock', model: 'mock' }, { cwd: home })
    agent.followup(createUserMessage({ source: { kind: 'user' },
      content: [{ type: 'text', text: 'Upload the locally exported positioning reference.' }] }))
    await agent.whenIdle()
    const results = agent.session.snapshotEvents().filter(event => event.type === 'tool/result')
      .map(event => ({ isError: event.data.message.isError, content: event.data.message.content }))
    expect(results).toHaveLength(1)
    expect(results[0]).toMatchObject({ isError: true })
    expect(results).toMatchSnapshot('missing local reference before upload')
    const serialized = JSON.stringify(results)
    expect(serialized).toContain('image_path points to a missing local file')
    expect(serialized).toContain('verify the previous step created the image at that path')
    expect(serialized).toContain('no upload was attempted')
    expect(serialized).not.toContain(home)
    expect(serialized).not.toContain('private-reference-directory')
    expect(serialized).not.toContain('missing-panorama.png')
    expect(serialized).not.toContain('mock-token')
    expect(serialized).not.toContain('expected envelope')
    expect(adapter.requests).toHaveLength(2)
    expect(adapter.requests[1]!.messages.filter(message => message.role === 'tool')
      .map(message => message.content)).toEqual(results.map(result => result.content))
    expect(fetch).not.toHaveBeenCalled()
  } finally {
    fetch.mockRestore()
    await ctx.fiber.dispose()
  }
})
