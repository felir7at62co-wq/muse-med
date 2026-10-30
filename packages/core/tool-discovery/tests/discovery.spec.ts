/** Real Loader and agent-loop coverage for per-session tool discovery. */
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import Agents, { type Agent, type CreateAgentOptions } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import Llm, { createUserMessage, ToolCallId } from '@deepseek-ai/dsh-llm'
import Sessions, { SessionId, SessionLogOffset } from '@deepseek-ai/dsh-session'
import Projections from '@deepseek-ai/dsh-session-projection'
import Persistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import Tools, { defineTool } from '@deepseek-ai/dsh-tools'
import { PtcRuntime } from '@deepseek-ai/dsh-ptc-runtime'
import { describe, expect, it, vi } from 'vitest'
import LocalSpill from '@deepseek-ai/dsh-spill-local'
import * as SpillPolicy from '@deepseek-ai/dsh-spill-policy'
import { z } from 'zod'
import { MockAdapter, textResponse, toolCallResponse } from '../../agent-loop/tests/mock-adapter.ts'
import * as Discovery from '../src/index.ts'

/** Test capabilities use normal registration and execution without external effects. */
const capabilities = { inject: ['tools'], apply(ctx: Context) {
  for (const [name, description] of [
    ['base_read', 'Read a saved local file.'],
    ['video_inspect', '查看视频画面、人物动作与切镜；抽帧并查看已有观察。'],
    ['export_word', 'Export the saved screenplay as a Word document.'],
    ['secret_delete', 'Delete a restricted fixture item.'],
  ]) {
    if (!name || !description) throw new Error('Invalid fixture capability')
    ctx.tools.register(defineTool({ name, description, parameters: {},
      output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
      execute: async () => `${name}:done`,
    }))
  }
} }

/** Scriptable provider drives known fixture bindings without evaluating model-written code. */
class AssemblyRuntime extends PtcRuntime {
  readonly language = 'typescript'
  readonly isolation = 'fixture'
  resolve(request: import('@deepseek-ai/dsh-ptc-runtime').PtcRunRequest): import('@deepseek-ai/dsh-ptc-runtime').PtcRunSpec {
    return { ...request, cwd: request.cwd ?? process.cwd(), timeoutMs: request.timeoutMs ?? 1000 }
  }
  behavior: (request: import('@deepseek-ai/dsh-ptc-runtime').PtcRunRequest) => Promise<import('@deepseek-ai/dsh-ptc-runtime').PtcRunResult> = async () => ({ logs: [] })
  run(request: import('@deepseek-ai/dsh-ptc-runtime').PtcRunRequest): Promise<import('@deepseek-ai/dsh-ptc-runtime').PtcRunResult> { return this.behavior(request) }
}

/** Load the real discovery plugin from a Cordis composition and retain durable sessions. */
async function fixture(root: string, config: Partial<Discovery.Config> = {}) {
  const ctx = new Context()
  try {
    await ctx.plugin(Loader)
    Object.assign(ctx.loader.builtins, { include: Include, llm: Llm, sessions: Sessions, projections: Projections,
      prompt: SystemPrompt, tools: Tools, agents: Agents, persistence: Persistence, loop: AgentLoop,
      capabilities, discovery: Discovery })
    const path = join(root, 'cordis.yml')
    await writeFile(path, JSON.stringify([
      { id: 'llm', name: 'cordis:llm' }, { id: 'sessions', name: 'cordis:sessions' },
      { id: 'projections', name: 'cordis:projections' }, { id: 'prompt', name: 'cordis:prompt' },
      { id: 'tools', name: 'cordis:tools' }, { id: 'agents', name: 'cordis:agents' },
      { id: 'persistence', name: 'cordis:persistence', config: { root: join(root, 'sessions'), compression: 'none' } },
      { id: 'loop', name: 'cordis:loop', config: { agents: [] } },
      { id: 'capabilities', name: 'cordis:capabilities' },
      { id: 'discovery', name: 'cordis:discovery', config: { alwaysLoad: ['base_read'], maxResults: 2,
        maxDescriptionChars: 160, keywords: { video_inspect: ['抽帧', '视频动作'] },
        capabilities: [
          { id: 'video', title: '视频理解', description: '查看视频人物动作。', tools: ['video_*'] },
          { id: 'delivery', title: '交付', description: '导出制作产物。', tools: ['export_word'] },
          { id: 'shared', title: '编剧辅助', description: '查看与交付。', tools: ['video_inspect', 'export_word'] },
          { id: 'danger', title: '管理', description: '受限工具。', tools: ['secret_delete'] },
        ], ...config } },
    ]))
    await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(path).href } })
    await ctx.loader.await()
    for (const row of ctx.loader.entries()) await row.fiber?.await()
    const responses: ConstructorParameters<typeof MockAdapter>[0] = []
    const adapter = new MockAdapter(responses)
    ctx.llm.registerAdapter(['mock'], adapter)
    return { ctx, responses, adapter,
      create: async (id: string, extra: Omit<CreateAgentOptions, 'sessionId' | 'agentOptions'> = {}) =>
        (await ctx.agents.create({ sessionId: SessionId(id), meta: { cwd: root },
          agentOptions: { provider: 'mock', model: 'mock' }, ...extra })).agent,
      dispose: () => ctx.fiber.dispose(),
    }
  } catch (error) { await ctx.fiber.dispose(); throw error }
}

/** Run one user task against the registered agent driver. */
async function send(agent: Agent) {
  agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Complete the fixture task.' }] }))
  await agent.whenIdle()
}

/** Collect canonical names from the current assembled model input. */
async function shown(ctx: Context, agent: Agent) {
  return (await ctx.systemPrompt.assemble({ agent, scope: agent })).tools.map(tool => tool.name).sort()
}

let searchOrdinal = 0

/** Search through the normal model/tool loop, creating authoritative call and result records. */
async function search(f: Awaited<ReturnType<typeof fixture>>, agent: Agent, query: string) {
  f.responses.push(toolCallResponse(`search-${agent.id}-${++searchOrdinal}`, 'tool_search', { query, limit: 1 }), textResponse('Loaded.'))
  await send(agent)
}


const resultSchema = z.object({
  loaded: z.array(z.object({ name: z.string(), description: z.string(), capabilities: z.array(z.string()) })),
  capabilities: z.array(z.object({ id: z.string(), title: z.string(), description: z.string(), tool_count: z.number() })),
  matched: z.number(), omitted: z.number(),
  search_scope: z.enum(['directory', 'capability', 'global']), global_fallback: z.boolean(),
  next_offset: z.number().optional(),
})

