/** Creation's actual Loader-owned policy, persona and isolated skill contribution. */
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Group from '@deepseek-ai/cordis-plugin-group'
import * as yaml from 'js-yaml'
import { entryListSchema } from '@deepseek-ai/cordis-plugin-include'
import Sessions, { SessionId } from '@deepseek-ai/dsh-session'
import SessionProjections from '@deepseek-ai/dsh-session-projection'
import AgentRegistry, { agentEvents } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import Llm, { ToolCallId } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import Tools, { defineTool, type ToolDefinition } from '@deepseek-ai/dsh-tools'
import SkillRegistry from '@deepseek-ai/dsh-skill'
import * as SkillFilesystem from '@deepseek-ai/dsh-skill-filesystem'
import * as ToolSkill from '@deepseek-ai/dsh-tool-skill'
import * as Persona from '@deepseek-ai/dsh-persona'
import * as ToolPresentation from '@deepseek-ai/dsh-agent-tool-presentation'
import { PtcRuntime, type PtcRunRequest, type PtcRunSpec, type PtcRunResult } from '@deepseek-ai/dsh-ptc-runtime'
import AgentPresets from '@deepseek-ai/dsh-agent-preset-registry'
import { expect, it } from 'vitest'
import NativePreset from '../src/native-preset.ts'
import * as CreationPolicy from '../src/creation-policy.ts'
import * as CreationSkills from '../src/creation-skills.ts'
import { CREATION_GUIDANCE, CREATION_GUIDANCE_SECTION } from '../src/creation-guidance.ts'
import { SHORT_DRAMA_GUIDANCE, SHORT_DRAMA_GUIDANCE_SECTION } from '../src/short-drama-guidance.ts'

class RuntimeProbe extends PtcRuntime {
  readonly language = 'typescript'
  readonly isolation = 'fixture'
  last?: PtcRunSpec
  behavior: (spec: PtcRunSpec) => Promise<PtcRunResult> = () => Promise.resolve({ logs: [] })
  resolve(request: PtcRunRequest): PtcRunSpec {
    return { ...request, cwd: request.cwd ?? process.cwd(), timeoutMs: request.timeoutMs ?? 120_000 }
  }
  async run(spec: PtcRunSpec): Promise<PtcRunResult> {
    this.last = spec
    return this.behavior(spec)
  }
}

function tool(name: string, execute = () => Promise.resolve('fixture')): ToolDefinition {
  return defineTool({ name, description: name, parameters: {}, output: {
    schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }],
  }, execute })
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'muse-creation-mode-'))
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
    await ctx.plugin(RuntimeProbe)
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(AgentLoop, { agents: [] })
    await ctx.plugin(SkillRegistry)
    await ctx.plugin(SkillFilesystem, { includeDefaultRoots: false, watch: false,
      bundledSkillDir: fileURLToPath(new URL('../skills/', import.meta.url)),
      customSkillDirs: [fileURLToPath(new URL('../../../packages/drama/skills/skills/', import.meta.url))] })
    ctx.skills.register({ name: 'hidden-authoring', description: 'Launch a team', source: 'runtime', content: 'hidden body' })
    await ctx.plugin(ToolSkill)
    await ctx.plugin(AgentPresets, { default: 'creation' })
    const raw = await readFile(new URL('../presets/creation/agent.cordis.yml', import.meta.url), 'utf8')
    const rows = yaml.load(raw, { schema: entryListSchema }) as Array<{ id: string; name: string }>
    const chosen = rows.filter(row => ['persona', 'creation-policy', 'tool-presentation', 'creation-skills'].includes(row.id))
    const directory = join(root, 'creation')
    await mkdir(directory)
    await writeFile(join(directory, 'agent.cordis.yml'), yaml.dump(chosen))
    await writeFile(join(directory, 'preset.yml'), 'order: 7\n')
    const modules = new Map<string, unknown>([
      ['@deepseek-ai/dsh-desktop-host/creation-policy', CreationPolicy],
      ['@deepseek-ai/dsh-desktop-host/creation-skills', CreationSkills],
      ['@deepseek-ai/dsh-skill', SkillRegistry], ['@deepseek-ai/dsh-tool-skill', ToolSkill],
      ['@deepseek-ai/dsh-persona', Persona], ['@deepseek-ai/dsh-agent-tool-presentation', ToolPresentation],
    ])
    ctx.loader.internal = { version: 'v2', loadCache: new Map(),
      register() { throw new Error('Unexpected loader hooks') },
      getOrCreateModuleJob() { throw new Error('Unexpected loader job') },
      resolveSync() { throw new Error('Unexpected loader resolution') },
      load() { throw new Error('Unexpected loader load') }, async import(specifier: string) {
        if (!modules.has(specifier)) throw new Error(`Unexpected module ${specifier}`)
        return modules.get(specifier)
      } }
    await ctx.plugin(NativePreset, { id: 'creation', directory })
    const handle = await ctx.agents.create({ sessionId: SessionId('creation-fixture'), meta: { cwd: root, agentPreset: 'creation' },
      setup: async (agentCtx) => { await ctx.agentPresets.mount(agentCtx, 'creation') } })
    return { root, ctx, agent: handle.agent, raw, rows, runtime: ctx.ptcRuntime as RuntimeProbe }
  } catch (error) {
    await ctx.fiber.dispose()
    await rm(root, { recursive: true, force: true })
    throw error
  }
}

