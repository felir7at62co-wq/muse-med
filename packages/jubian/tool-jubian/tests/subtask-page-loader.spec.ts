/** Video page paths and readiness reach native model requests and generated PTC output types. */
import { JubianLedger } from '@deepseek-ai/dsh-jubian'
import * as NativeToolExecutor from '@deepseek-ai/dsh-tool-executor-native'
import { expect, it, onTestFinished, vi } from 'vitest'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import Llm, { createUserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SessionProjections from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import Tools, { validateJsonSchemaValue } from '@deepseek-ai/dsh-tools'
import { jsonSchemaToTs, renderToolsSdk } from '@deepseek-ai/dsh-tool-executor-ptc'
import { MockAdapter, textResponse, toolCallResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import { MemoryCredentials } from '../../../credentials/credentials/tests/memory.ts'
import { configurationFixture } from '../../../settings/settings/tests/configuration-fixture.ts'
import * as Jubian from '../src/index.ts'

async function fixture() {
  const configured = await configurationFixture({ hmr: false, rows: [
    { id: 'tool-executor-native', name: 'cordis:native-executor' },
    { id: 'prompt', name: 'cordis:prompt' }, { id: 'tools', name: 'cordis:tools' },
    { id: 'credentials', name: 'cordis:credentials', config: { JUBIANAI_ADMIN_TOKEN: 'mock-token' } },
  ], builtins: { 'native-executor': NativeToolExecutor, prompt: SystemPrompt, tools: Tools, credentials: MemoryCredentials, jubian: Jubian } })
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
    expect(type).toContain('storyboard_id?: number')
    expect(type).toContain('status: string | null')
    expect(type).toContain('video_url: string | null')
    expect(type).toContain('project_complete: boolean')
    expect(type).toContain('task_type: number | null')
    const sdk = renderToolsSdk([{ name: tool.name, description: tool.description, parameters: tool.parameters, output: schema }])
    expect(sdk).toContain('interface ToolOutputMap')
    expect(sdk).toContain('subtasks?: {')
    expect(sdk).toContain('result.subtasks.rows')
    const subtaskPage = { total: 1,
      queried_at: '2026-10-28T00:00:00.000Z', page_num: 1, page_size: 20, returned: 1,
      total_verified: true, complete: true, has_more: false, next_page: null, rows: [{
        subtask_id: 901, parent_task_id: 42, status: 'succeeded', video_url: 'https://media.example/video.mp4',
        resolution: '480p',
      }] }
    expect(validateJsonSchemaValue(schema, { subtasks: subtaskPage, guidance: 'read rows' }, '')).toEqual([])
    expect(validateJsonSchemaValue(schema, { subtasks: { ...subtaskPage,
      rows: [{ ...subtaskPage.rows[0], storyboard_id: 201 }] } }, '')).toEqual([])
    for (const storyboard_id of ['201', 1.5]) {
      expect(validateJsonSchemaValue(schema, { subtasks: { ...subtaskPage,
        rows: [{ ...subtaskPage.rows[0], storyboard_id }] } }, '')).not.toEqual([])
    }
    expect(validateJsonSchemaValue(schema, { task: { task_id: 42, status: 'running' } }, '')).toEqual([])
    expect(validateJsonSchemaValue(schema, { outcome: 'accepted', parent_asset_id: 12 }, '')).toEqual([])
    expect(validateJsonSchemaValue(schema, { subtasks: [] }, '')).not.toEqual([])
    expect(validateJsonSchemaValue(schema, { subtasks: { total: 1 } }, '')).not.toEqual([])
    expect(validateJsonSchemaValue(schema, { subtasks: { total: 1, rows: {} } }, '')).not.toEqual([])
    const tasks = { total: 0, rows: [], queried_at: '2026-10-28T00:00:00.000Z', page_num: 1,
      page_size: 20, returned: 0, total_verified: true, complete: true, has_more: false,
      next_page: null, scope: { script_id: 5933, task_type: null }, project_complete: true }
    expect(validateJsonSchemaValue(schema, { tasks }, '')).toEqual([])
    expect(validateJsonSchemaValue(schema, { tasks: { ...tasks, scope: undefined } }, '')).not.toEqual([])
    expect(validateJsonSchemaValue(schema, { tasks: { ...tasks, project_complete: undefined } }, '')).not.toEqual([])
    expect(validateJsonSchemaValue(schema, { tasks: { ...tasks, scope: { script_id: 5933, task_type: 'all' } } }, '')).not.toEqual([])
  } finally { await ctx.fiber.dispose() }
})

