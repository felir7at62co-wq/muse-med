/** Video page paths and readiness reach native model requests and generated PTC output types. */
import { expect, it, onTestFinished, vi } from 'vitest'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import Llm, { createUserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SessionProjections from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import Tools, { jsonSchemaToTs, renderToolsSdk, validateJsonSchemaValue } from '@deepseek-ai/dsh-tools'
import { MockAdapter, textResponse, toolCallResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import { MemoryCredentials } from '../../../credentials/credentials/tests/memory.ts'
import { configurationFixture } from '../../../settings/settings/tests/configuration-fixture.ts'
import * as Jubian from '../src/index.ts'

async function fixture() {
  const configured = await configurationFixture({ hmr: false, rows: [
    { id: 'prompt', name: 'cordis:prompt' }, { id: 'tools', name: 'cordis:tools' },
    { id: 'credentials', name: 'cordis:credentials', config: { JUBIANAI_ADMIN_TOKEN: 'mock-token' } },
  ], builtins: { prompt: SystemPrompt, tools: Tools, credentials: MemoryCredentials, jubian: Jubian } })
  await configured.ctx.loader.create({ name: 'cordis:jubian', config: {
    ledgerRoot: configured.home, workspaceSecrets: false } })
  await configured.ctx.loader.await()
  for (const entry of configured.ctx.loader.entries()) await entry.fiber?.await()
  return configured
}

it('exposes subtask rows in PTC output types while accepting other video-method results', async () => {
  const { ctx } = await fixture()
  try {
    const tool = ctx.tools.get('jubian_video')!
    const schema = tool.output.schema
    const type = jsonSchemaToTs(schema)
    expect(type).toMatchSnapshot('video output type with paged subtask rows')
    expect(type).toContain('subtasks?: {')
    expect(type).toContain('rows: (')
    expect(type).toContain('parent_task_id: number | null')
    expect(type).toContain('status: string | null')
    expect(type).toContain('video_url: string | null')
    const sdk = renderToolsSdk([{ name: tool.name, description: tool.description, parameters: tool.parameters, output: schema }])
    expect(sdk).toContain('interface ToolOutputMap')
    expect(sdk).toContain('subtasks?: {')
    expect(sdk).toContain('result.subtasks.rows')
    expect(validateJsonSchemaValue(schema, { subtasks: { total: 1,
      queried_at: '2026-10-28T00:00:00.000Z', page_num: 1, page_size: 20, returned: 1,
      total_verified: true, complete: true, has_more: false, next_page: null, rows: [{
        subtask_id: 901, parent_task_id: 42, status: 'succeeded', video_url: 'https://media.example/video.mp4',
        resolution: '480p',
      }] }, guidance: 'read rows' }, '')).toEqual([])
    expect(validateJsonSchemaValue(schema, { task: { task_id: 42, status: 'running' } }, '')).toEqual([])
    expect(validateJsonSchemaValue(schema, { outcome: 'accepted', parent_asset_id: 12 }, '')).toEqual([])
    expect(validateJsonSchemaValue(schema, { subtasks: [] }, '')).not.toEqual([])
    expect(validateJsonSchemaValue(schema, { subtasks: { total: 1 } }, '')).not.toEqual([])
    expect(validateJsonSchemaValue(schema, { subtasks: { total: 1, rows: {} } }, '')).not.toEqual([])
  } finally { await ctx.fiber.dispose() }
})

it.each(['succeeded', 'running', 'failed'])('logs the actual %s child page and its download guidance into the next model request', async (status) => {
  vi.useFakeTimers({ toFake: ['Date'], now: new Date('2026-10-28T00:00:00.000Z') })
  onTestFinished(() => { vi.useRealTimers() })
  const requests: { method: string; path: string; body: unknown }[] = []
  const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : input.toString())
    if (typeof init?.body !== 'string') throw new Error('Expected a JSON subtask query body')
    const body: unknown = JSON.parse(init.body)
    requests.push({ method: String(init?.method), path: url.pathname, body })
    if (init?.method !== 'POST' || !url.pathname.endsWith('/admin/aigc/video/task/sub/list')) {
      throw new Error('Unexpected subtask page request')
    }
    return new Response(JSON.stringify({ code: 200, data: { total: 8, rows: [{
      id: 1097112, aigcVideoTaskId: 545240, taskStatus: status, duration: 13, genNum: 1,
      modelId: 'doubao-seedance-2-5-260628', standardId: 61, resolution: '480p',
      firstResultId: 1104434, resultList: [{ firstResultId: 1104434, taskType: 1, lastTaskType: 1,
        resultStatus: status, hdCount: 0, tosVideoUrl: 'https://media.example/task-545240.mp4' }],
    }] } }))
  })
  const { ctx, home } = await fixture()
  try {
    await ctx.plugin(Llm); await ctx.plugin(SessionStore); await ctx.plugin(SessionProjections)
    await ctx.plugin(AgentRegistry); await ctx.plugin(AgentLoop, { agents: [] })
    const adapter = new MockAdapter([
      toolCallResponse('read-original-task', 'jubian_video', { method: 'subtasks', task_id: 545240, delivery_resolution: '480p' }),
      textResponse('Inspect subtasks.rows and keep each child status with its original task identity.'),
    ])
    ctx.llm.registerAdapter(['mock'], adapter)
    const agent = await ctx.agentLoop.create(SessionId(`subtask-page-${status}`),
      { provider: 'mock', model: 'mock' }, { cwd: home })
    agent.followup(createUserMessage({ source: { kind: 'user' },
      content: [{ type: 'text', text: 'Read the original video task and identify downloadable results.' }] }))
    await agent.whenIdle()
    const results = agent.session.snapshotEvents().filter(event => event.type === 'tool/result')
      .map(event => ({ isError: event.data.message.isError, content: event.data.message.content }))
    expect(results).toHaveLength(1)
    expect(results[0], JSON.stringify(results)).toMatchObject({ isError: false })
    expect(results).toMatchSnapshot(`${status} paged video results`)
    const serialized = JSON.stringify(results)
    expect(serialized).toContain('subtasks.rows')
    expect(serialized).toContain('https://media.example/task-545240.mp4')
    expect(serialized).toContain(`本页有 ${status === 'succeeded' ? 1 : 0} 项属于本任务、已成功且带 video_url 的结果`)
    expect(serialized).toContain('仿真人剧默认使用原片，不自动转高清。')
    expect(serialized).toContain('1080p 是高清目标档位，不承诺精确 1080×1920；实际宽高以输出文件探测为准，不能仅凭档位宣称精确像素或画质改善。')
    expect(adapter.requests).toHaveLength(2)
    const videoDescription = adapter.requests[0]!.tools?.find(tool => tool.name === 'jubian_video')?.description
    expect(videoDescription).toContain('result.subtasks.rows')
    expect(videoDescription).toContain('仿真人剧默认使用原片，不自动转高清。')
    expect(videoDescription).toContain('1080p 是高清目标档位，不承诺精确 1080×1920；实际宽高以输出文件探测为准，不能仅凭档位宣称精确像素或画质改善。')
    expect(adapter.requests[1]!.messages.filter(message => message.role === 'tool')
      .map(message => message.content)).toEqual(results.map(result => result.content))
    expect(requests).toEqual([{ method: 'POST', path: '/prod-api/admin/aigc/video/task/sub/list', body: { aigcVideoTaskId: 545240 } }])
  } finally {
    fetch.mockRestore()
    await ctx.fiber.dispose()
  }
})