/** Read the complete last successful discovery result from its durable tool message. */
function receipt(agent: Agent) {
  const result = agent.session.snapshotEvents().findLast(event => event.type === 'tool/result')
  const text = result?.data.message.content.filter(block => block.type === 'text').map(block => block.text).join('')
  if (!text) throw new Error('Missing tool receipt')
  return { value: resultSchema.parse(JSON.parse(text)), text }
}

/** Issue directory and filtered discovery requests through the model's normal tool surface. */
async function discover(
  f: Awaited<ReturnType<typeof fixture>>, agent: Agent, args: { query?: string; capability?: string; limit?: number; offset?: number },
) {
  f.responses.push(toolCallResponse(`directory-${agent.id}-${++searchOrdinal}`, 'tool_search', args), textResponse('Checked.'))
  await send(agent)
  return receipt(agent)
}

/** Run a context edit through the normal loop and read its committed outcome. */
async function manage(f: Awaited<ReturnType<typeof fixture>>, agent: Agent,
  operation: 'status' | 'load' | 'pin' | 'release' | 'unpin', tools?: string[]) {
  f.responses.push(toolCallResponse(`context-${agent.id}-${++searchOrdinal}`, 'tool_context',
    { operation, ...tools ? { tools } : {} }), textResponse('Context checked.'))
  await send(agent)
  return agent.session.snapshotEvents().findLast(event => event.type === 'tool/result')?.data.message
}