it('logs unfiltered legacy task discovery and the narrower empty type-filter scope', async () => {
  vi.useFakeTimers({ toFake: ['Date'], now: new Date('2026-11-06T06:00:00.000Z') })
  onTestFinished(() => { vi.useRealTimers() })
  const requests: string[] = []
  // Synthetic legacy row: its missing taskType makes the old implicit filter omit a readable task.
  const legacy = { id: 749810, scriptId: 5933, episodeId: 130172, taskStatus: 'succeeded', taskName: 'EP01-P3' }
  const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : input.toString())
    expect(init?.method).toBe('GET')
    requests.push(url.pathname.replace('/prod-api', '') + url.search)
    if (url.pathname.endsWith('/admin/aigc/video/task/749810')) {
      return new Response(JSON.stringify({ code: 200, data: legacy }))
    }
    if (!url.pathname.endsWith('/admin/aigc/video/task/list') || url.searchParams.get('scriptId') !== '5933') {
      throw new Error('Unexpected task inventory read')
    }
    const rows = url.searchParams.has('taskType') ? [] : [legacy]
    return new Response(JSON.stringify({ code: 200, data: { total: rows.length, rows } }))
  })
  const { ctx, home } = await fixture()
  try {
    await ctx.plugin(Llm); await ctx.plugin(SessionStore); await ctx.plugin(SessionProjections)
    await ctx.plugin(AgentRegistry); await ctx.plugin(AgentLoop, { agents: [] })
    const adapter = new MockAdapter([
      toolCallResponse('known-task', 'jubian_video', { method: 'task', task_id: 749810 }),
      toolCallResponse('project-tasks', 'jubian_video', { method: 'tasks', script_id: 5933 }),
      toolCallResponse('generation-only', 'jubian_video', { method: 'tasks', script_id: 5933, task_type: 1 }),
      textResponse('The known task exists; the empty type-filtered list is not complete project coverage.'),
    ])
    ctx.llm.registerAdapter(['mock'], adapter)
    const agent = await ctx.agentLoop.create(SessionId('task-scope-owner'),
      { provider: 'mock', model: 'mock' }, { cwd: home })
    agent.followup(createUserMessage({ source: { kind: 'user' },
      content: [{ type: 'text', text: 'Compare the known task with all project tasks and the generation-only list.' }] }))
    await agent.whenIdle()
    const results = agent.session.snapshotEvents().filter(event => event.type === 'tool/result')
      .map(event => ({ isError: event.data.message.isError, content: event.data.message.content }))
    expect(results).toHaveLength(3)
    expect(results.every(result => !result.isError)).toBe(true)
    expect(results).toMatchSnapshot('default project list and explicit empty filter')
    expect(requests).toEqual(['/admin/aigc/video/task/749810',
      '/admin/aigc/video/task/list?scriptId=5933&pageNum=1&pageSize=20',
      '/admin/aigc/video/task/list?scriptId=5933&taskType=1&pageNum=1&pageSize=20'])
    expect(adapter.requests).toHaveLength(4)
    expect(adapter.requests[3]!.messages.filter(message => message.role === 'tool')
      .map(message => message.content)).toEqual(results.map(result => result.content))
    const tool = ctx.tools.get('jubian_video')!
    expect(tool.parameters).toHaveProperty('properties.task_type')
    expect(jsonSchemaToTs(tool.output.schema)).toContain('project_complete: boolean')
  } finally {
    fetch.mockRestore()
    await ctx.fiber.dispose()
  }
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

