/** The lean short-drama preset keeps every resident craft rule, moved into preset-scoped skills. */
import { readFile } from 'node:fs/promises'
import { parse as parseYaml } from 'yaml'
import { expect, it } from 'vitest'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import AgentPresets from '@deepseek-ai/dsh-agent-preset-registry'
import Llm, { createUserMessage } from '@deepseek-ai/dsh-llm'
import * as Persona from '@deepseek-ai/dsh-persona'
import Sessions, { SessionId } from '@deepseek-ai/dsh-session'
import SessionProjections from '@deepseek-ai/dsh-session-projection'
import Skills from '@deepseek-ai/dsh-skill'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import * as ToolSkill from '@deepseek-ai/dsh-tool-skill'
import Tools from '@deepseek-ai/dsh-tools'
import * as NativeToolExecutor from '@deepseek-ai/dsh-tool-executor-native'
import LocalFs from '@deepseek-ai/dsh-fs-local'
import WorkingDirectory from '@deepseek-ai/dsh-working-directory'
import { MockAdapter, textResponse, toolCallResponse } from '../../../packages/core/agent-loop/tests/mock-adapter.ts'
import { configurationFixture } from '../../../packages/settings/settings/tests/configuration-fixture.ts'
import * as Craft from '../src/craft.ts'
import { defaultPresetLayer } from '../src/default-preset.ts'
import { EDITING_ADAPTATION, EDITING_DELIVERY, EDITING_FORMAT } from '../src/editing-policy.ts'
import { SHORT_DRAMA_GUIDANCE } from '../src/short-drama-guidance.ts'

interface Row { id: string; name?: string; config?: Persona.Config & ToolSkill.Config }

async function rows(preset: string): Promise<Row[]> {
  const raw = await readFile(new URL(`../presets/${preset}/agent.cordis.yml`, import.meta.url), 'utf8')
  return parseYaml(raw, { customTags: [{ tag: 'tag:yaml.org,2002:js', resolve: (value: string) => ({ __jsExpr: value }) }] }) as Row[]
}

function prefix(list: Row[]): string {
  const text = list.find(row => row.id === 'persona')?.config?.prefix
  if (typeof text !== 'string') throw new Error('The preset persona is missing')
  return text
}

const compact = (text: string): string => text.replace(/\s+/gu, '')
const sentences = (text: string): string[] => text.split(/(?<=。)/u).map(compact).filter(sentence => sentence.length > 1)

/** Sentences of the resident prompt that the lean preset replaces or drops on purpose. */
const REPLACED = [
  // The lean persona opens with its own identity line.
  '你是muse-med短剧编导Agent。',
  // Only the section heading is dropped; the sentence after it opens muse-video-production.
  '##短剧制作：镜头、人物与节奏以下规则用于将剧本制作为视频，不把视频转写或小说改剧本的来源正文强行改成分镜。',
]

it('carries every sentence of the resident short-drama prompt into the lean persona or one of its skills', async () => {
  const lean = await rows('short-drama-v2')
  const carried = compact(prefix(lean) + Craft.readCraftSkills().map(skill => skill.content).join('\n'))
  const resident = [prefix(await rows('short-drama')), SHORT_DRAMA_GUIDANCE, EDITING_FORMAT, EDITING_ADAPTATION, EDITING_DELIVERY]
  const missing = resident.flatMap(sentences).filter(sentence => !carried.includes(sentence))
  expect(missing).toEqual(REPLACED)
  expect(carried).toContain(compact('以下规则用于将剧本制作为视频，不把视频转写或小说改剧本的来源正文强行改成分镜。'))
})

it('mounts the craft skills instead of the resident guidance rows and keeps them restorable', async () => {
  const lean = await rows('short-drama-v2')
  const full = await rows('short-drama')
  expect(lean.map(row => row.id)).not.toContain('short-drama-guidance')
  expect(lean.map(row => row.id)).not.toContain('editing-policy')
  expect(lean.find(row => row.id === 'muse-craft')?.name).toBe('@deepseek-ai/dsh-desktop-host/craft')
  const others = (list: Row[]): string[] => list.map(row => row.id).filter(id => !['short-drama-guidance', 'editing-policy', 'muse-craft'].includes(id))
  expect(others(lean)).toEqual(others(full))
  const names = Craft.readCraftSkills().map(skill => skill.name)
  expect(names).toContain('muse-script-refine')
  const skills = lean.find(row => row.id === 'tool-skill')?.config
  expect(skills).toMatchObject({ taskSkills: ['*'], taskSkillLimit: 8 })
  // Each production tool family names a craft skill of this preset; Jingliu's image and video workflows add theirs.
  expect(skills?.toolSkills?.map(rule => rule.skill).every(name => names.includes(name))).toBe(true)
  expect(skills?.toolSkills).toEqual(expect.arrayContaining([
    { tools: ['jingliu_image'], skill: 'muse-asset-design' },
    { tools: ['jingliu_run'], arguments: { workflow: ['run_asset_fill', 'run_asset_generate', 'generate_scene_views'] }, skill: 'muse-asset-design' },
    { tools: ['jingliu_*'], skill: 'muse-jingliu-production' },
    { tools: ['jingliu_run'], arguments: { workflow: ['run_shot_videos'] }, skill: 'muse-video-production' },
    { tools: ['jingliu_run'], arguments: { workflow: ['run_shot_videos'] }, skill: 'muse-blocking-reference' },
  ]))
  expect(Math.max(...Craft.readCraftSkills().map(skill => skill.content.length))).toBeLessThan(skills?.taskSkillMaxChars ?? 0)
  expect(full.find(row => row.id === 'tool-skill')?.config?.toolSkills).toBeUndefined()
  expect(prefix(lean).length).toBeLessThan(prefix(full).length * 0.6)
})

