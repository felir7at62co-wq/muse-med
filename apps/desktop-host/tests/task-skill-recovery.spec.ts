/** Exercise the short-drama phase rules through real compaction, persistence and model requests. */
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse as parseYaml } from 'yaml'
import { describe, expect, it } from 'vitest'
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
import * as SkillFiles from '@deepseek-ai/dsh-skill-filesystem'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import TokenMeter from '@deepseek-ai/dsh-token-meter'
import * as NativeExecutor from '@deepseek-ai/dsh-tool-executor-native'
import * as ToolSkill from '@deepseek-ai/dsh-tool-skill'
import Tools from '@deepseek-ai/dsh-tools'
import WorkingDirectory from '@deepseek-ai/dsh-working-directory'
import { MockAdapter, textResponse, toolCallResponse } from '../../../packages/core/agent-loop/tests/mock-adapter.ts'

const binding = 'muse-bind-existing-assets'
const rule = '逐字保留原对白、站位、动作、镜头顺序'
const wordRule = 'assigning paragraph `.text` destroys run formatting'
const agentOptions = { provider: 'mock', model: 'editing' }

async function setup(home: string, adapter: MockAdapter, overrides?: Pick<ToolSkill.Config, 'taskSkills' | 'taskSkillMaxChars'>) {
  // The preset keeps every loaded skill; '*' stands for all of them, the binding skill included.
  const yaml = await readFile(new URL('../presets/short-drama/agent.cordis.yml', import.meta.url), 'utf8')
  const preset = parseYaml(yaml, { customTags: [{ tag: 'tag:yaml.org,2002:js', resolve: (text: string) => text }] }) as { id: string; config?: ToolSkill.Config }[]
  const selected = preset.find(row => row.id === 'tool-skill')?.config
  if (!selected?.taskSkills?.includes('*') || selected.taskSkillMaxChars === undefined || selected.taskSkillLimit === undefined) {
    throw new Error('Missing short-drama task skill configuration')
  }
  const customSkillDirs = [new URL('../skills/', import.meta.url), new URL('../../../packages/skill/skill-office/assets/', import.meta.url)].map(url => fileURLToPath(url))
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
    await ctx.plugin(SkillFiles, { includeDefaultRoots: false, watch: false, customSkillDirs })
    await ctx.plugin(ToolSkill, {
      scopedCatalogOwner: selected.scopedCatalogOwner ?? false,
      taskSkills: overrides?.taskSkills ?? selected.taskSkills,
      taskSkillMaxChars: overrides?.taskSkillMaxChars ?? selected.taskSkillMaxChars,
      taskSkillLimit: selected.taskSkillLimit,
    }).await()
    ctx.llm.registerAdapter(['mock'], adapter)
    ctx.llm.registerAdapter(['summary'], new MockAdapter(Array.from({ length: 6 }, () => textResponse('已保存第一集的工作进度。'))))
    return ctx
  } catch (error) {
    await ctx.fiber.dispose()
    throw error
  }
}

async function turn(agent: Agent, text: string) {
  agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text }] }))
  await agent.whenIdle()
  expect(agent.session.snapshotEvents().at(-1)).toMatchObject({ type: 'turn/end', data: { reason: { kind: 'completed' } } })
}

function requestText(adapter: MockAdapter) {
  const request = adapter.requests.at(-1)
  if (!request) throw new Error('Expected an actual model request')
  return request.messages.flatMap(message => message.content).filter(block => block.type === 'text').map(block => block.text).join('\n')
}

async function compact(ctx: Context, agent: Agent) {
  const result = await ctx.compaction.compactNow(agent, new AbortController().signal)
  expect(result).not.toBeNull()
  expect(agent.session.deriveMessages().some(message => message.source?.kind === 'compact-checkpoint')).toBe(true)
}