it('mounts a PTC-only creation persona and a complete creative tool union without delegation rows', async () => {
  const f = await fixture()
  try {
    expect(f.raw).toContain('reviewMode: self-check')
    expect(f.raw).toContain('refinementMode: source-preserving-v1')
    expect(f.raw).toContain('storyFaithfulMode: story-faithful-v2')
    expect(f.raw).toContain('trustedEvidence: true')
    expect(f.raw).not.toContain('本模式由你独立完成模型判断，不启动其他模型会话或团队，不使用委派、工作流模型编排、持续循环代理或借终端、HTTP、插件绕过模式限制。')
    expect(f.raw).not.toContain('先加载 muse-creation')
    expect(f.raw).not.toContain('tools.skill({name: "muse-creation"})')
    expect(f.rows.filter(row => /subagent|workflow|ralph|agent-team/u.test(row.name))).toEqual([])
    expect(new Set(f.rows.map(row => row.id)).size).toBe(f.rows.length)
    for (const id of ['screenplay-project', 'tool-drama-assets', 'tool-shot-script', 'tool-audio-transcribe', 'tool-video-inspect', 'drama-gate']) {
      expect(f.rows.map(row => row.id)).toContain(id)
    }
    f.ctx.tools.register(tool('read'))
    f.ctx.tools.register(tool('late-agent-alias'))
    f.agent.ctx.tools.register(tool('spawn_teammate'))
    f.ctx.systemPrompt.section({ name: 'tool:late-agent-alias', order: 1, text: 'Hidden launch instructions' })
    f.ctx.systemPrompt.section({ name: 'tool:goal', order: 1, text: 'Require a direct human goal request' })
    f.ctx.systemPrompt.section({ name: 'tool:jobs', order: 1, text: 'Collect relevant background job receipts' })
    f.ctx.systemPrompt.section({ name: 'tool:workflow', order: 1, text: 'Hidden workflow instructions' })
    f.agent.ctx.systemPrompt.section({ name: 'team:policy', order: 2, text: 'Hidden team policy' })
    const assembly = await f.ctx.systemPrompt.assemble({ agent: f.agent, scope: f.agent })
    expect(f.agent.session.deriveMessages()).toEqual([])
    const initial = await agentEvents(f.ctx, f.agent).waterfall('agent/pre-step', {
      messages: [], turn: 1, step: 1, signal: new AbortController().signal,
    }, () => Promise.resolve({ kind: 'enter' as const, messages: [] }))
    expect(initial.kind).toBe('enter')
    if (initial.kind === 'reject') throw new Error('The initial creation model step was rejected')
    const catalog = initial.messages.find(message => message.source.kind === 'skill-catalog')
    if (catalog?.source.kind !== 'skill-catalog') throw new Error('The initial creation skill catalog is missing')
    const initialNames = catalog.source.entries.map(entry => entry.name)
    for (const name of ['muse-creation', 'muse-dialogue-polish', 'shot-script-creator-9-16', 'shot-script-creator-16-9-3d', 'xiaohongshu-reference']) {
      expect(initialNames).toContain(name)
    }
    expect(JSON.stringify(catalog.content)).toContain("task clearly matches a skill's description")
    expect(assembly.sections.filter(section => section.name === CREATION_GUIDANCE_SECTION))
      .toEqual([{ name: CREATION_GUIDANCE_SECTION, interpolate: false, text: CREATION_GUIDANCE }])
    expect(assembly.sections.filter(section => section.name === SHORT_DRAMA_GUIDANCE_SECTION))
      .toEqual([{ name: SHORT_DRAMA_GUIDANCE_SECTION, interpolate: false, text: SHORT_DRAMA_GUIDANCE }])
    const sectionNames = assembly.sections.map(section => section.name)
    expect(sectionNames.indexOf('deployment:persona-prefix')).toBeLessThan(sectionNames.indexOf(CREATION_GUIDANCE_SECTION))
    expect(sectionNames.indexOf(CREATION_GUIDANCE_SECTION)).toBeLessThan(sectionNames.indexOf('tools:ptc-only'))
    expect((await f.ctx.systemPrompt.assemble({})).sections.some(section => section.name === CREATION_GUIDANCE_SECTION)).toBe(false)
    const repeated = await f.ctx.systemPrompt.assemble({ agent: f.agent, scope: f.agent })
    expect(repeated.sections.find(section => section.name === CREATION_GUIDANCE_SECTION)?.text).toBe(CREATION_GUIDANCE)
    expect(assembly.tools.map(entry => entry.name)).toEqual(['run_code'])
    const text = assembly.sections.map(entry => entry.text).join('\n')
    expect(text).toContain('Program-only SDK bindings')
    expect(text).toContain('tools.skill')
    expect(text).toContain('muse-creation')
    expect(text).toContain('## 创作共用规则')
    expect(text).toContain('下一模型轮检查')
    expect(text).toContain('旧项目、未声明项目')
    expect(text).toContain('以制作人员能基本还原故事为目标')
    expect(text).toContain('按8个有效字/秒计算预算')
    expect(text).toContain('当编写短剧镜头脚本时，建议每个镜头控制在1–4秒')
    expect(text).toContain('禁止镜头时长字段')
    expect(text).toContain('站位图仅适用于场景固定、在场人物固定、人物位置保持不变的视频包')
    expect(text).toContain('只要有人物走动、靠近、后退、换位等位置移动')
    expect(text).toContain('或人物进入场景、离开场景、换场，整个包就不使用站位图')
    expect(text).toContain('摄影机移动、切镜或人物因取景暂时画外不算人物走位或离场')
    expect(text).not.toContain('复杂调度明显改变空间关系时也不用单张图约束')
    expect(text).toContain('不为使用站位图强行拆包')
    expect(text).toContain('符合适用条件且选择使用时，一个视频包配置一张完整全景站位图')
    expect(text).toContain('一眼能看清全部在场人物各自唯一的位置')
    expect(text).toContain('3D项目不能变真人摄影，真人项目不能被强改3D')
    expect(text).toContain('生图提示明确项目风格并使用既有图作为参照')
    expect(text).toContain('保持脸型比例、材质、服装和场景渲染一致')
    expect(text).toContain('画风须通过实际看图确认，不能仅凭提示词声明或style字段验收')
    expect(text).toContain('审片先实际读取同一项目已确认的角色与场景参考图')
    expect(text).toContain('记录参考资产、时间码')
    expect(text).toContain('缺少已确认参考、看不清或风格难以区分时标为待确认，不通过、不绑定')
    expect(text).toContain('正式参考的父资产ID、材质ID及确认状态须与同一项目当前记录一致')
    expect(text).toContain('不能混合不同标准提高置信度或判通过')
    expect(text).toContain('服装相似或资产ID正确都不足以确认角色一致')
    expect(text).toContain('存在影响身份或画风的可见差异时，相关项记失败')
    expect(text).toContain('不以低清、光照或“可能版本不同”自行豁免')
    expect(text).toContain('已核实为合理镜头变化的摄影机切换、姿态、光照和普通构图偏差可以接受')
    expect(text).toContain('关键质量项失败或待确认时，包整体不得通过')
    expect(text).toContain('不绑定、不推进依赖该验收的收费操作')
    expect(text).toContain('不把渲染或真人实拍的制作来源当作看图已证实的事实')
    expect(text).toContain('风格不符的站位图不得绑定视频，先修复或重新生成并复审')
    expect(text).not.toContain('每个视频生成包配置一张完整全景站位图')
    expect(text).toContain('图中的站立、蹲下、坐下、姿势和表情不绑定视频状态')
    expect(text).toContain('各镜按镜头脚本与视频提示决定')
    expect(text).toContain('不能照搬图中的静态动作，或让应坐着、蹲着的人提前起身')
    expect(text).toContain('每镜出镜名单优先于站位图中的全包阵容')
    expect(text).toContain('需要人物走位的包用脚本和视频提示说明路径，不挂站位图')
    expect(text).toContain('只有阵容、空间布局和固定环境完全相同时才可跨包复用')
    expect(text).toContain('且各包都须符合站位图适用条件')
    expect(text).toContain('单人近景不因全景图包含多人而额外生成画外人物')
    expect(text).not.toContain('9 有效字/秒')
    expect(text).toContain('新创作视频剧本默认 story-faithful-v2')
    expect(text).toContain('新写没有原稿不捏造前后对照')
    expect(text).not.toContain('# 共同自检协议')
    expect(text).not.toContain('# 精修与修改说明')
    expect(text).not.toContain('所有模型判断由当前助手完成')
    expect(text).not.toContain('不启动额外模型会话')
    expect(text).toContain('Require a direct human goal request')
    expect(text).toContain('Collect relevant background job receipts')
    expect(text).not.toContain('Hidden launch instructions')
    expect(text).not.toContain('Hidden workflow instructions')
    expect(text).not.toContain('Hidden team policy')
    expect(text).not.toContain('spawn_teammate')
    expect(text).not.toContain('late-agent-alias')
    expect(f.ctx.tools.schemas(f.agent).map(entry => entry.name).sort()).toEqual(['read', 'run_code', 'skill'])
    for (const name of ['spawn_teammate', 'late-agent-alias']) {
      const result = await f.ctx.tools.execute({ agent: f.agent, name, arguments: {},
        callId: ToolCallId(name), signal: new AbortController().signal })
      expect(result.isError).toBe(true)
    }
  } finally { await f.ctx.fiber.dispose(); await rm(f.root, { recursive: true, force: true }) }
})

