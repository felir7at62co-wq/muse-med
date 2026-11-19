/** Several task skills stay in effect together, and tools can require one before they run. */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry, { type Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import BasicCompaction from '@deepseek-ai/dsh-compaction-basic'
import LocalFs from '@deepseek-ai/dsh-fs-local'
import Llm, { createUserMessage } from '@deepseek-ai/dsh-llm'
import Sessions, { SessionId } from '@deepseek-ai/dsh-session'
import * as Jsonl from '@deepseek-ai/dsh-session-persistence-jsonl'
import Projections from '@deepseek-ai/dsh-session-projection'
import Skills from '@deepseek-ai/dsh-skill'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import TokenMeter from '@deepseek-ai/dsh-token-meter'
import * as NativeExecutor from '@deepseek-ai/dsh-tool-executor-native'
import * as ToolSkill from '@deepseek-ai/dsh-tool-skill'
import Tools, { defineTool } from '@deepseek-ai/dsh-tools'
import WorkingDirectory from '@deepseek-ai/dsh-working-directory'
import { MockAdapter, textResponse, toolCallResponse } from '../../../packages/core/agent-loop/tests/mock-adapter.ts'

const agentOptions = { provider: 'mock', model: 'editing' }
const rules = { 'craft-a': 'Rule A: keep every original line.', 'craft-b': 'Rule B: write against the scene image.', 'craft-c': 'Rule C: lock before generating.' }

async function setup(home: string, adapter: MockAdapter, config: ToolSkill.Config): Promise<Context> {
  const ctx = new Context()
  try {
    await ctx.plugin(Llm)
    await ctx.plugin(Projections)
    await ctx.plugin(Jsonl, { root: join(home, 'sessions'), compression: 'none' })
    await ctx.plugin(Sessions)
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(Tools)
    await ctx.plugin(NativeExecutor)
    await ctx.plugin(LocalFs, { cwd: home })
    await ctx.plugin(WorkingDirectory, { defaultDirectory: home })
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(AgentLoop, { agents: [] })
    await ctx.plugin(TokenMeter)
    await ctx.plugin(BasicCompaction, { auto: false, summarizationProvider: 'summary', summarizationModel: 'summary' })
    await ctx.plugin(Skills)
    for (const [name, content] of Object.entries(rules)) ctx.skills.register({ name, source: 'runtime', description: `Use for ${name}.`, content })
    ctx.tools.register(defineTool({ name: 'studio_run', description: 'Run one studio operation.', parameters: {},
      output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
      async execute() { return 'studio ran' } }))
    ctx.tools.register(defineTool({ name: 'lookup', description: 'Look something up.', parameters: {},
      output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
      async execute() { return 'looked up' } }))
    await ctx.plugin(ToolSkill, config).await()
    ctx.llm.registerAdapter(['mock'], adapter)
    ctx.llm.registerAdapter(['summary'], new MockAdapter(Array.from({ length: 6 }, () => textResponse('Progress saved.'))))
    return ctx
  } catch (error) {
    await ctx.fiber.dispose()
    throw error
  }
}

async function turn(agent: Agent, text: string): Promise<void> {
  agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text }] }))
  await agent.whenIdle()
  expect(agent.session.snapshotEvents().at(-1)).toMatchObject({ type: 'turn/end', data: { reason: { kind: 'completed' } } })
}

function requestText(adapter: MockAdapter): string {
  const request = adapter.requests.at(-1)
  if (!request) throw new Error('Expected an actual model request')
  return request.messages.flatMap(message => message.content).filter(block => block.type === 'text').map(block => block.text).join('\n')
}

