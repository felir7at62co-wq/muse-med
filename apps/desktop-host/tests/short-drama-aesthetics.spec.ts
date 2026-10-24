/** Recorded model inputs from the product persona and filesystem-loaded creative skills. */
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
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
import * as SkillFilesystem from '@deepseek-ai/dsh-skill-filesystem'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import * as ToolSkill from '@deepseek-ai/dsh-tool-skill'
import Tools from '@deepseek-ai/dsh-tools'
import { MockAdapter, textResponse, toolCallResponse } from '../../../packages/core/agent-loop/tests/mock-adapter.ts'
import { configurationFixture } from '../../../packages/settings/settings/tests/configuration-fixture.ts'

/** Replace only the filesystem-owned skill root in recorded model input. */
function normalizeSkillRoot(text: string, root: string): string {
  return text.replaceAll(`Base directory for this skill: ${root}`, 'Base directory for this skill: <bundled-skills>/')
}

it.each(['/fixture/skills/', 'C:\\fixture\\skills\\'])('records the skill root portably for %s without rewriting instruction paths', (root) => {
  const text = `Base directory for this skill: ${root}shot-script-creator-9-16\nKeep scripts\\verify.py and /project/assets unchanged.`
  expect(normalizeSkillRoot(text, root)).toBe('Base directory for this skill: <bundled-skills>/shot-script-creator-9-16\nKeep scripts\\verify.py and /project/assets unchanged.')
})

it('delivers current creative direction and full shot-writing skills', async () => {
  const raw = await readFile(new URL('../presets/short-drama/agent.cordis.yml', import.meta.url), 'utf8')
  const rows = parseYaml(raw, { customTags: [{ tag: 'tag:yaml.org,2002:js', resolve: (value: string) => ({ __jsExpr: value }) }] }) as { id: string; config?: Persona.Config }[]
  const persona = rows.find(row => row.id === 'persona')?.config
  if (persona === undefined) throw new Error('The product short-drama persona is missing')
  const skillRoot = fileURLToPath(new URL('../../../packages/drama/skills/skills/', import.meta.url))
  const { ctx, home } = await configurationFixture({ hmr: false, rows: [
    { id: 'prompt', name: 'cordis:prompt' }, { id: 'tools', name: 'cordis:tools' },
    { id: 'skills', name: 'cordis:skills' },
    { id: 'skill-files', name: 'cordis:skill-files', config: { includeDefaultRoots: false, watch: false, customSkillDirs: [skillRoot] } },
  ], builtins: { prompt: SystemPrompt, tools: Tools, skills: Skills, 'skill-files': SkillFilesystem,
    persona: Persona, 'skill-tool': ToolSkill } })
  try {
    await ctx.plugin(Llm); await ctx.plugin(Sessions); await ctx.plugin(SessionProjections)
    await ctx.plugin(AgentRegistry); await ctx.plugin(AgentLoop, { agents: [] })
    await ctx.plugin(AgentPresets, { default: 'short-drama-aesthetics' })
    const remove = await ctx.agentPresets.register({ id: 'short-drama-aesthetics', plugins: [{ name: 'cordis:persona', config: persona }] })
    ctx.effect(() => remove)
    await ctx.loader.create({ name: 'cordis:skill-tool' })
    await ctx.loader.await()
    const names = ['anime-3d-assets', 'tweet-drama-project-bible', 'tweet-drama-asset-vision-check',
      'shot-script-creator-16-9-3d', 'shot-script-creator-9-16']
    const adapter = new MockAdapter([
      ...names.map((name, index) => toolCallResponse(`skill-${index}`, 'skill', { name })),
      textResponse('已读取短剧创作与资产风格指导。'),
    ])
    ctx.llm.registerAdapter(['mock'], adapter)
    const agent = await ctx.agentLoop.create(SessionId('short-drama-aesthetics'), { provider: 'mock', model: 'mock' }, { cwd: home })
    await ctx.agentPresets.mount(agent.ctx, 'short-drama-aesthetics')
    agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: '为短剧设计有魅力的3D角色，并沿用我认可的妆造。' }] }))
    await agent.whenIdle()
    const system = adapter.requests[0]!.messages.filter(message => message.role === 'system')
      .flatMap(message => message.content).filter(part => part.type === 'text').map(part => part.text).join('\n')
    expect(system).toContain(persona.prefix)
    expect(system).toContain('次世代高精度建模 CG，物理可信 PBR 材质')
    expect(system).toContain('否定句、负面提示、全局禁止、反例与备注')
    expect(system).toContain('不得把上述禁用清单复制进生成提示词')
    expect(system).toContain('prompt_risk_review是字面命中提示')
    expect(system).toContain('修正后重新预览、保存并核对逐卡真实回读')
    expect(system).toContain('只有确认失败与对应词语有关时')
    expect(system).toContain('适合短剧的形象、妆造、配色、用光和氛围')
    expect(system).toContain('符合题材的上镜效果、角色魅力、辨识度和情绪表现')
    expect(system).toContain('人物角色资产图优先遵循当前项目已定画幅与交付用途')
    expect(system).not.toContain('人物角色资产图固定为16:9横版')
    expect(system).toContain('不凭提示词、参数或任务成功就宣称艺术效果达标')
    expect(system).not.toContain('drama_shot')
    const results = agent.session.snapshotEvents().filter(event => event.type === 'tool/result')
    expect(results).toHaveLength(names.length)
    const bodies = results.map((result) => {
      expect(result.data.message.isError).toBeFalsy()
      return result.data.message.content.filter(part => part.type === 'text')
        .map(part => normalizeSkillRoot(part.text, skillRoot)).join('\n')
    })
    expect(adapter.requests).toHaveLength(names.length + 1)
    const finalMessages = JSON.stringify(adapter.requests.at(-1)!.messages)
    for (const result of results) expect(finalMessages).toContain(JSON.stringify(result.data.message.content[0]).slice(1, -1))
    expect(bodies.join('\n')).not.toContain('土得帅')
    expect(bodies[0]).not.toContain('每次生成前必读')
    expect(bodies[0]).toContain('时段与天气分开判断')
    for (const name of ['shot-script-creator-16-9-3d', 'shot-script-creator-9-16']) {
      const content = await readFile(new URL(`${name}/SKILL.md`, `file://${skillRoot}`))
      expect(bodies[names.indexOf(name)]).toContain(content.toString('utf8').replace(/^---\n[\s\S]*?\n---\n/u, '').trim())
      expect(bodies[names.indexOf(name)]).not.toContain('drama_shot')
      expect(bodies[names.indexOf(name)]).not.toContain('15秒信息密度')
      expect(bodies[names.indexOf(name)]).toContain('写卡使用 `jubian_storyboard` 的预览、保存和真实回读')
      expect(bodies[names.indexOf(name)]).toContain('分辨率以当前会话的视频选择为准')
      expect(bodies[names.indexOf(name)]).toContain('核心场景')
      expect(bodies[names.indexOf(name)]).toContain('时段、天气/天空和可见光线')
      expect(bodies[names.indexOf(name)]).toContain('不为此额外生成场景图或站位图')
      expect(bodies[names.indexOf(name)]).toContain('多地点段落按剧情顺序分别写并在剪辑中衔接')
    }
    expect(bodies[names.indexOf('shot-script-creator-9-16')]).toContain('首次进入新地点')
    expect({ persona: persona.prefix, loadedSkills: bodies }).toMatchSnapshot('short-drama creative guidance')
  } finally { await ctx.fiber.dispose() }
})
