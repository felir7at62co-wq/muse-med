/** Recorded model inputs from the product persona and filesystem-loaded creative skills. */
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { parse as parseYaml } from 'yaml'
import { expect, it } from 'vitest'
import * as Direction from '../src/short-drama-guidance.ts'
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
import * as NativeToolExecutor from '@deepseek-ai/dsh-tool-executor-native'
import LocalFs from '@deepseek-ai/dsh-fs-local'
import WorkingDirectory from '@deepseek-ai/dsh-working-directory'
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

it('keeps shot requirements resident and loads creative direction with skills', async () => {
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
    persona: Persona, direction: Direction, 'skill-tool': ToolSkill } })
  try {
    await ctx.plugin(Llm); await ctx.plugin(Sessions); await ctx.plugin(SessionProjections)
    await ctx.plugin(NativeToolExecutor)
    await ctx.plugin(LocalFs, { cwd: home })
    await ctx.plugin(WorkingDirectory, { defaultDirectory: home }).await()
    await ctx.plugin(AgentRegistry); await ctx.plugin(AgentLoop, { agents: [] }).await()
    await ctx.plugin(AgentPresets, { default: 'short-drama-aesthetics' })
    expect(rows.some(row => row.id === 'short-drama-guidance')).toBe(true)
    const remove = await ctx.agentPresets.register({ id: 'short-drama-aesthetics', plugins: [
      { name: 'cordis:persona', config: persona }, { name: 'cordis:direction' },
    ] })
    ctx.effect(() => remove)
    await ctx.loader.create({ name: 'cordis:skill-tool' })
    await ctx.loader.await()
    const names = ['anime-3d-assets', 'protagonist-asset-sheet', 'character-reference-library', 'tweet-drama-asset-vision-check',
      'shot-script-creator-16-9-3d', 'shot-script-creator-9-16']
    const adapter = new MockAdapter([
      ...names.map((name, index) => toolCallResponse(`skill-${index}`, 'skill', { name })),
      textResponse('已读取短剧创作与资产风格指导。'),
    ])
    ctx.llm.registerAdapter(['mock'], adapter)
    const agent = await ctx.agentLoop.create(SessionId('short-drama-aesthetics'), { provider: 'mock', model: 'mock' }, { cwd: home })
    await ctx.agentPresets.mount(agent.ctx, 'short-drama-aesthetics')
    const request = '为短剧设计有魅力的3D角色，并沿用我认可的妆造。只要一个单画面全身立绘，面容清晰。'
    agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: request }] }))
    await agent.whenIdle()
    const system = adapter.requests[0]!.messages.filter(message => message.role === 'system')
      .flatMap(message => message.content).filter(part => part.type === 'text').map(part => part.text).join('\n')
    expect(system).toContain(persona.prefix)
    expect(system).not.toContain('次世代高精度建模 CG，物理可信 PBR 材质')
    expect(system).toContain('每个视频包独立写清必要的人物、风格、空间、动作和声音衔接')
    expect(system).toContain('不往原台词中插素材编号')
    expect(system).toContain('改动原稿须取得用户同意')
    expect(system).toContain('查询 get_prompt_rules 和 preview_prompt')
    expect(system).toContain('用 get_shot 回读镜头最终保存的提示词')
    expect(system).toContain('中文项目默认中文；用户指定语言时遵循指定')
    expect(system).toContain('用户要求原文作为提示词时保留原文')
    expect(system).toContain('语言选择是创作指导，不拦截生图')
    expect(system).not.toContain('适合短剧的形象、妆造、配色、用光和氛围')
    expect(system).toContain('视频包提示词默认不写时间轴')
    expect(system).toContain('不要把计划或“开始做”当作完成')
    expect(system).toContain('后文创作、精简、补空间或默认不写时间轴的建议不授权改稿')
    expect(system).toContain('正文、对白、回忆或否定句提到某人不等于该人物出镜')
    expect(system).toContain('只预览时停在展示稿')
    expect(system).toContain('切到对方反应时，延续说话人的声音和动作方向')
    expect(system).toContain('同一时空内衔接清楚的连续段落')
    expect(system).toContain('符合题材的上镜效果、角色魅力、辨识度和情绪表现')
    expect(system).toContain('所有资产图默认16:9横版')
    expect(system).toContain('用户明确指定其他比例时按指定执行')
    expect(system).toContain('资产图比例与视频成片比例分别处理')
    expect(system).toContain('人物设定板生成与交付提醒：采用默认设定板时，先查看 tweet-drama-asset-vision-check 的 references/character-delivery-layout.md 及配图')
    expect(system).toContain('只参考交付版式，不参考五官或人物形象')
    expect(system).toContain('配图默认只供看版式，不自动混入角色身份或画风参考')
    for (const requirement of ['人物素材未指定版式时，默认使用16:9横版白底设定板', '四个独立区域从左到右依次',
      '正脸胸像', '正面（0°）全身、严格侧面（90°）全身、背面（180°）全身',
      '肩部和上胸，不遮罩', '完整保留头部、发型和双脚', '纯白遮罩仅贴合右侧正面和侧面的脸部轮廓',
      '背面完整呈现后脑、发型、颈部和服装，不加任何遮罩或白块', '以正背两视图替代三视图']) {
      expect(system).toContain(requirement)
    }
    expect(system).not.toContain('人物角色资产图：16:9横版白底')
    expect(system).toContain('本轮用户明确要求单画面全身图、单视图或人物立绘时，只展示一个完整、面容可见的人物')
    expect(system).toContain('实际生图提示词用“单个人物、一个全身视图、面容清晰”等正向描述表达本次构图')
    expect(system).toContain('项目风格中的旧版式文字不覆盖本轮明确要求')
    expect(system).toContain('用户明确要求单画面时，不加载或混入四区版式模板')
    expect(system).toContain('生成、重绘主角形象或为主角换装前，必须先用 skill 加载 protagonist-asset-sheet')
    expect(system).toContain('加载 character-reference-library，检索并实际看图后决定是否参考')
    expect(system).not.toContain('未指定时可用16:9横版白底设定板')
    expect(system).not.toContain('不强套横版拼贴和三视图')
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
    expect(finalMessages).toContain(request)
    for (const result of results) expect(finalMessages).toContain(JSON.stringify(result.data.message.content[0]).slice(1, -1))
    expect(bodies[1]).toContain('主角选角与配角区分')
    expect(bodies[2]).toContain('只读')
    expect(bodies.join('\n')).not.toMatch(/jubian_|prepare_video|modelConfig\.prompt/u)
    expect(bodies.join('\n')).not.toContain('土得帅')
    expect(bodies[0]).not.toContain('每次生成前必读')
    expect(bodies[0]).toContain('左侧为正面平视的人物胸像')
    for (const requirement of ['双肩及上胸，不遮罩', '正面0°、严格侧面90°、背面180°三张并列全身图',
      '仅正面和侧面全身图的脸部区域覆盖纯白遮罩', '背面全身图完全不遮罩',
      '三视图从完整头顶到鞋底', '严禁无头、截头或裁脚']) {
      expect(bodies[0]).toContain(requirement)
    }
    expect(bodies[0]).toContain('本次需要人物设定板且未指定其他版式时')
    expect(bodies[0]).toContain('单画面全身图或立绘只展示一个完整、面容可见的人物')
    expect(bodies[0]).toContain('用户明确要求单画面时，不调用四区提示词助手')
    expect(bodies[0]).toContain('必须先用 `skill` 加载 [protagonist-asset-sheet]')
    const firstPass = await readFile(new URL('anime-3d-assets/references/first-pass-cg.md', `file://${skillRoot}`), 'utf8')
    expect(firstPass).toContain('未指定其他版式的人物设定板提示词')
    expect(firstPass).toContain('用户明确要求单画面全身图或立绘时，使用单个人物的一个完整全身视图并保留清晰面容')
    expect(bodies[names.indexOf('shot-script-creator-9-16')]).toContain('preflight <集号> --script <本集镜头脚本>')
    expect(bodies[names.indexOf('shot-script-creator-9-16')]).toContain('重复短句按次数核对')
    const summaries = await ctx.skills.list()
    for (const name of ['shot-script-creator-16-9-3d', 'shot-script-creator-9-16']) {
      const summary = summaries.find(skill => skill.name === name)
      expect(summary?.description).toContain(name === 'shot-script-creator-9-16' ? '9:16竖屏仿真人' : '16:9横屏3D写实CG')
      expect(summary?.whenToUse).toContain('写分镜')
      expect(summary?.whenToUse).toContain('改分镜')
      expect(summary?.whenToUse).toContain('把原稿转为镜头')
      expect(summary?.whenToUse).toContain('画幅或媒介未明时先核对已有项目设定')
      expect(summary?.whenToUse).toContain('不用于仅整理普通分场剧本')
      const content = await readFile(new URL(`${name}/SKILL.md`, `file://${skillRoot}`))
      expect(bodies[names.indexOf(name)]).toContain(content.toString('utf8').replace(/^---\n[\s\S]*?\n---\n/u, '').trim())
      if (name === 'shot-script-creator-9-16') {
        expect(bodies[names.indexOf(name)]).toContain('drama_shot validate` 只检查格式与建议，不能代替原文逐字预检')
      } else {
        expect(bodies[names.indexOf(name)]).not.toContain('drama_shot')
      }
      expect(bodies[names.indexOf(name)]).not.toContain('15秒信息密度')
      expect(bodies[names.indexOf(name)]).toContain('jingliu_workflows')
      expect(bodies[names.indexOf(name)]).toContain('jingliu_run')
    }
    expect({ persona: persona.prefix, direction: Direction.SHORT_DRAMA_GUIDANCE, loadedSkills: bodies }).toMatchSnapshot('short-drama creative guidance')
  } finally { await ctx.fiber.dispose() }
})