it('serves only approved skill names from an isolated Host-forwarded registry with complete resources', async () => {
  const f = await fixture()
  try {
    const skills = f.ctx.agentPresets.serviceFor(f.agent, 'skills')
    if (skills === undefined) throw new Error('Creation skill registry is missing')
    expect(skills).not.toBe(f.ctx.skills)
    const names = (await skills.list({ scope: f.agent })).map(skill => skill.name)
    expect(names).toContain('muse-creation')
    expect(names).toContain('tweet-drama-pipeline')
    expect(names).toContain('shot-script-creator-16-9-3d')
    expect(names).toContain('muse-script-editing')
    expect(names).toContain('xiaohongshu-reference')
    expect(names).not.toContain('hidden-authoring')
    expect(names).not.toContain('tweet-drama-key-manager')
    const removeOffice = f.ctx.skills.register({ name: 'office-docx', description: 'Late Office resource',
      source: 'bundled', content: 'Current Office instructions' })
    expect((await skills.snapshot({ scope: f.agent })).skills.map(skill => skill.name)).toContain('office-docx')
    expect((await skills.get('office-docx', { scope: f.agent }))?.content).toContain('Current Office instructions')
    removeOffice()
    expect((await skills.snapshot({ scope: f.agent })).skills.map(skill => skill.name)).not.toContain('office-docx')
    expect(await skills.get('office-docx', { scope: f.agent })).toBeUndefined()
    await f.agent.ctx.plugin({ inject: ['skills'], apply(ctx: Context) {
      ctx.skills.register({ name: 'muse-creation', description: 'Scoped override',
        source: 'runtime', content: 'Unapproved scoped instructions' })
    } })
    const source = await f.ctx.skills.get('muse-creation')
    const loaded = await skills.get('muse-creation', { scope: f.agent })
    expect(loaded?.resourceBase).toEqual(source?.resourceBase)
    expect(loaded?.content).toBe(source!.content)
    expect(loaded?.content).not.toContain('Unapproved scoped instructions')
    expect(loaded?.content).not.toContain('当前创作模式的执行限制')
    expect(loaded?.content).toContain('references/refinement.md')
    expect(loaded?.content).toContain('references/self-check.md')
    const dialogue = await skills.get('muse-dialogue-polish', { scope: f.agent })
    const originalDialogue = await f.ctx.skills.get('muse-dialogue-polish')
    expect(dialogue).toBeDefined()
    expect(dialogue?.content).toBe(originalDialogue?.content)
    expect(dialogue?.resourceBase).toEqual(originalDialogue?.resourceBase)
    const xiaohongshu = await skills.get('xiaohongshu-reference', { scope: f.agent })
    const originalXiaohongshu = await f.ctx.skills.get('xiaohongshu-reference')
    expect(xiaohongshu).toBeDefined()
    expect(xiaohongshu?.content).toBe(originalXiaohongshu?.content)
    expect(xiaohongshu?.resourceBase).toEqual(originalXiaohongshu?.resourceBase)
    expect(xiaohongshu?.content).toContain('用户明确另选小红书')
    expect(xiaohongshu?.content).toContain('不安装或启动服务')
    expect(xiaohongshu?.content).toContain('未明确提供 endpoint 时暂停')
    expect(await skills.get('hidden-authoring', { scope: f.agent })).toBeUndefined()
    let value: unknown
    f.runtime.behavior = async (spec) => {
      const binding = spec.bindings?.find(namespace => namespace.global === 'tools')?.functions.skill
      if (binding === undefined) throw new Error('Missing actual skill SDK binding')
      const resultValue = await binding({ name: 'muse-creation' })
      value = resultValue
      return { logs: [], value: resultValue }
    }
    const result = await f.ctx.tools.execute({ agent: f.agent, name: 'run_code', arguments: {
      description: 'Read the optional precision-edit and QA guide', code: 'return await tools.skill({name:"muse-creation"})',
    }, callId: ToolCallId('creation-skill'), signal: new AbortController().signal })
    expect(result.isError).toBe(false)
    expect(value).toMatchObject({ name: 'muse-creation', resourceBase: source!.resourceBase, content: loaded!.content })
    expect(JSON.stringify(result.content)).toContain('references/refinement.md')
    const cgSkill = await skills.get('shot-script-creator-16-9-3d', { scope: f.agent })
    const bundledCg = await readFile(new URL('../../../packages/drama/skills/skills/shot-script-creator-16-9-3d/SKILL.md', import.meta.url), 'utf8')
    expect(cgSkill?.content).toBe(bundledCg.replace(/^---\n[\s\S]*?\n---\n/u, '').trim())
    f.runtime.behavior = async (spec) => {
      const binding = spec.bindings?.find(namespace => namespace.global === 'tools')?.functions.skill
      if (binding === undefined) throw new Error('Missing actual skill SDK binding')
      const resultValue = await binding({ name: 'shot-script-creator-16-9-3d' })
      value = resultValue
      return { logs: [], value: resultValue }
    }
    const cgResult = await f.ctx.tools.execute({ agent: f.agent, name: 'run_code', arguments: {
      description: 'Read the bundled 16:9 CG shot-writing guide', code: 'return await tools.skill({name:"shot-script-creator-16-9-3d"})',
    }, callId: ToolCallId('creation-cg-skill'), signal: new AbortController().signal })
    expect(cgResult.isError).toBe(false)
    expect(value).toMatchObject({ name: 'shot-script-creator-16-9-3d', resourceBase: cgSkill!.resourceBase, content: cgSkill!.content })
    expect(JSON.stringify(cgResult.content)).toContain('真人项目不适用')
    expect(JSON.stringify(cgResult.content)).toContain('人物位置保持不变')
    expect(JSON.stringify(cgResult.content)).toContain('3D项目不能变真人摄影')
    expect(JSON.stringify(cgResult.content)).toContain('正式参考的父资产ID、材质ID及确认状态须与同一项目当前记录一致')
    expect(JSON.stringify(cgResult.content)).toContain('历史图、候选图或身份与风格未核的图只能辅助观察')
    expect(JSON.stringify(cgResult.content)).toContain('服装相似或资产ID正确都不足以确认角色一致')
    expect(JSON.stringify(cgResult.content)).toContain('关键质量项失败或待确认时，包整体不得通过')
  } finally { await f.ctx.fiber.dispose(); await rm(f.root, { recursive: true, force: true }) }
})
