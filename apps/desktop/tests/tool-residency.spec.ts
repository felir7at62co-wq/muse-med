/** Desktop tool loading through real discovery, prompt assembly, and the agent loop. */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import { loadOverlayPatches } from '@deepseek-ai/dsh-app-boot'
import Agents, { type Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import Llm, { createUserMessage } from '@deepseek-ai/dsh-llm'
import Sessions, { SessionId } from '@deepseek-ai/dsh-session'
import Projections from '@deepseek-ai/dsh-session-projection'
import Persistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import Tools, { defineTool } from '@deepseek-ai/dsh-tools'
import { expect, it } from 'vitest'
import { MockAdapter, textResponse, toolCallResponse } from '../../../packages/core/agent-loop/tests/mock-adapter.ts'
import * as Discovery from '../../../packages/core/tool-discovery/src/index.ts'

const patches = loadOverlayPatches('muse-med', fileURLToPath(new URL('../../desktop-host/config/desktop.cordis.patch.yml', import.meta.url)))
const row = patches.flatMap(patch => patch.insert ?? []).find(entry => entry.id === 'tool-discovery')
if (row?.config === undefined) throw new Error('Desktop discovery configuration is missing')
const config = row.config as Discovery.Config
const core = ['read', 'write', 'bash', 'read_image', 'video_inspect', 'ask_user', 'show_view', 'request_secret']
const professional = ['drama_shot', 'manuscript_revision', 'drama_project', 'source_recover', 'muse_production',
  'jubian_catalog', 'jubian_organize', 'jubian_find', 'drama_character_reference_project',
  'drama_character_references', 'drama_character_reference_view', 'drama_render']

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'muse-desktop-tool-residency-'))
  const ctx = new Context()
  const calls: string[] = []
  try {
    await ctx.plugin(Llm)
    await ctx.plugin(Sessions)
    await ctx.plugin(Projections)
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(Tools)
    await ctx.plugin(Agents)
    await ctx.plugin(Persistence, { root: join(root, 'sessions'), compression: 'none' })
    await ctx.plugin(AgentLoop, { agents: [] })
    for (const name of [...core, ...professional, 'mcp__example__read']) {
      ctx.tools.register(defineTool({
        name, description: `${name}: complete tool instructions. ${'The model needs this complete definition. '.repeat(12)}`,
        parameters: { value: { type: 'string', required: true, description: 'Fixture value.' } },
        output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
        execute: async ({ value }) => { calls.push(name); return `${name}:${value}` },
      }))
    }
    await ctx.plugin(Discovery, config)
    const responses: ConstructorParameters<typeof MockAdapter>[0] = []
    const adapter = new MockAdapter(responses)
    ctx.llm.registerAdapter(['mock'], adapter)
    return { ctx, adapter, responses, calls,
      create: async (id: string) => (await ctx.agents.create({ sessionId: SessionId(id),
        meta: { cwd: root }, agentOptions: { provider: 'mock', model: 'mock' } })).agent,
      dispose: async () => { await ctx.fiber.dispose(); await rm(root, { recursive: true, force: true }) },
    }
  } catch (error) { await ctx.fiber.dispose(); await rm(root, { recursive: true, force: true }); throw error }
}

async function send(agent: Agent) {
  agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Complete this fixture task.' }] }))
  await agent.whenIdle()
}

it('keeps daily and Bot card tools in the first model request without loading professional or MCP tools', async () => {
  const f = await fixture()
  try {
    const agent = await f.create('desktop-core-tools')
    f.responses.push(textResponse('Ready.'))
    await send(agent)
    const names = f.adapter.requests[0]?.tools?.map(tool => tool.name) ?? []
    expect(names).toEqual(expect.arrayContaining([...core, 'tool_search', 'tool_context']))
    for (const name of [...professional, 'mcp__example__read']) expect(names).not.toContain(name)
    expect(f.ctx.tools.get('mcp__example__read', agent)).toBeDefined()
    expect(config.alwaysLoad).toHaveLength(60)
  } finally { await f.dispose() }
})

it.each([
  ['渲染成片', 'drama_render'],
  ['查找剧变剧本', 'jubian_find'],
  ['编写分镜镜头脚本', 'drama_shot'],
  ['查看角色参考图', 'drama_character_reference_view'],
  ['mcp__example__read', 'mcp__example__read'],
])('loads complete definitions after Chinese discovery and executes %s', async (query, name) => {
  const f = await fixture()
  try {
    const agent = await f.create(`desktop-discover-${name}`)
    f.responses.push(toolCallResponse('search', 'tool_search', { query }),
      toolCallResponse('use', name, { value: 'ok' }), textResponse('Done.'))
    await send(agent)
    expect(f.calls).toEqual([name])
    expect(f.adapter.requests[0]?.tools?.some(tool => tool.name === name)).toBe(false)
    const loaded = f.adapter.requests[1]?.tools?.find(tool => tool.name === name)
    expect(loaded?.description).toContain('complete tool instructions')
    expect(loaded?.description.length).toBeGreaterThan(config.maxDescriptionChars ?? 320)
    expect(loaded?.parameters).toMatchObject({ type: 'object', properties: { value: { type: 'string' } }, required: ['value'] })
    expect(agent.session.snapshotEvents().some(event => event.type === 'tool/result'
      && event.data.message.isError)).toBe(false)
  } finally { await f.dispose() }
})

it('executes a Bot card as the first tool and retains explicit professional residency', async () => {
  const f = await fixture()
  try {
    f.ctx.toolDiscovery.registerResidency({ matches: () => true, read: async () => ['drama_render'], write: async () => {} })
    const agent = await f.create('desktop-persisted-pins')
    f.responses.push(toolCallResponse('card', 'show_view', { value: 'card' }), textResponse('Shown.'))
    await send(agent)
    expect(f.calls).toEqual(['show_view'])
    expect(f.adapter.requests[0]?.tools?.map(tool => tool.name)).toEqual(expect.arrayContaining(['show_view', 'drama_render']))
    expect(f.ctx.toolDiscovery.state(agent).pinned).toEqual(['drama_render'])
    expect(agent.session.snapshotEvents().some(event => event.type === 'tool/call' && event.data.name === 'tool_search')).toBe(false)
  } finally { await f.dispose() }
})

it('does not let discovery bypass an existing tool restriction', async () => {
  const f = await fixture()
  try {
    const agent = await f.create('desktop-restricted-discovery')
    agent.ctx.tools.restrict({ deny: ['jubian_find'] })
    f.responses.push(toolCallResponse('search', 'tool_search', { query: 'jubian_find' }), textResponse('Checked.'))
    await send(agent)
    expect(f.adapter.requests.every(request => !request.tools?.some(tool => tool.name === 'jubian_find'))).toBe(true)
    expect(f.calls).toEqual([])
  } finally { await f.dispose() }
})