it('keeps each merged-task child identity and readiness when the parent name has no package number', async () => {
  vi.useFakeTimers({ toFake: ['Date'], now: new Date('2026-11-19T00:00:00.000Z') })
  onTestFinished(() => { vi.useRealTimers() })
  const requests: { method: string; path: string; body: unknown }[] = []
  const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : input.toString())
    const method = String(init?.method)
    const body: unknown = typeof init?.body === 'string' ? JSON.parse(init.body) : null
    requests.push({ method, path: url.pathname, body })
    if (method === 'GET' && url.pathname.endsWith('/admin/aigc/video/task/71')) {
      return new Response(JSON.stringify({ code: 200, data: { id: 71, taskType: 1,
        taskStatus: 'succeeded', scriptId: 301, episodeId: 401, episodeCount: 7,
        taskName: '第7集-合并生成' } }))
    }
    if (method !== 'POST' || !url.pathname.endsWith('/admin/aigc/video/task/sub/list')) {
      throw new Error('Unexpected merged-task inventory request')
    }
    return new Response(JSON.stringify({ code: 200, data: { total: 5, rows: [
      { id: 101, aigcVideoTaskId: 71, storyboardId: 201, taskStatus: 'succeeded',
        resultList: [{ taskType: 1, resultStatus: 'succeeded', tosVideoUrl: 'https://media.example/first.mp4' }] },
      { id: 102, aigcVideoTaskId: 71, storyboardId: '202', taskStatus: 'running',
        resultList: [{ taskType: 1, resultStatus: 'running', tosVideoUrl: 'https://media.example/running.mp4' }] },
      { id: 103, aigcVideoTaskId: 71, storyboardId: 0, taskStatus: 'failed' },
      { id: 104, aigcVideoTaskId: 71, taskStatus: 'succeeded',
        resultList: [{ taskType: 1, resultStatus: 'succeeded', tosVideoUrl: 'https://media.example/unmapped.mp4' }] },
      { id: 105, aigcVideoTaskId: 71, storyboardId: 203, taskStatus: 'succeeded' },
    ] } }))
  })
  onTestFinished(() => { fetch.mockRestore() })
  const { ctx, home } = await fixture()
  try {
    await ctx.plugin(Llm); await ctx.plugin(SessionStore); await ctx.plugin(SessionProjections)
    await ctx.plugin(AgentRegistry); await ctx.plugin(AgentLoop, { agents: [] })
    const adapter = new MockAdapter([
      toolCallResponse('merged-parent', 'jubian_video', { method: 'task', task_id: 71 }),
      toolCallResponse('merged-children', 'jubian_video', { method: 'subtasks', task_id: 71 }),
      textResponse('Read every child; retain the unknown storyboard mapping and do not treat the running file as finished.'),
    ])
    ctx.llm.registerAdapter(['mock'], adapter)
    const agent = await ctx.agentLoop.create(SessionId('merged-task-child-owner'),
      { provider: 'mock', model: 'mock' }, { cwd: home })
    agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text',
      text: 'Inspect the merged parent and its children without generating or downloading anything.' }] }))
    await agent.whenIdle()
    const results = agent.session.snapshotEvents().filter(event => event.type === 'tool/result')
      .map(event => ({ isError: event.data.message.isError, content: event.data.message.content }))
    expect(results).toHaveLength(2)
    expect(results.every(result => !result.isError)).toBe(true)
    const text = (index: number): string => results[index]!.content
      .filter(block => block.type === 'text').map(block => block.text).join('')
    const parent: unknown = JSON.parse(text(0)), children: unknown = JSON.parse(text(1))
    expect(parent).toMatchObject({ task: { task_id: 71, task_name: '第7集-合并生成' } })
    expect(children).toMatchObject({ subtasks: { total: 5, returned: 5, complete: true, rows: [
      { subtask_id: 101, parent_task_id: 71, storyboard_id: 201, status: 'succeeded',
        video_url: 'https://media.example/first.mp4' },
      { subtask_id: 102, parent_task_id: 71, storyboard_id: 202, status: 'running',
        video_url: 'https://media.example/running.mp4' },
      { subtask_id: 103, parent_task_id: 71, status: 'failed', video_url: null },
      { subtask_id: 104, parent_task_id: 71, status: 'succeeded',
        video_url: 'https://media.example/unmapped.mp4' },
      { subtask_id: 105, parent_task_id: 71, storyboard_id: 203, status: 'succeeded', video_url: null },
    ] } })
    expect(children).not.toHaveProperty('subtasks.rows.2.storyboard_id')
    expect(children).not.toHaveProperty('subtasks.rows.3.storyboard_id')
    expect(text(1)).toContain('本页有 2 项属于本任务、已成功且带 video_url 的结果')
    expect(validateJsonSchemaValue(ctx.tools.get('jubian_video')!.output.schema, children, '')).toEqual([])
    expect(adapter.requests).toHaveLength(3)
    expect(adapter.requests[2]!.messages.filter(message => message.role === 'tool')
      .map(message => message.content)).toEqual(results.map(result => result.content))
    expect(requests).toEqual([
      { method: 'GET', path: '/prod-api/admin/aigc/video/task/71', body: null },
      { method: 'POST', path: '/prod-api/admin/aigc/video/task/sub/list', body: { aigcVideoTaskId: 71 } },
    ])
  } finally {
    fetch.mockRestore()
    await ctx.fiber.dispose()
  }
})