function results(agent: Agent): { error: boolean; text: string }[] {
  return agent.session.snapshotEvents().flatMap(event => event.type === 'tool/result'
    ? [{ error: event.data.message.isError === true,
      text: event.data.message.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n') }]
    : [])
}

async function compact(ctx: Context, agent: Agent): Promise<void> {
  expect(await ctx.compaction.compactNow(agent, new AbortController().signal)).not.toBeNull()
}

it('keeps several task skills in effect, restores each after compaction and releases the oldest beyond the limit', async () => {
  const home = await mkdtemp(join(tmpdir(), 'muse-task-skills-'))
  const adapter = new MockAdapter([
    toolCallResponse('a', 'skill', { name: 'craft-a' }), toolCallResponse('b', 'skill', { name: 'craft-b' }), textResponse('Loaded two.'),
    textResponse('Continuing with both.'),
    toolCallResponse('c', 'skill', { name: 'craft-c' }), textResponse('Loaded a third.'),
    toolCallResponse('end-a', 'end_task_skill', { name: 'craft-a' }), textResponse('A was already released.'),
    textResponse('Continuing with two.'),
  ])
  const ctx = await setup(home, adapter, { taskSkills: ['*'], taskSkillLimit: 2, taskSkillMaxChars: 2048 })
  try {
    const agent = await ctx.agentLoop.create(SessionId('several'), agentOptions, { cwd: home })
    await turn(agent, 'Load the two skills for this task.')
    await compact(ctx, agent)
    await turn(agent, 'Continue.')
    expect(requestText(adapter).split(rules['craft-a'])).toHaveLength(2)
    expect(requestText(adapter).split(rules['craft-b'])).toHaveLength(2)
    expect(adapter.requests.at(-1)?.tools?.find(tool => tool.name === 'end_task_skill')?.description).toContain('Up to 2 task skills stay in effect together')

    await turn(agent, 'Now load the third.')
    await turn(agent, 'Release A.')
    expect(results(agent).at(-1)).toMatchObject({ error: true })
    expect(results(agent).at(-1)?.text).toContain('The named task skill is not active.')
    await compact(ctx, agent)
    await turn(agent, 'Continue.')
    expect(requestText(adapter)).not.toContain(rules['craft-a'])
    expect(requestText(adapter).split(rules['craft-b'])).toHaveLength(2)
    expect(requestText(adapter).split(rules['craft-c'])).toHaveLength(2)
  } finally {
    await ctx.fiber.dispose()
    await rm(home, { recursive: true, force: true })
  }
})

it('moves the task skills in effect to a continuation Session, where they survive compaction', async () => {
  const home = await mkdtemp(join(tmpdir(), 'muse-task-skill-carry-'))
  const adapter = new MockAdapter([
    toolCallResponse('a', 'skill', { name: 'craft-a' }), toolCallResponse('b', 'skill', { name: 'craft-b' }), textResponse('Loaded two.'),
    textResponse('Picked up in the next part.'), textResponse('Still going.'), textResponse('A fresh start.'), textResponse('Nothing came along.'),
  ])
  const ctx = await setup(home, adapter, { taskSkills: ['*'], taskSkillLimit: 2, taskSkillMaxChars: 2048 })
  try {
    const first = await ctx.agentLoop.create(SessionId('part-1'), agentOptions, { cwd: home })
    await turn(first, 'Load the two skills for this task.')
    const second = await ctx.agentLoop.create(SessionId('part-2'), agentOptions, { cwd: home })
    ctx.emit('task-skill/carry', { from: first, to: second })
    await turn(second, 'Here is where the earlier part stopped.')
    const opening = requestText(adapter)
    expect(opening.split(rules['craft-a'])).toHaveLength(2)
    expect(opening.split(rules['craft-b'])).toHaveLength(2)
    expect(opening.indexOf('Here is where the earlier part stopped.')).toBeLessThan(opening.indexOf(rules['craft-a']))
    expect(second.session.snapshotEvents().flatMap(event => event.type === 'user/message' && event.data.source.kind === 'skill-invocation'
      ? [event.data.source.name] : [])).toEqual(['craft-a', 'craft-b'])
    await compact(ctx, second)
    await turn(second, 'Continue.')
    expect(requestText(adapter).split(rules['craft-a'])).toHaveLength(2)
    expect(requestText(adapter).split(rules['craft-b'])).toHaveLength(2)

    const unrelated = await ctx.agentLoop.create(SessionId('unrelated'), agentOptions, { cwd: home })
    await turn(unrelated, 'Hello.')
    expect(requestText(adapter)).not.toContain(rules['craft-a'])
    const empty = await ctx.agentLoop.create(SessionId('after-unrelated'), agentOptions, { cwd: home })
    ctx.emit('task-skill/carry', { from: unrelated, to: empty })
    await turn(empty, 'Hello again.')
    expect(requestText(adapter)).not.toContain(rules['craft-a'])
  } finally {
    await ctx.fiber.dispose()
    await rm(home, { recursive: true, force: true })
  }
})

it('leaves behind a task skill that is gone when the continuation takes its first step', async () => {
  const home = await mkdtemp(join(tmpdir(), 'muse-task-skill-carry-gone-'))
  const adapter = new MockAdapter([toolCallResponse('t', 'skill', { name: 'craft-temp' }), textResponse('Loaded.'), textResponse('Going on without it.')])
  const ctx = await setup(home, adapter, { taskSkills: ['*'], taskSkillLimit: 2, taskSkillMaxChars: 2048 })
  try {
    const release = ctx.skills.register({ name: 'craft-temp', source: 'runtime', description: 'Use for a short while.', content: 'Rule T: only for today.' })
    const first = await ctx.agentLoop.create(SessionId('part-1'), agentOptions, { cwd: home })
    await turn(first, 'Load the temporary skill.')
    const second = await ctx.agentLoop.create(SessionId('part-2'), agentOptions, { cwd: home })
    ctx.emit('task-skill/carry', { from: first, to: second })
    release()
    await turn(second, 'Carry on.')
    expect(requestText(adapter)).not.toContain('Rule T: only for today.')
    expect(second.session.snapshotEvents().some(event => event.type === 'user/message' && event.data.source.kind === 'skill-invocation')).toBe(false)
  } finally {
    await ctx.fiber.dispose()
    await rm(home, { recursive: true, force: true })
  }
})

it('refuses a tool until its task skill is in effect, and again after that skill is released', async () => {
  const home = await mkdtemp(join(tmpdir(), 'muse-tool-skills-'))
  const adapter = new MockAdapter([
    toolCallResponse('early', 'studio_run', {}), toolCallResponse('free', 'lookup', {}),
    toolCallResponse('load', 'skill', { name: 'craft-a' }), toolCallResponse('ready', 'studio_run', {}),
    toolCallResponse('end', 'end_task_skill', { name: 'craft-a' }), toolCallResponse('late', 'studio_run', {}),
    textResponse('Done.'),
  ])
  const ctx = await setup(home, adapter, { taskSkills: ['craft-a', 'craft-b'], taskSkillLimit: 2,
    toolSkills: [{ tools: ['studio_*'], skill: 'craft-a' }] })
  try {
    const agent = await ctx.agentLoop.create(SessionId('required'), agentOptions, { cwd: home })
    await turn(agent, 'Run the studio operation.')
    const [early, free, load, ready, end, late] = results(agent)
    expect(early).toMatchObject({ error: true })
    expect(early?.text).toContain('Load the "craft-a" skill with the skill tool before calling studio_run')
    expect(free).toEqual({ error: false, text: 'looked up' })
    expect(load?.text).toContain(rules['craft-a'])
    expect(ready).toEqual({ error: false, text: 'studio ran' })
    expect(end).toMatchObject({ error: false })
    expect(late).toMatchObject({ error: true })
    expect(late?.text).toContain('Load the "craft-a" skill')
  } finally {
    await ctx.fiber.dispose()
    await rm(home, { recursive: true, force: true })
  }
})

it.each([
  ['a tool rule naming a skill outside the task skills', { taskSkills: ['craft-b'], toolSkills: [{ tools: ['studio_run'], skill: 'craft-a' }] }],
  ['tool rules without any task skill', { toolSkills: [{ tools: ['studio_run'], skill: 'craft-a' }] }],
  ['a rule without tools', { taskSkills: ['*'], toolSkills: [{ tools: [], skill: 'craft-a' }] }],
  ['a rule matching every tool', { taskSkills: ['*'], toolSkills: [{ tools: ['*'], skill: 'craft-a' }] }],
  ['a limit of zero', { taskSkills: ['*'], taskSkillLimit: 0 }],
  ['a limit above sixteen', { taskSkills: ['*'], taskSkillLimit: 17 }],
] satisfies [string, ToolSkill.Config][])('rejects %s when the plugin loads', async (_label, config) => {
  const home = await mkdtemp(join(tmpdir(), 'muse-tool-skills-config-'))
  try {
    await expect(setup(home, new MockAdapter([]), config)).rejects.toThrow()
  } finally { await rm(home, { recursive: true, force: true }) }
})