describe('Loader-composed tool discovery', () => {
  it('includes authorized capability guidance in the first logged request without loading schemas', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-discovery-guidance-'))
    const f = await fixture(root)
    try {
      const agent = await f.create('discovery-guidance', { setup: (scope) => { scope.tools.restrict({ deny: ['secret_delete'] }) } })
      f.responses.push(textResponse('Ready.'))
      await send(agent)
      const request = f.adapter.requests[0]
      const system = request?.messages.filter(message => message.role === 'system').flatMap(message => message.content)
        .filter(block => block.type === 'text').map(block => block.text).join('\n') ?? ''
      expect(system).toContain('Some authorized tools are not loaded upfront')
      expect(system).toContain('查看视频人物动作。')
      expect(system).toContain('"id":"delivery"')
      expect(system).not.toContain('"id":"danger"')
      expect(system).not.toContain('受限工具。')
      expect(system.match(/Available capability groups/g)).toHaveLength(1)
      expect(request?.tools?.map(tool => tool.name).sort()).toEqual(['base_read', 'tool_context', 'tool_search'])
      expect(request?.tools?.find(tool => tool.name === 'tool_search')?.description).not.toContain('查看视频人物动作。')
      expect(f.ctx.toolDiscovery.state(agent)).toEqual({ loaded: [], pinned: [] })
      const logged = agent.session.snapshotEvents().filter(event => event.type === 'system/message')
      expect(logged).toHaveLength(1)
      expect(agent.session.deriveMessages().filter(message => message.role === 'system').flatMap(message => message.content))
        .toEqual(request?.messages.filter(message => message.role === 'system').flatMap(message => message.content))
    } finally { await f.dispose(); await rm(root, { recursive: true, force: true }) }
  })

  it('keeps the discovery section unchanged across loading and preferences and restores it on resume', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-discovery-guidance-resume-'))
    const first = await fixture(root)
    try {
      first.adapter.systemPromptUpdate = 'in-history'
      first.adapter.toolUpdate = 'addition-only'
      const agent = await first.create('discovery-guidance-resume')
      const before = (await first.ctx.systemPrompt.assemble({ agent, scope: agent })).sections
        .find(section => section.name === 'tools:discovery')
      await search(first, agent, 'video_inspect')
      await manage(first, agent, 'pin', ['export_word'])
      await manage(first, agent, 'release', ['video_inspect'])
      const after = (await first.ctx.systemPrompt.assemble({ agent, scope: agent })).sections
        .filter(section => section.name === 'tools:discovery')
      expect(after).toEqual([before])
      expect(agent.session.snapshotEvents().filter(event => event.type === 'system/message')).toHaveLength(1)
      await first.dispose()
      const second = await fixture(root)
      try {
        const resumed = (await second.ctx.agents.resume({ resumeSessionId: SessionId('discovery-guidance-resume'),
          agentOptions: { provider: 'mock', model: 'mock' } })).agent
        const restored = await second.ctx.systemPrompt.assemble({ agent: resumed, scope: resumed })
        expect(restored.sections.filter(section => section.name === 'tools:discovery')).toEqual([before])
        expect(restored.tools.map(tool => tool.name).sort()).toEqual(['base_read', 'export_word', 'tool_context', 'tool_search'])
      } finally { await second.dispose() }
    } finally { await first.dispose(); await rm(root, { recursive: true, force: true }) }
  })

  it('does not advertise discovery in scopes where the discovery tool is unavailable', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-discovery-guidance-denied-'))
    const f = await fixture(root)
    try {
      const agent = await f.create('discovery-guidance-denied', { setup: (scope) => { scope.tools.restrict({ deny: ['tool_search'] }) } })
      const assembly = await f.ctx.systemPrompt.assemble({ agent, scope: agent })
      expect(assembly.sections.some(section => section.name === 'tools:discovery')).toBe(false)
      expect(assembly.tools.some(tool => tool.name === 'tool_search')).toBe(false)
    } finally { await f.dispose(); await rm(root, { recursive: true, force: true }) }
  })

  it('preserves complete prompt overrides without suppressing tool discovery itself', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-discovery-guidance-complete-'))
    const f = await fixture(root)
    try {
      const agent = await f.create('discovery-guidance-complete', { setup: (scope) => {
        scope.systemPrompt.section({ name: 'complete-persona', order: 0, text: 'Only the explicit persona.', complete: true })
      } })
      const assembly = await f.ctx.systemPrompt.assemble({ agent, scope: agent })
      expect(assembly.sections).toEqual([{ name: 'complete-persona', text: 'Only the explicit persona.' }])
      expect(assembly.tools.find(tool => tool.name === 'tool_search')?.description).toContain('tools not loaded upfront')
      await search(f, agent, 'video_inspect')
      expect(await shown(f.ctx, agent)).toContain('video_inspect')
    } finally { await f.dispose(); await rm(root, { recursive: true, force: true }) }
  })

  it.each(['native', 'ptc'] as const)('retains bounded discovery JSON through the default spill policy in %s mode', async (mode) => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-discovery-spill-'))
    const f = await fixture(root, { maxResults: 8, maxDescriptionChars: 2048, maxResultChars: 6000 })
    try {
      await f.ctx.plugin(LocalSpill, { root: join(root, 'spill'), cleanupPeriodDays: 0 })
      await f.ctx.plugin(SpillPolicy, { maxInlineTokens: 12500 })
      const save = vi.spyOn(f.ctx.spillStore, 'saveText')
      for (let index = 0; index < 8; index++) {
        f.ctx.tools.register(defineTool({ name: `bulk_${index}`, description: '连续动作视频工具'.repeat(1000), parameters: {},
          output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
          execute: async () => 'unused',
        }))
      }
      if (mode === 'ptc') {
        await f.ctx.plugin(AssemblyRuntime)
        const runtime = f.ctx.ptcRuntime
        if (!(runtime instanceof AssemblyRuntime)) throw new Error('Missing test runtime')
        runtime.behavior = async (request) => {
          const find = request.bindings[0]?.functions.tool_search
          if (!find) throw new Error('Missing search binding')
          return { logs: [], value: await find({ query: '连续动作视频工具', limit: 8 }) }
        }
      }
      const agent = await f.create(`discovery-spill-${mode}`, {
        setup: (scope) => { if (mode === 'ptc') scope.tools.presentAs('both') },
      })
      f.responses.push(mode === 'ptc'
        ? toolCallResponse('spill-search-ptc', 'run_code', { description: 'Find video tools.',
          code: "return await tools.tool_search({query:'连续动作视频工具',limit:8})" })
        : toolCallResponse('spill-search-native', 'tool_search', { query: '连续动作视频工具', limit: 8 }), textResponse('Loaded.'))
      await send(agent)
      const events = agent.session.snapshotEvents()
      const nested = events.find(event => event.type === 'tool/ptc-dispatch')
      const ordinary = events.find(event => event.type === 'tool/result')
      const content = mode === 'ptc' ? nested?.data.content : ordinary?.data.message.content
      const text = content?.filter(block => block.type === 'text').map(block => block.text).join('')
      if (!text) throw new Error('Missing retained search result')
      const result = resultSchema.parse(JSON.parse(text))
      expect(text.length).toBeLessThanOrEqual(6000)
      expect(text).not.toContain('Full formatted result stored at')
      expect(result.loaded.length).toBeGreaterThan(0)
      expect(result.omitted).toBeGreaterThan(0)
      expect(save).not.toHaveBeenCalled()
      expect(await shown(f.ctx, agent)).toEqual(['base_read', 'tool_context', 'tool_search', ...mode === 'ptc' ? ['run_code'] : [],
        ...result.loaded.map(tool => tool.name)].sort())
    } finally { await f.dispose(); await rm(root, { recursive: true, force: true }) }
  })

  it('lists only authorized capability groups without loading tools', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-discovery-directory-'))
    const f = await fixture(root)
    try {
      const agent = await f.create('discovery-directory', { setup: (scope) => { scope.tools.restrict({ deny: ['secret_delete'] }) } })
      const result = await discover(f, agent, {})
      expect(result.value.loaded).toEqual([])
      expect([...result.value.capabilities].sort((a, b) => a.id.localeCompare(b.id))).toEqual([
        { id: 'delivery', title: '交付', description: '导出制作产物。', tool_count: 1 },
        { id: 'shared', title: '编剧辅助', description: '查看与交付。', tool_count: 2 },
        { id: 'video', title: '视频理解', description: '查看视频人物动作。', tool_count: 1 },
      ])
      expect(await shown(f.ctx, agent)).toEqual(['base_read', 'tool_context', 'tool_search'])
      expect(result.text).not.toContain('danger')
      expect(result.text).not.toContain('secret_delete')
    } finally { await f.dispose(); await rm(root, { recursive: true, force: true }) }
  })

  it('browses a capability and retries category misses globally with explicit scope', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-discovery-category-'))
    const f = await fixture(root)
    try {
      const agent = await f.create('discovery-category')
      const browse = await discover(f, agent, { capability: 'video', limit: 1 })
      expect(browse.value.loaded.map(tool => tool.name)).toEqual(['video_inspect'])
      expect(browse.value.loaded[0]?.capabilities.sort()).toEqual(['shared', 'video'])
      expect(browse.value).toMatchObject({ search_scope: 'capability', global_fallback: false })
      const scoped = await discover(f, agent, { capability: 'video', query: 'export_word', limit: 1 })
      expect(scoped.value.loaded[0]?.name).toBe('export_word')
      expect(scoped.value).toMatchObject({ search_scope: 'global', global_fallback: true })
      expect(await shown(f.ctx, agent)).toContain('export_word')
      const globalResult = await discover(f, agent, { query: 'export_word', limit: 1 })
      expect(globalResult.value.loaded[0]?.name).toBe('export_word')
      expect(globalResult.value.loaded[0]?.capabilities.sort()).toEqual(['delivery', 'shared'])
      expect(globalResult.value).toMatchObject({ search_scope: 'global', global_fallback: false })
    } finally { await f.dispose(); await rm(root, { recursive: true, force: true }) }
  })

  it('returns the available directory for an unknown capability without blocking the turn', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-discovery-unknown-'))
    const f = await fixture(root)
    try {
      const agent = await f.create('discovery-unknown')
      const result = await discover(f, agent, { capability: 'missing-category' })
      expect(result.value.loaded).toEqual([])
      expect(result.value).toMatchObject({ search_scope: 'directory', global_fallback: false })
      expect(result.value.capabilities.map(group => group.id)).toContain('video')
      expect(await shown(f.ctx, agent)).toEqual(['base_read', 'tool_context', 'tool_search'])
      expect(agent.session.snapshotEvents().findLast(event => event.type === 'turn/end')?.data.reason.kind).toBe('completed')
    } finally { await f.dispose(); await rm(root, { recursive: true, force: true }) }
  })

  it('lets explicit authorized names and aliases cross categories despite weak scoped matches', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-discovery-explicit-cross-category-'))
    const f = await fixture(root, { keywords: { video_inspect: ['画面核对'] }, capabilities: [
      { id: 'delivery', title: '交付', description: '导出文档。', tools: ['video_export'] },
      { id: 'video', title: '视频理解', description: '查看视频。', tools: ['video_inspect'] },
    ] })
    try {
      f.ctx.tools.register(defineTool({ name: 'video_export', description: 'Export video 画面 files.', parameters: {},
        output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
        execute: async () => 'unused',
      }))
      const agent = await f.create('discovery-explicit-cross-category')
      for (const query of ['video_inspect', '请用 video_inspect 检查', '帮我做画面核对']) {
        const result = await discover(f, agent, { capability: 'delivery', query, limit: 1 })
        expect(result.value.loaded[0]?.name).toBe('video_inspect')
        expect(result.value).toMatchObject({ search_scope: 'global', global_fallback: true })
      }
      const ordinary = await discover(f, agent, { capability: 'delivery', query: 'Export files', limit: 1 })
      expect(ordinary.value.loaded[0]?.name).toBe('video_export')
      expect(ordinary.value).toMatchObject({ search_scope: 'capability', global_fallback: false })
      const restricted = await f.create('discovery-explicit-restricted', {
        setup: (scope) => { scope.tools.restrict({ deny: ['video_inspect'] }) },
      })
      const denied = await discover(f, restricted, { capability: 'delivery', query: 'video_inspect', limit: 1 })
      expect(denied.value.loaded.map(tool => tool.name)).not.toContain('video_inspect')
      expect(denied.value).toMatchObject({ search_scope: 'capability', global_fallback: false })
    } finally { await f.dispose(); await rm(root, { recursive: true, force: true }) }
  })

  it('returns no unrelated tools when both category and authorized global search miss', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-discovery-no-match-'))
    const f = await fixture(root)
    try {
      const agent = await f.create('discovery-no-match', { setup: (scope) => { scope.tools.restrict({ deny: ['secret_delete'] }) } })
      for (const query of ['qzxvnonexistentcapability', 'secret_delete']) {
        const result = await discover(f, agent, { capability: 'video', query })
        expect(result.value).toMatchObject({ loaded: [], matched: 0, search_scope: 'global', global_fallback: true })
        expect(result.value.next_offset).toBeUndefined()
      }
      expect(await shown(f.ctx, agent)).toEqual(['base_read', 'tool_context', 'tool_search'])
    } finally { await f.dispose(); await rm(root, { recursive: true, force: true }) }
  })

  it('keeps late authorized unclassified tools browsable without exposing denied or constant tools', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-discovery-unclassified-'))
    const f = await fixture(root)
    try {
      const agent = await f.create('discovery-unclassified', { setup: (scope) => { scope.tools.restrict({ deny: ['secret_delete'] }) } })
      const before = await discover(f, agent, {})
      expect(before.value.capabilities.map(group => group.id)).not.toContain('uncategorized')
      f.ctx.tools.register(defineTool({ name: 'mcp_late_tool', description: 'Analyze colors.', parameters: {},
        output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
        execute: async () => 'unused',
      }))
      const directory = await discover(f, agent, {})
      expect(directory.value.capabilities.at(-1)).toMatchObject({ id: 'uncategorized', tool_count: 1 })
      const browse = await discover(f, agent, { capability: 'uncategorized' })
      expect(browse.value.loaded.map(tool => tool.name)).toEqual(['mcp_late_tool'])
      expect(browse.value.loaded[0]?.capabilities).toEqual(['uncategorized'])
      expect(browse.value).toMatchObject({ search_scope: 'capability', global_fallback: false })
      expect(await shown(f.ctx, agent)).toEqual(['base_read', 'mcp_late_tool', 'tool_context', 'tool_search'])
    } finally { await f.dispose(); await rm(root, { recursive: true, force: true }) }
  })

  it('paginates capability browse and global fallback in stable order without hiding later tools', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-discovery-pages-'))
    const f = await fixture(root, { maxResults: 8 })
    try {
      const names = Array.from({ length: 11 }, (_, index) => `late_${String(index).padStart(2, '0')}`)
      for (const name of [...names].reverse()) f.ctx.tools.register(defineTool({ name, description: 'Pagination fixture.', parameters: {},
        output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
        execute: async () => 'unused',
      }))
      const agent = await f.create('discovery-pages')
      for (const args of [{ capability: 'uncategorized' }, { capability: 'video', query: 'Pagination' }]) {
        const first = await discover(f, agent, { ...args, limit: 8 })
        expect(first.value.loaded.map(tool => tool.name)).toEqual(names.slice(0, 8))
        expect(first.value).toMatchObject({ matched: 11, omitted: 3, next_offset: 8 })
        if (first.value.next_offset === undefined) throw new Error('First page did not return a continuation offset')
        const last = await discover(f, agent, { ...args, offset: first.value.next_offset, limit: 8 })
        expect(last.value.loaded.map(tool => tool.name)).toEqual(names.slice(8))
        expect(last.value).toMatchObject({ matched: 11, omitted: 8 })
        expect(last.value.next_offset).toBeUndefined()
        const repeated = await discover(f, agent, { ...args, offset: 8, limit: 8 })
        expect(repeated.value).toEqual(last.value)
      }
      const beyond = await discover(f, agent, { capability: 'uncategorized', offset: 100 })
      expect(beyond.value.loaded).toEqual([])
      expect(beyond.value.next_offset).toBeUndefined()
    } finally { await f.dispose(); await rm(root, { recursive: true, force: true }) }
  })

  it('does not advertise a nonadvancing next page when one name exceeds the result budget', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-discovery-page-budget-'))
    const f = await fixture(root, { maxResultChars: 256 })
    try {
      f.ctx.tools.register(defineTool({ name: `oversized_${'a'.repeat(256)}`, description: 'Oversized fixture.', parameters: {},
        output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
        execute: async () => 'unused',
      }))
      const agent = await f.create('discovery-page-budget')
      const result = await discover(f, agent, { capability: 'uncategorized' })
      expect(result.text.length).toBeLessThanOrEqual(256)
      expect(result.value).toMatchObject({ loaded: [], matched: 1, omitted: 1 })
      expect(result.value.next_offset).toBeUndefined()
    } finally { await f.dispose(); await rm(root, { recursive: true, force: true }) }
  })

  it('rejects invalid page offsets without selecting tools', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-discovery-invalid-offset-'))
    const f = await fixture(root)
    try {
      const agent = await f.create('discovery-invalid-offset')
      for (const offset of [-1, 0.5, Number.MAX_SAFE_INTEGER + 1]) {
        const result = await f.ctx.tools.execute({ name: 'tool_search', arguments: { query: 'video_inspect', offset },
          agent, callId: ToolCallId(`invalid-offset-${offset}`), signal: new AbortController().signal })
        expect(result.isError).toBe(true)
      }
      expect(await shown(f.ctx, agent)).toEqual(['base_read', 'tool_context', 'tool_search'])
    } finally { await f.dispose(); await rm(root, { recursive: true, force: true }) }
  })

  it('keeps the complete Chinese result within its budget and loads only its recorded names', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-discovery-budget-'))
    const budget = 512
    const f = await fixture(root, { maxResultChars: budget, maxDescriptionChars: 160 })
    try {
      const agent = await f.create('discovery-budget')
      const result = await discover(f, agent, { query: '抽帧'.repeat(5000), limit: 2 })
      expect(result.text.length).toBeLessThanOrEqual(budget)
      expect(result.value.matched).toBeGreaterThanOrEqual(result.value.loaded.length)
      expect(result.value.omitted).toBeGreaterThanOrEqual(0)
      expect(await shown(f.ctx, agent)).toEqual(['base_read', 'tool_context', 'tool_search', ...result.value.loaded.map(tool => tool.name)].sort())
    } finally { await f.dispose(); await rm(root, { recursive: true, force: true }) }
  })

  it('learns a discovery performed through the PTC dispatch bridge', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-discovery-nested-'))
    const f = await fixture(root)
    try {
      await f.ctx.plugin(AssemblyRuntime)
      const runtime = f.ctx.ptcRuntime
      if (!(runtime instanceof AssemblyRuntime)) throw new Error('Missing test runtime')
      runtime.behavior = async (request) => {
        const find = request.bindings[0]?.functions.tool_search
        if (!find) throw new Error('Missing search binding')
        const value = await find({ query: 'video_inspect', limit: 1 })
        return { logs: [], value }
      }
      const agent = await f.create('discovery-nested', { setup: (scope) => { scope.tools.presentAs('both') } })
      f.responses.push(toolCallResponse('discover-nested', 'run_code', {
        description: 'Find the video inspection capability.',
        code: "return await tools.tool_search({query:'video_inspect',limit:1})",
      }), textResponse('Loaded.'))
      await send(agent)
      const dispatch = agent.session.snapshotEvents().find(event => event.type === 'tool/ptc-dispatch')
      expect(dispatch?.data.name).toBe('tool_search')
      expect(dispatch?.data.isError).toBe(false)
      expect(await shown(f.ctx, agent)).toEqual(['base_read', 'run_code', 'tool_context', 'tool_search', 'video_inspect'])
      expect(f.adapter.requests[1]?.tools?.some(tool => tool.name === 'video_inspect')).toBe(true)
    } finally { await f.dispose(); await rm(root, { recursive: true, force: true }) }
  })

  it('loads only committed successful receipts, leaving failed searches unchanged', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-discovery-commit-'))
    const f = await fixture(root)
    try {
      const agent = await f.create('discovery-commit')
      const uncommitted = await f.ctx.tools.execute({ name: 'tool_search', arguments: { query: 'video_inspect', limit: 1 },
        agent, callId: ToolCallId('uncommitted-search'), signal: new AbortController().signal })
      expect(uncommitted.isError).not.toBe(true)
      expect(await shown(f.ctx, agent)).toEqual(['base_read', 'tool_context', 'tool_search'])
      f.responses.push(toolCallResponse('invalid-search', 'tool_search', { query: 'video_inspect', limit: 3 }), textResponse('Failed.'))
      await send(agent)
      const result = agent.session.snapshotEvents().findLast(event => event.type === 'tool/result')
      expect(result?.data.message.isError).toBe(true)
      expect(await shown(f.ctx, agent)).toEqual(['base_read', 'tool_context', 'tool_search'])
      await search(f, agent, 'video_inspect')
      expect(await shown(f.ctx, agent)).toEqual(['base_read', 'tool_context', 'tool_search', 'video_inspect'])
    } finally { await f.dispose(); await rm(root, { recursive: true, force: true }) }
  })

  it.each([true, false])('loads a tool on a route with dynamic updates supported=%s', async (supported) => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-discovery-route-'))
    const f = await fixture(root)
    try {
      if (supported) {
        f.adapter.systemPromptUpdate = 'in-history'
        f.adapter.toolUpdate = 'addition-only'
      }
      const agent = await f.create(`discovery-route-${supported}`)
      await search(f, agent, 'video_inspect')
      const initial = f.adapter.requests[0]
      const next = f.adapter.requests[1]
      if (!initial || !next) throw new Error('Missing recorded model requests')
      expect(initial.tools?.map(tool => tool.name).sort()).toEqual(['base_read', 'tool_context', 'tool_search'])
      expect(next.tools?.map(tool => tool.name).sort()).toEqual(['base_read', 'tool_context', 'tool_search', 'video_inspect'])
      const loaded = next.tools?.find(tool => tool.name === 'video_inspect')
      const updates = next.messages.filter(message => message.role === 'developer').flatMap(message => message.content)
      if (supported) {
        expect(loaded?.deferLoading).toBe(true)
        expect(updates).toEqual([{ type: 'tool-addition', toolName: 'video_inspect' }])
        expect(next.messages.slice(0, initial.messages.length)).toEqual(initial.messages)
      } else {
        expect(loaded?.deferLoading).not.toBe(true)
        expect(updates).toEqual([])
      }
      expect(next.tools?.some(tool => tool.name === 'export_word')).toBe(false)
      const headers = agent.session.snapshotEvents().filter(event => event.type === 'request/header')
      expect(headers.map(event => event.data.reason)).toEqual(['initial', 'change'])
    } finally { await f.dispose(); await rm(root, { recursive: true, force: true }) }
  })

  it('keeps PTC declarations limited to the discovered tools', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-discovery-sdk-'))
    const f = await fixture(root)
    try {
      await f.ctx.plugin(AssemblyRuntime)
      const agent = await f.create('discovery-sdk', { setup: (scope) => { scope.tools.presentAs('both') } })
      const first = await f.ctx.systemPrompt.assemble({ agent, scope: agent })
      const guidance = first.sections.find(section => section.name === 'tools:discovery')
      expect(guidance?.text).toContain('"id":"video"')
      const firstSdk = first.sections.find(section => section.name === 'tools:sdk')?.text ?? ''
      expect(firstSdk).toContain('tool_search')
      expect(firstSdk).not.toContain('video_inspect')
      expect(firstSdk).not.toContain('export_word')
      await search(f, agent, 'video_inspect')
      const next = await f.ctx.systemPrompt.assemble({ agent, scope: agent })
      expect(next.sections.filter(section => section.name === 'tools:discovery')).toEqual([guidance])
      const nextSdk = next.sections.find(section => section.name === 'tools:sdk')?.text ?? ''
      expect(nextSdk).toContain('video_inspect')
      expect(nextSdk).not.toContain('export_word')
      expect(next.tools.map(tool => tool.name)).toContain('run_code')
    } finally { await f.dispose(); await rm(root, { recursive: true, force: true }) }
  })

  it('does not load unrelated tools on a miss and restores presentation when unloaded', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-discovery-dispose-'))
    const f = await fixture(root)
    try {
      const agent = await f.create('discovery-dispose')
      await search(f, agent, 'qzxvnonexistentcapability')
      expect(await shown(f.ctx, agent)).toEqual(['base_read', 'tool_context', 'tool_search'])
      const discovery = [...f.ctx.loader.entries()].find(row => row.options.id === 'discovery')
      if (!discovery?.fiber) throw new Error('Missing Loader discovery entry')
      await discovery.fiber.dispose()
      expect(f.ctx.tools.get('tool_search', agent)).toBeUndefined()
      expect(await shown(f.ctx, agent)).toEqual(['base_read', 'export_word', 'secret_delete', 'video_inspect'])
    } finally { await f.dispose(); await rm(root, { recursive: true, force: true }) }
  })

  it('starts small and exposes the exact discovered tool on the next model request', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-discovery-loop-'))
    const f = await fixture(root)
    try {
      const agent = await f.create('discovery-loop')
      expect(await shown(f.ctx, agent)).toEqual(['base_read', 'tool_context', 'tool_search'])
      f.responses.push(toolCallResponse('discover-video', 'tool_search', { query: '抽帧', limit: 1 }),
        toolCallResponse('view-video', 'video_inspect', {}), textResponse('Done.'))
      await send(agent)
      expect(f.adapter.requests[0]?.tools?.map(tool => tool.name).sort()).toEqual(['base_read', 'tool_context', 'tool_search'])
      expect(f.adapter.requests[1]?.tools?.map(tool => tool.name).sort()).toEqual(['base_read', 'tool_context', 'tool_search', 'video_inspect'])
      const results = agent.session.snapshotEvents().filter(event => event.type === 'tool/result')
      expect(results).toHaveLength(2)
      expect(results[0]?.data.message.isError).not.toBe(true)
      expect(JSON.stringify(results[0]?.data.message.content)).toContain('video_inspect')
      expect(JSON.stringify(results[1]?.data.message.content)).toContain('video_inspect:done')
      expect(await shown(f.ctx, agent)).not.toContain('export_word')
    } finally { await f.dispose(); await rm(root, { recursive: true, force: true }) }
  })

  it('keeps hidden authorized tools executable and never discovers a restricted tool', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-discovery-policy-'))
    const f = await fixture(root)
    try {
      const agent = await f.create('discovery-policy', { setup: (scope) => { scope.tools.restrict({ deny: ['secret_delete'] }) } })
      expect(await shown(f.ctx, agent)).not.toContain('video_inspect')
      const direct = await f.ctx.tools.execute({ name: 'video_inspect', arguments: {}, agent,
        callId: ToolCallId('allowed-hidden'), signal: new AbortController().signal })
      expect(direct.isError).not.toBe(true)
      expect(JSON.stringify(direct.content)).toContain('video_inspect:done')
      await search(f, agent, 'secret_delete')
      expect(await shown(f.ctx, agent)).not.toContain('secret_delete')
      const denied = await f.ctx.tools.execute({ name: 'secret_delete', arguments: {}, agent,
        callId: ToolCallId('restricted-hidden'), signal: new AbortController().signal })
      expect(denied.isError).toBe(true)
    } finally { await f.dispose(); await rm(root, { recursive: true, force: true }) }
  })

  it('keeps exact-name discovery independent across parent and child agents', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-discovery-child-'))
    const f = await fixture(root)
    try {
      const parent = await f.create('discovery-parent')
      await search(f, parent, 'video_inspect')
      const child = await f.create('discovery-child', { parentAgent: parent, meta: { cwd: root, parentSession: parent.id, origin: 'subagent' } })
      expect(await shown(f.ctx, child)).toEqual(['base_read', 'tool_context', 'tool_search'])
      await search(f, child, 'export_word')
      expect(await shown(f.ctx, child)).toEqual(['base_read', 'export_word', 'tool_context', 'tool_search'])
      expect(await shown(f.ctx, parent)).toEqual(['base_read', 'tool_context', 'tool_search', 'video_inspect'])
    } finally { await f.dispose(); await rm(root, { recursive: true, force: true }) }
  })

  it('preserves successful discovery after context replacement and a fork', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-discovery-fork-'))
    const f = await fixture(root)
    try {
      const parent = await f.create('discovery-origin')
      await search(f, parent, 'video_inspect')
      const results = parent.session.snapshotEvents().filter(event => event.type === 'tool/result')
      const result = results[0]
      if (!result) throw new Error('Missing discovered-tool result')
      parent.session.append('user/message', createUserMessage({ source: { kind: 'user' },
        content: [{ type: 'text', text: 'The earlier task is summarized.' }] }),
      { surfaceOp: { op: 'replace', startSeq: result.seq, endSeq: result.seq }, sourceEventSeqs: [result.seq] })
      expect(await shown(f.ctx, parent)).toEqual(['base_read', 'tool_context', 'tool_search', 'video_inspect'])
      const seed = parent.session.snapshotEvents()
      const child = await f.create('discovery-fork', { seed, inheritedEventCount: SessionLogOffset(seed.length),
        meta: { cwd: root, parentSession: parent.id, isSeeded: true } })
      expect(await shown(f.ctx, child)).toEqual(['base_read', 'tool_context', 'tool_search', 'video_inspect'])
    } finally { await f.dispose(); await rm(root, { recursive: true, force: true }) }
  })

  it('rebuilds discovered definitions from persisted calls and results on cold resume', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-discovery-resume-'))
    const first = await fixture(root)
    try {
      const agent = await first.create('discovery-resume')
      await search(first, agent, 'export_word')
      await first.dispose()
      const second = await fixture(root)
      try {
        const resumed = (await second.ctx.agents.resume({ resumeSessionId: SessionId('discovery-resume'),
          agentOptions: { provider: 'mock', model: 'mock' } })).agent
        expect(await shown(second.ctx, resumed)).toEqual(['base_read', 'export_word', 'tool_context', 'tool_search'])
        second.responses.push(textResponse('Resumed.'))
        await send(resumed)
        expect(second.adapter.requests[0]?.tools?.map(tool => tool.name).sort()).toEqual(['base_read', 'export_word', 'tool_context', 'tool_search'])
      } finally { await second.dispose() }
    } finally { await first.dispose(); await rm(root, { recursive: true, force: true }) }
  })

  it('loads, pins, unpins and releases definitions while retaining a searchable catalog', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-context-edits-'))
    const f = await fixture(root)
    try {
      const agent = await f.create('context-edits')
      await manage(f, agent, 'load', ['export_word'])
      expect(f.ctx.toolDiscovery.state(agent)).toEqual({ loaded: ['export_word'], pinned: [] })
      await manage(f, agent, 'pin', ['video_inspect'])
      expect(f.ctx.toolDiscovery.state(agent)).toEqual({ loaded: ['export_word', 'video_inspect'], pinned: ['video_inspect'] })
      await manage(f, agent, 'unpin', ['video_inspect'])
      expect(f.ctx.toolDiscovery.state(agent)).toEqual({ loaded: ['export_word', 'video_inspect'], pinned: [] })
      await manage(f, agent, 'release', ['video_inspect'])
      expect(await shown(f.ctx, agent)).toEqual(['base_read', 'export_word', 'tool_context', 'tool_search'])
      await search(f, agent, 'video_inspect')
      expect(await shown(f.ctx, agent)).toContain('video_inspect')
      const before = f.ctx.toolDiscovery.state(agent)
      const status = await manage(f, agent, 'status')
      expect(status?.isError).not.toBe(true)
      expect(f.ctx.toolDiscovery.state(agent)).toEqual(before)
    } finally { await f.dispose(); await rm(root, { recursive: true, force: true }) }
  })

  it('rejects constant-tool edits and unavailable loading without partially changing the set', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-context-invalid-'))
    const f = await fixture(root)
    try {
      const agent = await f.create('context-invalid', { setup: (scope) => { scope.tools.restrict({ deny: ['secret_delete'] }) } })
      expect((await manage(f, agent, 'pin', ['video_inspect', 'secret_delete']))?.isError).toBe(true)
      expect((await manage(f, agent, 'release', ['base_read', 'export_word']))?.isError).toBe(true)
      expect((await manage(f, agent, 'release', ['tool_context']))?.isError).toBe(true)
      expect((await manage(f, agent, 'load', []))?.isError).toBe(true)
      expect((await manage(f, agent, 'status', ['export_word']))?.isError).toBe(true)
      expect((await manage(f, agent, 'pin', ['missing_tool']))?.isError).toBe(true)
      expect(f.ctx.toolDiscovery.state(agent)).toEqual({ loaded: [], pinned: [] })
      expect(await shown(f.ctx, agent)).toEqual(['base_read', 'tool_context', 'tool_search'])
    } finally { await f.dispose(); await rm(root, { recursive: true, force: true }) }
  })

  it('loads a Bot preference before first assembly and saves edits for a fresh session', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-context-provider-'))
    const f = await fixture(root)
    try {
      let stored = ['video_inspect', 'dormant_tool']
      const write = vi.fn(async (_agent: Agent, names: readonly string[]) => { stored = [...names] })
      f.ctx.toolDiscovery.registerResidency({ matches: agent => String(agent.id).startsWith('owned-'),
        read: async () => stored, write })
      const first = await f.create('owned-first')
      expect(await shown(f.ctx, first)).toEqual(['base_read', 'tool_context', 'tool_search', 'video_inspect'])
      expect(f.ctx.toolDiscovery.state(first)).toEqual({ loaded: ['video_inspect'], pinned: ['video_inspect'] })
      await manage(f, first, 'pin', ['export_word'])
      expect(stored).toEqual(['dormant_tool', 'export_word', 'video_inspect'])
      const fresh = await f.create('owned-fresh')
      expect(f.ctx.toolDiscovery.state(fresh).pinned).toEqual(['export_word', 'video_inspect'])
      await manage(f, fresh, 'unpin', ['video_inspect'])
      expect(stored).toEqual(['dormant_tool', 'export_word'])
      expect(await shown(f.ctx, fresh)).toContain('video_inspect')
      await manage(f, fresh, 'release', ['export_word'])
      expect(stored).toEqual(['dormant_tool'])
      expect(await shown(f.ctx, fresh)).not.toContain('export_word')
      const another = await f.create('owned-another')
      expect(f.ctx.toolDiscovery.state(another)).toEqual({ loaded: [], pinned: [] })
      const unrelated = await f.create('unowned')
      expect(f.ctx.toolDiscovery.state(unrelated)).toEqual({ loaded: [], pinned: [] })
      expect(write).toHaveBeenCalledTimes(3)
    } finally { await f.dispose(); await rm(root, { recursive: true, force: true }) }
  })

  it('leaves preferences and presentation unchanged when the owning store rejects a save', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-context-save-error-'))
    const f = await fixture(root)
    try {
      const write = vi.fn(async () => { throw new Error('Preference store unavailable') })
      const dispose = f.ctx.toolDiscovery.registerResidency({ matches: () => true, read: async () => ['video_inspect'], write })
      const agent = await f.create('context-save-error')
      expect((await manage(f, agent, 'release', ['video_inspect']))?.isError).toBe(true)
      expect(f.ctx.toolDiscovery.state(agent)).toEqual({ loaded: ['video_inspect'], pinned: ['video_inspect'] })
      expect((await manage(f, agent, 'pin', ['export_word']))?.isError).toBe(true)
      expect(await shown(f.ctx, agent)).not.toContain('export_word')
      await dispose()
      await f.ctx.toolDiscovery.refresh(agent)
      expect(f.ctx.toolDiscovery.state(agent)).toEqual({ loaded: [], pinned: [] })
      expect(write).toHaveBeenCalledTimes(2)
    } finally { await f.dispose(); await rm(root, { recursive: true, force: true }) }
  })

  it('refreshes externally edited preferences and rejects overlapping preference owners', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-context-refresh-'))
    const f = await fixture(root)
    try {
      const agent = await f.create('context-refresh')
      let stored = ['video_inspect']
      f.ctx.toolDiscovery.registerResidency({ matches: () => true, read: async () => stored, write: async () => {} })
      await f.ctx.toolDiscovery.refresh(agent)
      expect(await shown(f.ctx, agent)).toContain('video_inspect')
      stored = ['export_word']
      await f.ctx.toolDiscovery.refresh(agent)
      expect(await shown(f.ctx, agent)).toEqual(['base_read', 'export_word', 'tool_context', 'tool_search'])
      const dispose = f.ctx.toolDiscovery.registerResidency({ matches: () => true, read: async () => [], write: async () => {} })
      await expect(f.ctx.toolDiscovery.refresh(agent)).rejects.toThrow('More than one')
      await dispose()
      await expect(f.ctx.toolDiscovery.refresh(agent)).resolves.toBeUndefined()
    } finally { await f.dispose(); await rm(root, { recursive: true, force: true }) }
  })

  it('restores session pins and release receipts on cold resume', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-context-resume-'))
    const first = await fixture(root)
    try {
      const agent = await first.create('context-resume')
      await manage(first, agent, 'pin', ['export_word', 'video_inspect'])
      await manage(first, agent, 'release', ['export_word'])
      await first.dispose()
      const second = await fixture(root)
      try {
        const resumed = (await second.ctx.agents.resume({ resumeSessionId: SessionId('context-resume'),
          agentOptions: { provider: 'mock', model: 'mock' } })).agent
        expect(second.ctx.toolDiscovery.state(resumed)).toEqual({ loaded: ['video_inspect'], pinned: ['video_inspect'] })
        expect(await shown(second.ctx, resumed)).not.toContain('export_word')
      } finally { await second.dispose() }
    } finally { await first.dispose(); await rm(root, { recursive: true, force: true }) }
  })

  it('applies PTC pin and release receipts to the same model presentation', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-context-ptc-'))
    const f = await fixture(root)
    try {
      await f.ctx.plugin(AssemblyRuntime)
      const runtime = f.ctx.ptcRuntime
      if (!(runtime instanceof AssemblyRuntime)) throw new Error('Missing test runtime')
      let operation = 'pin'
      runtime.behavior = async (request) => {
        const edit = request.bindings[0]?.functions.tool_context
        if (!edit) throw new Error('Missing context binding')
        return { logs: [], value: await edit({ operation, tools: ['video_inspect'] }) }
      }
      const agent = await f.create('context-ptc', { setup: (scope) => { scope.tools.presentAs('both') } })
      f.responses.push(toolCallResponse('context-pin-ptc', 'run_code', { description: 'Pin video tool.', code: 'fixture' }), textResponse('Pinned.'))
      await send(agent)
      expect(f.ctx.toolDiscovery.state(agent).pinned).toEqual(['video_inspect'])
      operation = 'release'
      f.responses.push(toolCallResponse('context-release-ptc', 'run_code', { description: 'Release video tool.', code: 'fixture' }), textResponse('Released.'))
      await send(agent)
      expect(f.ctx.toolDiscovery.state(agent)).toEqual({ loaded: [], pinned: [] })
      const assembly = await f.ctx.systemPrompt.assemble({ agent, scope: agent })
      expect(assembly.tools.map(tool => tool.name)).not.toContain('video_inspect')
      expect(assembly.sections.find(section => section.name === 'tools:sdk')?.text).not.toContain('video_inspect')
    } finally { await f.dispose(); await rm(root, { recursive: true, force: true }) }
  })


  it('serializes preference saves and preserves a concurrent successful edit after a failed save', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-context-serial-'))
    const f = await fixture(root)
    try {
      let stored: string[] = []
      let fail = true
      const entered: string[][] = []
      f.ctx.toolDiscovery.registerResidency({ matches: () => true, read: async () => [...stored],
        write: async (_agent, names) => {
          entered.push([...names])
          await Promise.resolve()
          if (fail) { fail = false; throw new Error('First save failed') }
          stored = [...names]
        } })
      const agent = await f.create('context-serial')
      const failed = f.ctx.toolDiscovery.save(agent, 'pin', ['video_inspect'])
      const succeeded = f.ctx.toolDiscovery.save(agent, 'pin', ['export_word'])
      await expect(failed).rejects.toThrow('First save failed')
      await succeeded
      expect(stored).toEqual(['export_word'])
      await Promise.all([f.ctx.toolDiscovery.save(agent, 'pin', ['video_inspect']),
        f.ctx.toolDiscovery.save(agent, 'unpin', ['export_word'])])
      expect(stored).toEqual(['video_inspect'])
      expect(entered).toEqual([['video_inspect'], ['export_word'], ['export_word', 'video_inspect'], ['video_inspect']])
    } finally { await f.dispose(); await rm(root, { recursive: true, force: true }) }
  })


  it('retains complete management receipts when status previews are cropped and rejects oversized edits before saving', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-context-budget-'))
    const f = await fixture(root, { maxResultChars: 512 })
    try {
      const names = Array.from({ length: 8 }, (_, index) => `context_budget_${index}_${'x'.repeat(12)}`)
      for (const name of names) f.ctx.tools.register(defineTool({ name, description: 'Budget fixture.', parameters: {},
        output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] }, execute: async () => 'unused' }))
      let stored: string[] = []
      const write = vi.fn(async (_agent: Agent, next: readonly string[]) => { stored = [...next] })
      f.ctx.toolDiscovery.registerResidency({ matches: () => true, read: async () => stored, write })
      const agent = await f.create('context-budget')
      const message = await manage(f, agent, 'pin', names)
      expect(message?.isError).not.toBe(true)
      const text = message?.content.filter(block => block.type === 'text').map(block => block.text).join('') ?? ''
      const parsed = z.object({ tools: z.array(z.string()),
        omitted_loaded: z.number(), omitted_pinned: z.number() }).parse(JSON.parse(text))
      expect(text.length).toBeLessThanOrEqual(512)
      expect(parsed.tools).toEqual(names)
      expect(parsed.omitted_loaded + parsed.omitted_pinned).toBeGreaterThan(0)
      expect(f.ctx.toolDiscovery.state(agent)).toEqual({ loaded: names, pinned: names })
      const oversized = Array.from({ length: 12 }, (_, index) => `oversized_context_${index}_${'x'.repeat(50)}`)
      for (const name of oversized) f.ctx.tools.register(defineTool({ name, description: 'Oversized fixture.', parameters: {},
        output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] }, execute: async () => 'unused' }))
      expect((await manage(f, agent, 'pin', oversized))?.isError).toBe(true)
      expect(write).toHaveBeenCalledTimes(1)
      expect(f.ctx.toolDiscovery.state(agent)).toEqual({ loaded: names, pinned: names })
    } finally { await f.dispose(); await rm(root, { recursive: true, force: true }) }
  })

})