it('logs provider-limited empty discovery before reading a known task without changing its original key', async () => {
  vi.useFakeTimers({ toFake: ['Date'], now: new Date('2026-11-06T06:00:00.000Z') })
  onTestFinished(() => { vi.useRealTimers() })
  const requests: { method: string; path: string }[] = []
  const known = { id: 749810, scriptId: 5933, episodeId: 130172, taskStatus: 'succeeded', taskName: 'EP01-P3' }
  const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : input.toString())
    const method = String(init?.method)
    requests.push({ method, path: url.pathname.replace('/prod-api', '') + url.search })
    if (method !== 'GET') throw new Error('Discovery must not send a paid or state-changing request')
    if (url.pathname.endsWith('/admin/aigc/video/task/749810')) {
      return new Response(JSON.stringify({ code: 200, data: known }))
    }
    if (!url.pathname.endsWith('/admin/aigc/video/task/list') || url.searchParams.get('scriptId') !== '5933') {
      throw new Error('Unexpected task discovery read')
    }
    return new Response(JSON.stringify({ code: 200, data: { total: 0, rows: [] } }))
  })
  onTestFinished(() => { fetch.mockRestore() })
  const { ctx, home } = await fixture()
  try {
    const ledger = new JubianLedger({ root: home })
    const originalKey = 'known-original-video-key'
    await ledger.begin({ idempotencyKey: originalKey, method: 'storyboard_generate',
      scriptId: 5933, requestSha256: 'original-request', beforeTaskIds: [] })
    const before = await ledger.records()
    await ctx.plugin(Llm); await ctx.plugin(SessionStore); await ctx.plugin(SessionProjections)
    await ctx.plugin(AgentRegistry); await ctx.plugin(AgentLoop, { agents: [] })
    const adapter = new MockAdapter([
      toolCallResponse('generation-only', 'jubian_video', { method: 'tasks', script_id: 5933, task_type: 1 }),
      toolCallResponse('empty-project-list', 'jubian_video', { method: 'tasks', script_id: 5933 }),
      toolCallResponse('known-original-task', 'jubian_video', { method: 'task', task_id: 749810 }),
      toolCallResponse('original-key', 'jubian_video', { method: 'unresolved', script_id: 5933 }),
      textResponse('The provider list is empty, but known task 749810 is readable. Retain known-original-video-key; do not pay for regeneration.'),
    ])
    ctx.llm.registerAdapter(['mock'], adapter)
    const agent = await ctx.agentLoop.create(SessionId('empty-provider-known-task-owner'),
      { provider: 'mock', model: 'mock' }, { cwd: home })
    agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text',
      text: 'Read project 5933 and known task 749810. Preserve known-original-video-key and do not submit generation.' }] }))
    await agent.whenIdle()
    const results = agent.session.snapshotEvents().filter(event => event.type === 'tool/result')
      .map(event => ({ isError: event.data.message.isError, content: event.data.message.content }))
    expect(results).toHaveLength(4)
    expect(results.every(result => !result.isError)).toBe(true)
    const text = (index: number): string => results[index]!.content
      .filter(block => block.type === 'text').map(block => block.text).join('')
    const filtered: unknown = JSON.parse(text(0)), unfiltered: unknown = JSON.parse(text(1))
    expect(filtered).toMatchObject({ tasks: { rows: [], complete: true, project_complete: false,
      total_verified: true, scope: { script_id: 5933, task_type: 1 } } })
    expect(unfiltered).toMatchObject({ tasks: { rows: [], complete: true, project_complete: true,
      total_verified: true, scope: { script_id: 5933, task_type: null } } })
    expect(text(1)).toContain('不保证保留全部历史')
    expect(text(2)).toContain('749810')
    expect(text(3)).toContain(originalKey)
    expect(results.slice(0, 3)).toMatchSnapshot('empty provider list followed by known original task and key')
    expect(adapter.requests).toHaveLength(5)
    expect(adapter.requests[4]!.messages.filter(message => message.role === 'tool')
      .map(message => message.content)).toEqual(results.map(result => result.content))
    expect(requests).toEqual([
      { method: 'GET', path: '/admin/aigc/video/task/list?scriptId=5933&taskType=1&pageNum=1&pageSize=20' },
      { method: 'GET', path: '/admin/aigc/video/task/list?scriptId=5933&pageNum=1&pageSize=20' },
      { method: 'GET', path: '/admin/aigc/video/task/749810' },
    ])
    expect(await ledger.records()).toEqual(before)
  } finally {
    fetch.mockRestore()
    await ctx.fiber.dispose()
  }
})

