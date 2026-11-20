/** Several task skills stay in effect together, and tool calls can require some before they run. */
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
    ctx.tools.register(defineTool({ name: 'studio_run', description: 'Run one studio operation.',
      parameters: { step: { type: 'string', description: 'The operation to run.' } },
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

function invoked(agent: Agent): string[] {
  return agent.session.snapshotEvents().flatMap(event => event.type === 'user/message' && event.data.source.kind === 'skill-invocation'
    ? [event.data.source.name] : [])
}

it('refuses a tool until its task skill is in effect, adds that skill to the conversation, and does so again after it is released', async () => {
  const home = await mkdtemp(join(tmpdir(), 'muse-tool-skills-'))
  const adapter = new MockAdapter([
    toolCallResponse('early', 'studio_run', {}), toolCallResponse('free', 'lookup', {}), toolCallResponse('ready', 'studio_run', {}),
    toolCallResponse('end', 'end_task_skill', { name: 'craft-a' }), toolCallResponse('late', 'studio_run', {}),
    toolCallResponse('again', 'studio_run', {}), textResponse('Done.'),
  ])
  const ctx = await setup(home, adapter, { taskSkills: ['craft-a', 'craft-b'], taskSkillLimit: 2,
    toolSkills: [{ tools: ['studio_*'], skill: 'craft-a' }] })
  try {
    const agent = await ctx.agentLoop.create(SessionId('required'), agentOptions, { cwd: home })
    await turn(agent, 'Run the studio operation.')
    const [early, free, ready, end, late, again] = results(agent)
    expect(early).toEqual({ error: true,
      text: 'Error: studio_run has not run: its working method is in the "craft-a" skill, now added to this conversation. Read it, then repeat the call.' })
    expect(free).toEqual({ error: false, text: 'looked up' })
    expect(ready).toEqual({ error: false, text: 'studio ran' })
    expect(end).toMatchObject({ error: false })
    expect(late).toMatchObject({ error: true })
    expect(late?.text).toContain('the "craft-a" skill, now added to this conversation')
    expect(again).toEqual({ error: false, text: 'studio ran' })
    expect(invoked(agent)).toEqual(['craft-a', 'craft-a'])
    // The skill reaches the model in the request that follows the refusal.
    const afterRefusal = adapter.requests[1]?.messages.flatMap(message => message.content).flatMap(block => block.type === 'text' ? [block.text] : []).join('\n')
    expect(afterRefusal?.split(rules['craft-a'])).toHaveLength(2)
  } finally {
    await ctx.fiber.dispose()
    await rm(home, { recursive: true, force: true })
  }
})

it('requires every skill whose rule matches a call, and a rule that names arguments only for those calls', async () => {
  const home = await mkdtemp(join(tmpdir(), 'muse-tool-skills-several-'))
  const adapter = new MockAdapter([
    toolCallResponse('plain', 'studio_run', { step: 'subtitles' }), toolCallResponse('plain-again', 'studio_run', { step: 'subtitles' }),
    toolCallResponse('unnamed', 'studio_run', {}),
    toolCallResponse('video', 'studio_run', { step: 'video' }), toolCallResponse('video-again', 'studio_run', { step: 'video' }),
    textResponse('Done.'), textResponse('Still there.'),
  ])
  const ctx = await setup(home, adapter, { taskSkills: ['*'], taskSkillLimit: 3, taskSkillMaxChars: 2048, toolSkills: [
    { tools: ['studio_*'], skill: 'craft-a' },
    { tools: ['studio_run'], arguments: { step: ['video', 'film'] }, skill: 'craft-b' },
    { tools: ['studio_run'], arguments: { step: ['video'] }, skill: 'craft-c' },
    { tools: ['studio_run'], arguments: { step: ['video'] }, skill: 'craft-b' },
  ] })
  try {
    const agent = await ctx.agentLoop.create(SessionId('several'), agentOptions, { cwd: home })
    await turn(agent, 'Do the subtitles, then the video.')
    const [plain, plainAgain, unnamed, video, videoAgain] = results(agent)
    expect(plain?.text).toContain('its working method is in the "craft-a" skill, now added to this conversation. Read it,')
    expect(plainAgain).toEqual({ error: false, text: 'studio ran' })
    expect(unnamed).toEqual({ error: false, text: 'studio ran' })
    expect(video).toEqual({ error: true,
      text: 'Error: studio_run has not run: its working method is in the "craft-b" and "craft-c" skills, now added to this conversation. Read them, then repeat the call.' })
    expect(videoAgain).toEqual({ error: false, text: 'studio ran' })
    expect(invoked(agent)).toEqual(['craft-a', 'craft-b', 'craft-c'])
    // Skills the Host added are restored after compaction like the ones the model loads.
    await compact(ctx, agent)
    await turn(agent, 'Continue.')
    for (const rule of Object.values(rules)) expect(requestText(adapter).split(rule)).toHaveLength(2)
  } finally {
    await ctx.fiber.dispose()
    await rm(home, { recursive: true, force: true })
  }
})

it('loads again a required skill that adding the others would release', async () => {
  const home = await mkdtemp(join(tmpdir(), 'muse-tool-skills-limit-'))
  const adapter = new MockAdapter([
    toolCallResponse('a', 'skill', { name: 'craft-a' }), toolCallResponse('c', 'skill', { name: 'craft-c' }),
    toolCallResponse('early', 'studio_run', {}), toolCallResponse('ready', 'studio_run', {}), textResponse('Done.'),
  ])
  const ctx = await setup(home, adapter, { taskSkills: ['*'], taskSkillLimit: 2, toolSkills: [
    { tools: ['studio_run'], skill: 'craft-a' }, { tools: ['studio_run'], skill: 'craft-b' },
  ] })
  try {
    const agent = await ctx.agentLoop.create(SessionId('limit'), agentOptions, { cwd: home })
    await turn(agent, 'Load two skills, then run the studio operation.')
    const [, , early, ready] = results(agent)
    expect(early?.text).toContain('its working method is in the "craft-b" and "craft-a" skills, now added to this conversation. Read them,')
    expect(ready).toEqual({ error: false, text: 'studio ran' })
    expect(invoked(agent)).toEqual(['craft-b', 'craft-a'])
  } finally {
    await ctx.fiber.dispose()
    await rm(home, { recursive: true, force: true })
  }
})

it('keeps the skills a refused call needs until a step is admitted', async () => {
  const home = await mkdtemp(join(tmpdir(), 'muse-tool-skills-rejected-'))
  const adapter = new MockAdapter([toolCallResponse('early', 'studio_run', {}), toolCallResponse('ready', 'studio_run', {}), textResponse('Done.')])
  const ctx = await setup(home, adapter, { taskSkills: ['*'], toolSkills: [{ tools: ['studio_run'], skill: 'craft-a' }] })
  try {
    const agent = await ctx.agentLoop.create(SessionId('rejected'), agentOptions, { cwd: home })
    let proposals = 0
    ctx.on('agent/pre-step', async (_payload, next) => {
      proposals += 1
      return proposals === 2 ? { kind: 'reject' } : next()
    })
    agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Run the studio operation.' }] }))
    await agent.whenIdle()
    expect(agent.session.snapshotEvents().at(-1)).toMatchObject({ type: 'turn/end', data: { reason: { kind: 'blocked' } } })
    expect(invoked(agent)).toEqual([])

    await turn(agent, 'Go on.')
    expect(invoked(agent)).toEqual(['craft-a'])
    expect(results(agent)).toEqual([expect.objectContaining({ error: true }), { error: false, text: 'studio ran' }])
  } finally {
    await ctx.fiber.dispose()
    await rm(home, { recursive: true, force: true })
  }
})

it('leaves a skill it cannot add to the model, and adds it once it can', async () => {
  const home = await mkdtemp(join(tmpdir(), 'muse-tool-skills-gone-'))
  const adapter = new MockAdapter([
    toolCallResponse('first', 'studio_run', {}), toolCallResponse('second', 'studio_run', {}), textResponse('The studio operation cannot run.'),
    toolCallResponse('third', 'studio_run', {}), toolCallResponse('fourth', 'studio_run', {}), textResponse('Done.'),
    toolCallResponse('model-only', 'lookup', {}), toolCallResponse('model-only-again', 'lookup', {}),
    toolCallResponse('load', 'skill', { name: 'craft-model' }), toolCallResponse('model-only-ready', 'lookup', {}), textResponse('Looked up.'),
  ])
  const ctx = await setup(home, adapter, { taskSkills: ['*'], taskSkillLimit: 4, toolSkills: [
    { tools: ['studio_run'], skill: 'craft-later' }, { tools: ['studio_run'], skill: 'craft-user' }, { tools: ['lookup'], skill: 'craft-model' },
  ] })
  try {
    const userOnly = ctx.skills.register({ name: 'craft-user', source: 'runtime', description: 'Only the user starts it.', content: 'Rule U: started by the user.',
      invocation: { modelInvocable: false, userInvocable: true } })
    ctx.skills.register({ name: 'craft-model', source: 'runtime', description: 'Only the model loads it.', content: 'Rule M: loaded by the model.',
      invocation: { modelInvocable: true, userInvocable: false } })
    const agent = await ctx.agentLoop.create(SessionId('gone'), agentOptions, { cwd: home })
    await turn(agent, 'Run the studio operation.')
    const [first, second] = results(agent)
    expect(first?.text).toContain('the "craft-later" and "craft-user" skills, now added to this conversation. Read them,')
    expect(second).toEqual({ error: true, text: 'Error: studio_run has not run: its working method is in the "craft-later" and "craft-user" skills, '
      + 'which could not be added to this conversation. Load them with the skill tool if the skill catalog lists them, then repeat the call; '
      + 'otherwise tell the user that studio_run cannot run.' })
    expect(invoked(agent)).toEqual([])

    ctx.skills.register({ name: 'craft-later', source: 'runtime', description: 'Arrives later.', content: 'Rule L: arrived later.' })
    userOnly()
    ctx.skills.register({ name: 'craft-user', source: 'runtime', description: 'Now for the model too.', content: 'Rule U: started by either.' })
    await turn(agent, 'Try again.')
    const [third, fourth] = results(agent).slice(-2)
    expect(third?.text).toContain('the "craft-later" and "craft-user" skills, now added to this conversation. Read them,')
    expect(fourth).toEqual({ error: false, text: 'studio ran' })
    expect(invoked(agent)).toEqual(['craft-later', 'craft-user'])

    await turn(agent, 'Look something up.')
    const [modelOnly, modelOnlyAgain, , modelOnlyReady] = results(agent).slice(-4)
    expect(modelOnly?.text).toContain('the "craft-model" skill, now added to this conversation. Read it,')
    expect(modelOnlyAgain?.text).toContain('the "craft-model" skill, which could not be added to this conversation. Load it with the skill tool if the skill catalog lists it,')
    expect(modelOnlyReady).toEqual({ error: false, text: 'looked up' })
    expect(invoked(agent)).toEqual(['craft-later', 'craft-user'])
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
  ['an argument without a name', { taskSkills: ['*'], toolSkills: [{ tools: ['studio_run'], arguments: { '': ['video'] }, skill: 'craft-a' }] }],
  ['an argument without values', { taskSkills: ['*'], toolSkills: [{ tools: ['studio_run'], arguments: { step: [] }, skill: 'craft-a' }] }],
  ['an argument with an empty value', { taskSkills: ['*'], toolSkills: [{ tools: ['studio_run'], arguments: { step: ['video', ''] }, skill: 'craft-a' }] }],
  ['rules that require more skills for one tool than stay in effect', { taskSkills: ['*'], taskSkillLimit: 2, toolSkills: [
    { tools: ['studio_*'], skill: 'craft-a' }, { tools: ['studio_run'], skill: 'craft-b' },
    { tools: ['studio_run'], arguments: { step: ['video'] }, skill: 'craft-c' },
  ] }],
  ['a limit of zero', { taskSkills: ['*'], taskSkillLimit: 0 }],
  ['a limit above sixteen', { taskSkills: ['*'], taskSkillLimit: 17 }],
] satisfies [string, ToolSkill.Config][])('rejects %s when the plugin loads', async (_label, config) => {
  const home = await mkdtemp(join(tmpdir(), 'muse-tool-skills-config-'))
  try {
    await expect(setup(home, new MockAdapter([]), config)).rejects.toThrow()
  } finally { await rm(home, { recursive: true, force: true }) }
})
