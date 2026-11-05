/** Product delegation rows drive real parent and child loops without external models. */
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Group from '@deepseek-ai/cordis-plugin-group'
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml'
import AgentRegistry, { type Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import AgentPresets from '@deepseek-ai/dsh-agent-preset-registry'
import Llm, { createUserMessage, ToolCallId } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import * as Persona from '@deepseek-ai/dsh-persona'
import Sessions, { SessionId } from '@deepseek-ai/dsh-session'
import * as JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import SessionProjections from '@deepseek-ai/dsh-session-projection'
import Skills from '@deepseek-ai/dsh-skill'
import Subagents from '@deepseek-ai/dsh-subagent'
import * as Spawn from '@deepseek-ai/dsh-subagent-spawn-in-process'
import * as Fork from '@deepseek-ai/dsh-subagent-fork-in-process'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import * as SubagentTool from '@deepseek-ai/dsh-tool-subagent'
import * as SubagentControl from '@deepseek-ai/dsh-tool-subagent-control'
import * as ToolSkill from '@deepseek-ai/dsh-tool-skill'
import Tools from '@deepseek-ai/dsh-tools'
import { defineContentToolFixture, executeModelToolFixture } from '@deepseek-ai/dsh-tool-testkit'
import * as NativeToolExecutor from '@deepseek-ai/dsh-tool-executor-native'
import LocalFs from '@deepseek-ai/dsh-fs-local'
import WorkingDirectory from '@deepseek-ai/dsh-working-directory'
import { expect, it, vi } from 'vitest'
import { MockAdapter, textResponse, toolCallResponse } from '../../../packages/core/agent-loop/tests/mock-adapter.ts'
import NativePreset from '../src/native-preset.ts'
import * as DelegationPolicy from '../src/delegation-policy.ts'

const reminderTools = ['schedule_create', 'schedule_edit', 'schedule_list', 'schedule_view']

/** Separate concurrent parent and child scripts by their asserted scheduling visibility. */
class DelegationAdapter extends MockAdapter {
  constructor(private readonly parentScript: MockAdapter, private readonly childScript: MockAdapter,
    private readonly childGate: Promise<void>, private readonly childEntered: () => void) { super([]) }

  override async *stream(options: GenerateOptions): AsyncGenerator<StreamChunk> {
    this.requests.push(options)
    if (options.tools?.some(tool => tool.name === reminderTools[0])) {
      yield* this.parentScript.stream(options)
      return
    }
    this.childEntered()
    await this.childGate
    yield* this.childScript.stream(options)
  }
}

it.each(['subagent', 'subagent_fork'])('runs %s from the product preset with inherited creative guidance', async (toolName) => {
  const root = await mkdtemp(join(tmpdir(), 'muse-delegation-'))
  const ctx = new Context()
  const childGate = Promise.withResolvers<undefined>()
  const childEntered = Promise.withResolvers<undefined>()
  try {
    ctx.baseUrl = pathToFileURL(root).href + '/'
    await ctx.plugin(Loader)
    ctx.loader.builtins.group = Group
    await ctx.plugin(Llm)
    await ctx.plugin(Sessions)
    await ctx.plugin(SessionProjections)
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(Tools)
    await ctx.plugin(NativeToolExecutor)
    await ctx.plugin(LocalFs, { cwd: root })
    await ctx.plugin(WorkingDirectory, { defaultDirectory: root }).await()
    await ctx.plugin(Skills)
    ctx.skills.register({ name: 'episode-quality-fixture', description: 'Episode continuity review', source: 'runtime',
      content: '核对本集实际素材与相邻集衔接，不凭上一集已通过推定本集已通过。' })
    await ctx.plugin(ToolSkill)
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(AgentLoop, { agents: [] }).await()
    await ctx.plugin(JsonlSessionPersistence, { root: join(root, 'sessions') }).await()
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
      ['@deepseek-ai/dsh-desktop-host/delegation-policy', DelegationPolicy],
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
    const parentScript = new MockAdapter([
      toolCallResponse('delegate-review', toolName, { description: 'Review episode continuity', prompt: '核对本集角色身份与上下集衔接，返回依据。' }),
      textResponse('子代理正在核对，等待实际完成通知。'),
      textResponse('已收集子代理核对结果，继续由主编导验收。'),
    ])
    const childScript = new MockAdapter([
      toolCallResponse('child-review-skill', 'skill', { name: 'episode-quality-fixture' }),
      textResponse('已根据本集素材核对身份与衔接，未替代主编导验收。'),
    ])
    const adapter = new DelegationAdapter(parentScript, childScript, childGate.promise, () => { childEntered.resolve(undefined) })
    ctx.llm.registerAdapter(['mock'], adapter)
    const parent = await ctx.agentLoop.create(SessionId(`short-drama-${toolName}`), { provider: 'mock', model: 'mock' }, { cwd: root })
    await ctx.agentPresets.mount(parent.ctx, 'short-drama')
    let childScheduleExecutions = 0
    const childScheduleResults: boolean[] = []
    let liveChild: Agent | undefined
    ctx.on('agent/created', ({ agent }) => {
      if (agent === parent) return
      liveChild = agent
      for (const name of reminderTools) {
        agent.ctx.effect(() => agent.ctx.tools.register(defineContentToolFixture({ name,
          description: 'Child-owned schedule fixture', parameters: {}, execute: async () => {
            childScheduleExecutions++
            return []
          } })))
      }
    })
    parent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: '让子代理核对当前集的连续性。' }] }))
    await parent.whenIdle()
    const started = parent.session.snapshotEvents().find(event => event.type === 'tool/result')
    expect(started?.data.message.isError, JSON.stringify(started?.data.message.content)).toBe(false)
    await childEntered.promise
    if (liveChild === undefined) throw new Error('The real subagent did not reach request assembly')
    for (const name of reminderTools) {
      const result = await executeModelToolFixture(liveChild.ctx, { agent: liveChild, name, arguments: {},
        callId: ToolCallId(`child-own-${name}`), signal: new AbortController().signal })
      childScheduleResults.push(result.isError)
    }
    childGate.resolve(undefined)
    await vi.waitFor(() => { expect(adapter.requests).toHaveLength(5) })
    await parent.whenIdle()
    const end = parent.session.snapshotEvents().find(event => event.type === 'turn/end')
    expect(end?.type === 'turn/end' && end.data.reason.kind === 'error' ? end.data.reason.error : undefined).toBeUndefined()
    expect(parentScript.requests).toHaveLength(3)
    expect(childScript.requests).toHaveLength(2)
    const first = parentScript.requests[0]!
    const child = childScript.requests[0]!
    const names = (first.tools ?? []).map(tool => tool.name).sort()
    expect(names).toEqual([...reminderTools, 'skill', 'subagent', 'subagent_fork', 'send_message', 'interrupt_agent', 'list_agents'].sort())
    expect(child.provider).toBe(first.provider)
    expect(child.model).toBe(first.model)
    const childNames = (child.tools ?? []).map(tool => tool.name)
    for (const name of reminderTools) expect(childNames).not.toContain(name)
    expect(childScheduleResults).toEqual(reminderTools.map(() => true))
    expect(childScheduleExecutions).toBe(0)
    const system = child.messages.filter(message => message.role === 'system').flatMap(message => message.content)
      .flatMap(part => part.type === 'text' ? [part.text] : []).join('\n')
    expect(system).toContain('你是 muse-med 短剧编导 Agent')
    expect(system).toContain('符合题材的上镜效果、角色魅力、辨识度和情绪表现')
    expect(JSON.stringify(childScript.requests[1]!.messages)).toContain('核对本集实际素材与相邻集衔接，不凭上一集已通过推定本集已通过。')
    const result = parent.session.snapshotEvents().find(event => event.type === 'tool/result')
    expect(result?.data.message.isError).toBeFalsy()
    expect(JSON.stringify(result?.data.message.content)).toContain(`started subagent ${liveChild.id}`)
    expect(JSON.stringify(parentScript.requests[2]!.messages)).toContain('未替代主编导验收')
    expect({ tools: first.tools, childTools: childNames.sort() })
      .toMatchSnapshot(`${toolName} model-visible delegation`)
  } finally {
    childGate.resolve(undefined)
    await ctx.fiber.dispose()
    await rm(root, { recursive: true, force: true })
  }
})
