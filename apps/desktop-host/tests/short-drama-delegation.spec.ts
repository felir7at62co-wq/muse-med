/** Product delegation rows drive real parent and child loops without external models. */
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Group from '@deepseek-ai/cordis-plugin-group'
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import AgentPresets from '@deepseek-ai/dsh-agent-preset-registry'
import Llm, { createUserMessage } from '@deepseek-ai/dsh-llm'
import * as Persona from '@deepseek-ai/dsh-persona'
import Sessions, { SessionId } from '@deepseek-ai/dsh-session'
import SessionProjections from '@deepseek-ai/dsh-session-projection'
import Skills from '@deepseek-ai/dsh-skill'
import Subagents from '@deepseek-ai/dsh-subagent'
import * as Spawn from '@deepseek-ai/dsh-subagent-spawn-in-process'
import * as Fork from '@deepseek-ai/dsh-subagent-fork-in-process'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import * as SubagentTool from '@deepseek-ai/dsh-tool-subagent'
import * as SubagentControl from '@deepseek-ai/dsh-tool-subagent-control'
import * as SubagentList from '@deepseek-ai/dsh-tool-subagent-control/list-agents'
import * as ToolSkill from '@deepseek-ai/dsh-tool-skill'
import Tools, { defineContentToolFixture } from '@deepseek-ai/dsh-tools'
import { expect, it } from 'vitest'
import { MockAdapter, textResponse, toolCallResponse } from '../../../packages/core/agent-loop/tests/mock-adapter.ts'
import NativePreset from '../src/native-preset.ts'

const reminderTools = ['schedule_create', 'schedule_delete', 'schedule_list', 'schedule_update']

it.each(['subagent', 'subagent_fork'])('runs %s from the product preset with inherited creative guidance', async (toolName) => {
  const root = await mkdtemp(join(tmpdir(), 'muse-delegation-'))
  const ctx = new Context()
  try {
    ctx.baseUrl = pathToFileURL(root).href + '/'
    await ctx.plugin(Loader)
    ctx.loader.builtins.group = Group
    await ctx.plugin(Llm)
    await ctx.plugin(Sessions)
    await ctx.plugin(SessionProjections)
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(Tools)
    await ctx.plugin(Skills)
    ctx.skills.register({ name: 'episode-quality-fixture', description: 'Episode continuity review', source: 'runtime',
      content: '核对本集实际素材与相邻集衔接，不凭上一集已通过推定本集已通过。' })
    await ctx.plugin(ToolSkill)
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(AgentLoop, { agents: [] })
    await ctx.plugin(Subagents)
    await ctx.plugin(Spawn, { providerName: 'spawn' })
    await ctx.plugin(Fork, { providerName: 'fork' })
    await ctx.plugin(AgentPresets, { default: 'short-drama' })
    for (const name of reminderTools) ctx.tools.register(defineContentToolFixture({ name,
      description: 'Parent-only reminder fixture', parameters: {}, execute: async () => [] }))
    const raw = await readFile(new URL('../presets/short-drama/agent.cordis.yml', import.meta.url), 'utf8')
    const rows = parseYaml(raw, { customTags: [{ tag: 'tag:yaml.org,2002:js', resolve: (value: string) => ({ __jsExpr: value }) }] }) as { id: string; name: string }[]
    const chosen = rows.filter(row => ['persona', 'delegation'].includes(row.id))
    expect(chosen.map(row => row.id)).toEqual(['persona', 'delegation'])
    expect(raw).not.toContain("name: '@deepseek-ai/dsh-tool-workflow'")
    expect(raw).not.toContain("name: '@deepseek-ai/dsh-tool-plan'")
    expect(raw).not.toContain("name: '@deepseek-ai/dsh-agent-team'")
    const directory = join(root, 'short-drama')
    await mkdir(directory)
    await writeFile(join(directory, 'agent.cordis.yml'), stringifyYaml(chosen))
    const modules = new Map<string, unknown>([
      ['@deepseek-ai/dsh-persona', Persona],
      ['@deepseek-ai/dsh-tool-subagent', SubagentTool],
      ['@deepseek-ai/dsh-tool-subagent-control', SubagentControl],
      ['@deepseek-ai/dsh-tool-subagent-control/list-agents', SubagentList],
    ])
    ctx.loader.internal = { version: 'v2', loadCache: new Map(),
      register() { throw new Error('Unexpected loader hooks') },
      getOrCreateModuleJob() { throw new Error('Unexpected loader job') },
      resolveSync() { throw new Error('Unexpected loader resolution') },
      load() { throw new Error('Unexpected loader load') }, async import(specifier: string) {
        if (!modules.has(specifier)) throw new Error(`Unexpected module ${specifier}`)
        return modules.get(specifier)
      } }
    await ctx.plugin(NativePreset, { id: 'short-drama', directory })
    const adapter = new MockAdapter([
      toolCallResponse('delegate-review', toolName, { description: 'Review episode continuity', prompt: '核对本集角色身份与上下集衔接，返回依据。', run_in_background: false }),
      toolCallResponse('child-review-skill', 'skill', { name: 'episode-quality-fixture' }),
      textResponse('已根据本集素材核对身份与衔接，未替代主编导验收。'),
      textResponse('已收集子代理核对结果，继续由主编导验收。'),
    ])
    ctx.llm.registerAdapter(['mock'], adapter)
    const parent = await ctx.agentLoop.create(SessionId(`short-drama-${toolName}`), { provider: 'mock', model: 'mock' }, { cwd: root })
    await ctx.agentPresets.mount(parent.ctx, 'short-drama')
    parent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: '让子代理核对当前集的连续性。' }] }))
    await parent.whenIdle()
    expect(adapter.requests).toHaveLength(4)
    const first = adapter.requests[0]!
    const child = adapter.requests[1]!
    const names = (first.tools ?? []).map(tool => tool.name).sort()
    expect(names).toEqual([...reminderTools, 'skill', 'subagent', 'subagent_fork', 'send_message', 'interrupt_agent', 'list_agents'].sort())
    expect(child.provider).toBe(first.provider)
    expect(child.model).toBe(first.model)
    const childNames = (child.tools ?? []).map(tool => tool.name)
    for (const name of reminderTools) expect(childNames).not.toContain(name)
    const system = child.messages.filter(message => message.role === 'system').flatMap(message => message.content)
      .flatMap(part => part.type === 'text' ? [part.text] : []).join('\n')
    expect(system).toContain('你是 muse-med 短剧编导 Agent')
    expect(system).toContain('符合题材的上镜效果、角色魅力、辨识度和情绪表现')
    expect(JSON.stringify(adapter.requests[2]!.messages)).toContain('核对本集实际素材与相邻集衔接，不凭上一集已通过推定本集已通过。')
    const result = parent.session.snapshotEvents().find(event => event.type === 'tool/result')
    expect(result?.data.message.isError).toBeFalsy()
    expect(JSON.stringify(result?.data.message.content)).toContain('未替代主编导验收')
    expect({ tools: first.tools, childTools: childNames.sort(), parentResult: result?.data.message.content })
      .toMatchSnapshot(`${toolName} model-visible delegation`)
  } finally {
    await ctx.fiber.dispose()
    await rm(root, { recursive: true, force: true })
  }
})