it('reads existing sources and the original ledger key when a model fills the entire video form', async () => {
  const requests: { method: string; path: string; body: unknown }[] = []
  const task = { id: 77, scriptId: 301, storyboardId: 201, taskType: 1, taskStatus: 'succeeded' }
  const child = { id: 88, aigcVideoTaskId: 77, scriptId: 301, storyboardId: 201, taskStatus: 'succeeded',
    resolution: '720p', resultList: [{ firstResultId: 99, tosVideoUrl: 'https://media.example/original.mp4' }] }
  const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : input.toString())
    const method = String(init?.method)
    const path = url.pathname.replace('/prod-api', '') + url.search
    const body: unknown = typeof init?.body === 'string' ? JSON.parse(init.body) : null
    requests.push({ method, path, body })
    const respond = (data: unknown) => new Response(JSON.stringify({ code: 200, data }))
    if (method === 'GET') {
      if (path === '/aigc/storyboard/201') return respond({ id: 201, scriptId: 301 })
      if (path === '/aigc/storyboard/byStoryboard/201') return respond([task])
      if (path === '/admin/aigc/video/task/77') return respond(task)
      if (path === '/admin/aigc/video/task/list?scriptId=301&taskType=1&pageNum=1&pageSize=1000') {
        return respond({ total: 1, rows: [task] })
      }
      if (path === '/admin/aigc/video/task/list?scriptId=301&taskType=20&pageNum=1&pageSize=1') {
        return respond({ total: 2, rows: [{ id: 91, scriptId: 301, episodeId: 55, taskType: 20, parentResultId: 89 }] })
      }
      if (path === '/admin/aigc/video/task/list?scriptId=301&taskType=20&pageNum=2&pageSize=1') {
        return respond({ total: 2, rows: [{ id: 90, scriptId: 301, episodeId: 55, taskType: 20, parentResultId: 88 }] })
      }
    }
    if (method === 'POST' && url.pathname.endsWith('/admin/aigc/video/task/sub/list')) {
      return respond({ total: 1, rows: [child] })
    }
    throw new Error('Unexpected Jubian provider request')
  })
  onTestFinished(() => { fetch.mockRestore() })
  const { ctx, home } = await fixture()
  try {
    const ledger = new JubianLedger({ root: home })
    const originalKey = 'original-video-generation'
    await ledger.begin({ idempotencyKey: originalKey, method: 'storyboard_generate',
      scriptId: 301, requestSha256: 'original-request', beforeTaskIds: [] })
    const before = await ledger.records()
    await ctx.plugin(Llm); await ctx.plugin(SessionStore); await ctx.plugin(SessionProjections)
    await ctx.plugin(AgentRegistry); await ctx.plugin(AgentLoop, { agents: [] })
    const character_reference = { authorization_id: '', authorization_version: 1, character_id: '',
      catalog_asset_id: '', image_sha256: '', managed_reference_id: '' }
    const form = { asset_category: '角色', asset_name: '', asset_type: 1, character_reference,
      delivery_resolution: '', episode: '', idempotency_key: '', image_aspect_ratio: '16:9',
      image_model_id: '', image_platform_id: '', image_resolution: '', image_spec_id: 0, image_style: 'live_action',
      items: [], model_id: '', package_number: '', page_num: 1, page_size: 20, parent_asset_id: 0,
      platform_id: '', prompt: '', references: [], resolution: '', script_id: 301, storyboard_id: 201,
      task_id: 0, task_name: '', task_type: 0 }
    const adapter = new MockAdapter([
      toolCallResponse('original-card-sources', 'jubian_video', { ...form, method: 'sources' }),
      toolCallResponse('generation-task-list', 'jubian_video', { ...form, method: 'tasks',
        character_reference: { ...character_reference, authorization_version: 0 }, storyboard_id: 0,
        page_size: 1000, task_type: 1 }),
      toolCallResponse('existing-upscale', 'jubian_video', { ...form, method: 'tasks',
        page_size: 1, task_type: 20, parent_result_id: 88 }),
      toolCallResponse('original-key', 'jubian_video', { ...form, method: 'unresolved' }),
      textResponse('Existing card sources and the pending generation record were read.'),
    ])
    ctx.llm.registerAdapter(['mock'], adapter)
    const agent = await ctx.agentLoop.create(SessionId('existing-card-filled-video-form'),
      { provider: 'mock', model: 'mock' }, { cwd: home })
    agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text',
      text: 'Read the card history, generation task list, and pending ledger without generating another video.' }] }))
    await agent.whenIdle()
    const results = agent.session.snapshotEvents().filter(event => event.type === 'tool/result')
      .map(event => event.data.message)
    expect(results.map(result => result.isError)).toEqual([false, false, false, false])
    const [sources, tasks, upscale, unresolved] = results.map((result): unknown =>
      JSON.parse(result.content.filter(block => block.type === 'text').map(block => block.text).join('')))
    expect(sources).toMatchObject({ sources: { script_id: 301, storyboard_id: 201, status: 'available', complete: true,
      sources: [{ task_id: 77, subtask_id: 88, video_url: 'https://media.example/original.mp4' }] } })
    expect(tasks).toMatchObject({ tasks: { scope: { script_id: 301, task_type: 1 },
      project_complete: false, rows: [{ task_id: 77 }] } })
    expect(upscale).toMatchObject({ tasks: { scope: { script_id: 301, task_type: 20, parent_result_id: 88 },
      complete: true, project_complete: false, pages_read: 2, rows: [{ task_id: 90, parent_result_id: 88 }] } })
    expect(unresolved).toMatchObject({ unresolved: [{ idempotency_key: originalKey, outcome: 'unsettled' }] })
    expect(requests).toEqual([
      { method: 'GET', path: '/aigc/storyboard/201', body: null },
      { method: 'GET', path: '/aigc/storyboard/byStoryboard/201', body: null },
      { method: 'GET', path: '/admin/aigc/video/task/77', body: null },
      { method: 'POST', path: '/admin/aigc/video/task/sub/list?pageNum=1&pageSize=100&orderByColumn=createTime&orderBy=desc',
        body: { aigcVideoTaskId: 77 } },
      { method: 'GET', path: '/admin/aigc/video/task/list?scriptId=301&taskType=1&pageNum=1&pageSize=1000', body: null },
      { method: 'GET', path: '/admin/aigc/video/task/list?scriptId=301&taskType=20&pageNum=1&pageSize=1', body: null },
      { method: 'GET', path: '/admin/aigc/video/task/list?scriptId=301&taskType=20&pageNum=2&pageSize=1', body: null },
    ])
    expect(await ledger.records()).toEqual(before)
  } finally { await ctx.fiber.dispose() }
})