it('refuses a craft skill file whose header does not name its directory', async () => {
  const { mkdtemp, mkdir, writeFile, rm } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const root = await mkdtemp(join(tmpdir(), 'muse-craft-'))
  try {
    await mkdir(join(root, 'muse-a'))
    await writeFile(join(root, 'muse-a', 'SKILL.md'), '---\nname: muse-b\ndescription: x\n---\n\nbody\n')
    expect(() => Craft.readCraftSkills(root)).toThrow('muse-a/SKILL.md')
  } finally { await rm(root, { recursive: true, force: true }) }
})

it('gives only agents on the lean preset the craft skills, without the resident production section', async () => {
  const lean = await rows('short-drama-v2')
  const persona = lean.find(row => row.id === 'persona')?.config
  if (persona === undefined) throw new Error('The lean persona is missing')
  const { ctx, home } = await configurationFixture({ hmr: false, rows: [
    { id: 'prompt', name: 'cordis:prompt' }, { id: 'tools', name: 'cordis:tools' }, { id: 'skills', name: 'cordis:skills' },
  ], builtins: { prompt: SystemPrompt, tools: Tools, skills: Skills, persona: Persona, craft: Craft, 'skill-tool': ToolSkill } })
  try {
    await ctx.plugin(Llm); await ctx.plugin(Sessions); await ctx.plugin(SessionProjections)
    await ctx.plugin(NativeToolExecutor)
    await ctx.plugin(LocalFs, { cwd: home })
    await ctx.plugin(WorkingDirectory, { defaultDirectory: home }).await()
    await ctx.plugin(AgentRegistry); await ctx.plugin(AgentLoop, { agents: [] }).await()
    await ctx.plugin(AgentPresets, { default: 'lean' })
    const remove = await ctx.agentPresets.register({ id: 'lean', plugins: [
      { name: 'cordis:persona', config: persona }, { name: 'cordis:craft' }, { name: 'cordis:skill-tool', config: { scopedCatalogOwner: true } },
    ] })
    ctx.effect(() => remove)
    await ctx.loader.await()
    const adapter = new MockAdapter([toolCallResponse('refine', 'skill', { name: 'muse-script-refine' }), textResponse('已加载精修技能。')])
    ctx.llm.registerAdapter(['mock'], adapter)
    const agent = await ctx.agentLoop.create(SessionId('lean-refine'), { provider: 'mock', model: 'mock' }, { cwd: home })
    await ctx.agentPresets.mount(agent.ctx, 'lean')
    agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: '把第2集精修一下，去掉AI味。' }] }))
    await agent.whenIdle()
    const system = adapter.requests[0]!.messages.filter(message => message.role === 'system')
      .flatMap(message => message.content).filter(part => part.type === 'text').map(part => part.text).join('\n')
    expect(system).toContain('专业做法都在技能里，不在这里。')
    expect(system).not.toContain('站位图仅适用于场景固定')
    expect(system).not.toContain('剧本、大纲等文字稿件的文件交付默认使用 Word')
    const loaded = JSON.stringify(adapter.requests[1]!.messages)
    expect(loaded).toContain('去 AI 味的第一动作是删，不是换')
    expect(loaded).toContain('只修清单里的问题')
    expect((await ctx.skills.list({ cwd: home })).map(skill => skill.name)).not.toContain('muse-script-refine')
  } finally { await ctx.fiber.dispose() }
})

it('lets one launch start new sessions on a selectable trial preset and refuses any other id', () => {
  const config = { default: 'short-drama', selectablePresets: ['short-drama', 'short-drama-v2'], allowUserDefault: false }
  expect(defaultPresetLayer(config, undefined)).toBeUndefined()
  expect(defaultPresetLayer(config, '')).toBeUndefined()
  expect(defaultPresetLayer(config, 'short-drama-v2')).toEqual([{ id: 'agent-preset-registry', config: { ...config, default: 'short-drama-v2' } }])
  expect(() => defaultPresetLayer(config, 'creation')).toThrow('MUSE_DEFAULT_PRESET "creation" is not a selectable preset (short-drama, short-drama-v2)')
  expect(() => defaultPresetLayer(undefined, 'short-drama-v2')).toThrow('is not a selectable preset')
})