describe('short-drama task skills', () => {
  it('restores the skills in effect after repeated compaction and a cold reopen, keeps them together and releases one', async () => {
    const home = await mkdtemp(join(tmpdir(), 'muse-task-skill-'))
    const id = SessionId('episode-1')
    const first = new MockAdapter([toolCallResponse('bind', 'skill', { name: binding }), textResponse('已绑定素材。'),
      textResponse('继续核对。'), toolCallResponse('support', 'skill', { name: 'office' }), textResponse('已读取辅助技能。')])
    let ctx = await setup(home, first)
    try {
      let handle = await ctx.agentLoop.createAgent(ctx, { sessionId: id, agentOptions, meta: { cwd: home } })
      await turn(handle.agent, '只给成稿绑定素材，保留对白。')
      expect(requestText(first).split(rule)).toHaveLength(2)
      await compact(ctx, handle.agent)
      await turn(handle.agent, '继续。')
      expect(requestText(first).split(rule)).toHaveLength(2)
      await turn(handle.agent, '查一下辅助技能，继续当前工作。')
      await compact(ctx, handle.agent)
      const checkpoints = handle.agent.session.snapshotEvents().filter(event => event.type === 'compaction/end')
      expect(checkpoints).toHaveLength(2)
      await handle.dispose()
      await ctx.fiber.dispose()

      const next = new MockAdapter([textResponse('独立会话。'), textResponse('已继续绑定。'), textResponse('开始导出。'), textResponse('按导出规则继续。'),
        toolCallResponse('end', 'end_task_skill', { name: 'office-docx' }), textResponse('已结束导出。'),
        textResponse('新任务。')])
      ctx = await setup(home, next)
      handle = await ctx.agentLoop.resume(ctx, { resumeSessionId: id, agentOptions })
      const other = await ctx.agentLoop.create(SessionId('separate'), agentOptions, { cwd: home })
      await turn(other, '你好。')
      expect(requestText(next)).not.toContain(rule)
      await turn(handle.agent, '从上次继续。')
      expect(requestText(next).split(rule)).toHaveLength(2)
      await turn(handle.agent, '/office-docx')
      expect(requestText(next)).toContain(wordRule)
      await compact(ctx, handle.agent)
      await turn(handle.agent, '继续导出。')
      expect(requestText(next).split(wordRule)).toHaveLength(2)
      expect(requestText(next).split(rule)).toHaveLength(2)
      await turn(handle.agent, '这次导出结束。')
      await compact(ctx, handle.agent)
      await turn(handle.agent, '讨论片名。')
      expect(requestText(next)).not.toContain(wordRule)
      expect(requestText(next).split(rule)).toHaveLength(2)
    } finally {
      await ctx.fiber.dispose()
      await rm(home, { recursive: true, force: true })
    }
  })

  it('asks for an explicit reload when the selected body exceeds the restoration budget or has changed', async () => {
    const home = await mkdtemp(join(tmpdir(), 'muse-task-skill-limit-'))
    const adapter = new MockAdapter(Array.from({ length: 4 }, () => textResponse('继续。')))
    const ctx = await setup(home, adapter, { taskSkillMaxChars: 512, taskSkills: ['draft-phase'] })
    try {
      const body = 'Original editing instruction. '.repeat(36)
      const release = ctx.skills.register({ name: 'draft-phase', source: 'runtime', description: 'Edit a draft.', content: body })
      const agent = await ctx.agentLoop.create(SessionId('draft'), agentOptions, { cwd: home })
      await turn(agent, '/draft-phase')
      await compact(ctx, agent)
      await turn(agent, '继续。')
      expect(requestText(adapter)).toContain('exceeds the recovery budget')
      expect(requestText(adapter)).not.toContain(body)
      release()
      ctx.skills.register({ name: 'draft-phase', source: 'runtime', description: 'Edit a draft.', content: 'New unselected instruction.' })
      await turn(agent, '继续。')
      expect(requestText(adapter)).toContain('previously loaded version of "draft-phase" is unavailable')
      expect(requestText(adapter)).not.toContain('New unselected instruction.')
    } finally {
      await ctx.fiber.dispose()
      await rm(home, { recursive: true, force: true })
    }
  })
})
