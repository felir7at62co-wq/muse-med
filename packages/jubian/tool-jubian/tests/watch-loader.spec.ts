/** Keyless Loader/Agent evidence: a provider completion wakes an idle owner. */
import * as NativeToolExecutor from '@deepseek-ai/dsh-tool-executor-native'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import Tools from '@deepseek-ai/dsh-tools'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SessionProjections from '@deepseek-ai/dsh-session-projection'
import Llm, { createUserMessage } from '@deepseek-ai/dsh-llm'
import Jobs from '@deepseek-ai/dsh-jobs-local'
import * as ToolJobs from '@deepseek-ai/dsh-tool-jobs'
import { MockAdapter, textResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import { MemoryCredentials } from '../../../credentials/credentials/tests/memory.ts'
import * as Jubian from '../src/index.ts'

it('registers the watcher without requiring jobs and rejects invalid operation IDs before admission', async () => {
  const ctx = new Context()
  try {
    await ctx.plugin(SystemPrompt); await ctx.plugin(Tools)
    await ctx.plugin(NativeToolExecutor)
    await ctx.plugin(MemoryCredentials, { JUBIANAI_ADMIN_TOKEN: 'test-token' })
    const fiber = ctx.plugin(Jubian, { workspaceSecrets: false })
    await fiber
    const tool = ctx.tools.get('jubian_watch')
    expect(tool).toBeDefined()
    if (!tool) throw new Error('Missing jubian_watch')
    const exec = {} as ToolRunContext
    for (const task_id of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      await expect(tool.execute({ task_id, stage: 'generate' }, exec)).rejects.toThrow(/positive safe-integer|must be an integer/)
    }
    await expect(tool.execute({ task_id: 42, stage: 'upscale' }, exec)).rejects.toThrow('jobs')
    expect(tool.parameters).toMatchSnapshot('watch input schema')
    expect(tool.output.schema).toMatchSnapshot('watch output schema')
    await ctx.plugin(Jobs)
    ctx.jobs.attachController('watch-test')
    const transport = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('No remote requests in this test'))
    try {
      await expect(tool.execute({ task_id: 42, stage: 'upscale' }, exec)).rejects.toThrow('owning Agent')
      expect(ctx.jobs.list()).toEqual([])
      expect(transport).not.toHaveBeenCalled()
    } finally { transport.mockRestore() }
    await fiber.dispose()
    expect(ctx.tools.get('jubian_watch')).toBeUndefined()
  } finally { await ctx.fiber.dispose() }
})

it('returns immediately, reaches idle, then delivers the jobs notice in a second model request', async () => {
  const root = await mkdtemp(join(tmpdir(), 'jubian-watch-loader-'))
  const ctx = new Context()
  let release!: () => void
  const pending = new Promise<void>((resolve) => { release = resolve })
  const calls: string[] = []
  const transport = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
    const path = typeof url === 'string' ? url : url instanceof URL ? url.href : url.url
    if (!path.startsWith('https://watch.invalid/')) throw new Error(`Unexpected URL ${path}`)
    calls.push(`${init!.method} ${path}`)
    await pending
    const data = init?.method === 'GET' ? { id: 42, taskType: 20, taskStatus: 'succeeded' }
      : { total: 1, rows: [{ id: 51, aigcVideoTaskId: 42, taskStatus: 'succeeded', resolution: '1080p',
        resultList: [{ lastTaskType: 20, lastResultStatus: 'succeeded', lastTosVideoUrl: 'https://cdn.example/hd.mp4' }] }] }
    return new Response(JSON.stringify({ code: 200, data }))
  })
  try {
    const modules = new Map<string, unknown>([
      ['prompt', SystemPrompt], ['tools', Tools], ['native-executor', NativeToolExecutor], ['credentials', MemoryCredentials], ['jubian', Jubian],
      ['llm', Llm], ['sessions', SessionStore], ['projections', SessionProjections],
      ['agents', AgentRegistry], ['loop', AgentLoop], ['jobs', Jobs], ['tool-jobs', ToolJobs],
    ])
    const config = join(root, 'cordis.yml')
    await writeFile(config, [...modules.keys()].flatMap(name => [
      `- name: '${name}'`,
      ...(name === 'jubian' ? ['  config:', '    workspaceSecrets: false', '    baseUrl: https://watch.invalid',
        '    watchPollIntervalMs: 10', '    watchTimeoutMs: 60000'] : []),
      ...(name === 'credentials' ? ['  config:', '    JUBIANAI_ADMIN_TOKEN: test-token'] : []),
      ...(name === 'loop' ? ['  config:', '    agents: []'] : []),
    ]).join('\n') + '\n')
    ctx.baseUrl = pathToFileURL(root).href + '/'
    await ctx.plugin(Loader)
    ctx.loader.builtins.include = Include
    ctx.loader.internal = { version: 'v2', loadCache: new Map(),
      register() { throw new Error('Unexpected loader hooks') },
      getOrCreateModuleJob() { throw new Error('Unexpected loader job') },
      resolveSync() { throw new Error('Unexpected loader resolution') },
      load() { throw new Error('Unexpected loader load') }, async import(name: string) {
        if (!modules.has(name)) throw new Error(`Unexpected module ${name}`)
        return modules.get(name)
      } }
    await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(config).href } })
    await ctx.loader.await()
    for (const entry of ctx.loader.entries()) await entry.fiber?.await()
    let sawCompletion!: () => void
    const completionRequest = new Promise<void>((resolve) => { sawCompletion = resolve })
    const adapter = new MockAdapter([textResponse('Work continues independently.'), () => {
      sawCompletion(); return textResponse('Collect the watcher output and review the video.')
    }])
    ctx.llm.registerAdapter(['mock'], adapter)
    const agent = await ctx.agentLoop.create(SessionId('watch-owner'), { provider: 'mock', model: 'mock' })
    const tool = ctx.tools.get('jubian_watch')!
    expect(tool).toBeDefined()
    const args = { task_id: 42, stage: 'upscale' }
    const output = await tool.execute(args, { agent } as ToolRunContext) as JsonValue
    if (output === null || typeof output !== 'object' || Array.isArray(output)) throw new Error('Invalid job admission')
    const admitted = ctx.jobs.list(agent.session.id)[0]
    expect(admitted).toBeDefined()
    expect(output.job_id).toBe(admitted!.id)
    expect(tool.output.render(args, { ...output, job_id: 'jubian-1' })).toMatchSnapshot('watch admission output')
    expect(ctx.jobs.list(agent.session.id)).toMatchObject([{ kind: 'jubian', owner: agent.session.id, status: 'running' }])
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Continue independent work.' }], source: { kind: 'user' } }))
    await agent.whenIdle()
    expect(agent.status).toBe('idle')
    expect(adapter.requests).toHaveLength(1)
    release()
    await completionRequest
    await agent.whenIdle()
    expect(adapter.requests).toHaveLength(2)
    const messages = adapter.requests[1]!.messages
    expect(messages.some(message => message.role === 'user' && message.content.some(block =>
      block.type === 'text' && block.text.includes(`background job ${admitted!.id}`)))).toBe(true)
    const notices = agent.session.snapshotEvents().filter(event => event.type === 'user/message')
    expect(notices.some(event => JSON.stringify(event.data).includes('"kind":"tool-jobs"'))).toBe(true)
    const job = ctx.jobs.list(agent.session.id)[0]!
    expect(job.status).toBe('completed')
    const completion = messages.flatMap(message => message.role === 'user' ? message.content : [])
      .find(block => block.type === 'text' && block.text.startsWith(`background job ${job.id}`))
    if (completion?.type !== 'text') throw new Error('Missing job completion notice')
    const [, result] = completion.text.split('Output:\n')
    if (result === undefined) throw new Error('Missing inline job result')
    expect(JSON.parse(result)).toMatchSnapshot('verified operation output')
    expect(ctx.jobs.read(job.id, agent.session.id).result).toBeUndefined()
    expect(calls).toHaveLength(2)
  } finally {
    release()
    await ctx.fiber.dispose()
    transport.mockRestore()
    await rm(root, { recursive: true, force: true })
  }
})
