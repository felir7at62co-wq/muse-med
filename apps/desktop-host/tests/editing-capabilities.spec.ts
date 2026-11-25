import { readFileSync } from 'node:fs'
import { parse as parseYaml } from 'yaml'
import { expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt, { renderPrompt } from '@deepseek-ai/dsh-system-prompt'
import { createScope } from '@deepseek-ai/dsh-scope'
import * as Persona from '@deepseek-ai/dsh-persona'
import Tools from '@deepseek-ai/dsh-tools'
import { defineContentToolFixture } from '@deepseek-ai/dsh-tool-testkit'
import * as NativeToolExecutor from '@deepseek-ai/dsh-tool-executor-native'
import WebServer from '@deepseek-ai/dsh-host-webserver'
import * as EditingPolicy from '../src/editing-policy.ts'
import * as ShortDramaGuidance from '../src/short-drama-guidance.ts'

interface PresetRow {
  readonly id: string
  readonly name: string
  readonly config?: unknown
  readonly disabled?: unknown
  readonly group?: boolean
  readonly isolate?: unknown
}

function rows(id: string): readonly PresetRow[] {
  return parseYaml(readFileSync(new URL(`../presets/${id}/agent.cordis.yml`, import.meta.url), 'utf8'), {
    customTags: [{ tag: 'tag:yaml.org,2002:js', resolve: (value: string) => ({ __jsExpr: value }) }],
  }) as PresetRow[]
}

it('combines editing delivery guidance with the short-drama production tools', () => {
  const combined = rows('short-drama')
  expect(combined.find(row => row.id === 'tool-skill')?.config).toEqual({
    scopedCatalogOwner: true, taskSkills: ['*'], taskSkillMaxChars: 20_000, taskSkillLimit: 4,
  })
  for (const id of ['editing-policy', 'short-drama-guidance', 'tool-workshop', 'tool-shot-script',
    'tool-bgm-compose', 'tool-episode-render', 'tool-fs', 'tool-office', 'tool-audio-transcribe', 'tool-video-inspect', 'present']) {
    expect(combined.some(row => row.id === id), id).toBe(true)
  }
})

it('keeps general guidance and runtime facts without restricting inherited or later tools', async () => {
  const ctx = new Context()
  try {
    await ctx.plugin(SystemPrompt, { personaPrefix: 'Global instructions.' })
    await ctx.plugin(Tools)
    await ctx.plugin(NativeToolExecutor)
    await ctx.plugin(WebServer, { host: '127.0.0.1', port: 0 })
    let model = 'deepseek-flash'
    ctx.systemPrompt.variable('model', () => model)
    ctx.systemPrompt.variable('cwd', () => '/editing-workspace')
    ctx.systemPrompt.section({ name: 'tool:guidance', order: 100, text: 'Load skills first.' })
    ctx.systemPrompt.context({ name: 'runtime:guidance', order: 1, text: 'Runtime instructions.' })
    const key = { preset: 'short-drama' }
    const scope = createScope(ctx, key)
    const config = rows('short-drama').find(row => row.id === 'persona')?.config as Persona.Config
    await scope.ctx.plugin(Persona, Persona.Config(config))
    await scope.ctx.plugin(ShortDramaGuidance)
    scope.ctx.on('system-prompt/assemble', async (assembly, _context, next) => {
      assembly.sections.push({ name: 'late:guidance', text: 'Late instructions.' })
      return next()
    })
    ctx.tools.register(defineContentToolFixture({ name: 'read', description: 'Read a file', parameters: {}, execute: async () => [] }))
    const inheritedNames = ['subagent', 'send_message', 'workflow', 'screenplay_project']
    for (const name of inheritedNames) {
      ctx.tools.register(defineContentToolFixture({ name, description: name, parameters: {}, execute: async () => [] }))
      ctx.systemPrompt.section({ name: `tool:${name}`, order: 100, text: `Inherited ${name}` })
    }
    ctx.systemPrompt.section({ name: 'team:policy', order: 100, text: 'Team rules.' })
    ctx.systemPrompt.context({ name: 'subagent:policy', order: 100, text: 'Subagent rules.' })
    const policy = await scope.ctx.plugin(EditingPolicy)
    await scope.ctx.plugin(Object.assign((inner: Context) => {
      inner.tools.register(defineContentToolFixture({ name: 'subagent', description: 'Late local tool', parameters: {}, execute: async () => [] }))
    }, { inject: ['tools'] }))
    ctx.tools.register(defineContentToolFixture({ name: 'subagent_fork', description: 'Late inherited tool', parameters: {}, execute: async () => [] }))
    const first = await ctx.systemPrompt.assemble({ scope: key })
    const prompt = renderPrompt(first)
    expect(prompt).toContain(config.prefix)
    expect(prompt).toContain('你是 muse-med 短剧编导 Agent。')
    expect(config.prefix).not.toContain('deepseek-flash')
    expect(prompt).toMatch(/整部或多集剧本的转写、改编或洗稿时，在收到请求的这一轮调用 create_goal/u)
    expect(prompt).toContain('不因提示词长、镜头多、固定秒数机械拆包')
    expect(prompt).toContain('先用 jingliu_workflows 查找当前服务提供的工作流和参数')
    expect(prompt).toContain('保存用户确认的修改后回读项目、集号、镜头、时长、素材和提示词')
    expect(first.sections.some(section => section.name === ShortDramaGuidance.SHORT_DRAMA_GUIDANCE_SECTION)).toBe(true)
    expect(prompt).toContain('按镜流该项目的引用顺序及实际素材写法核对，不往原台词中插素材编号')
    expect(prompt).toContain('核对全部在场角色身份、人数、位置关系、固定物及机位轴线')
    expect(prompt).toContain('视频包总时长不是单镜时长')
    expect(prompt).toContain('不省略原台词、必要表演或参考素材')
    expect(prompt).toContain('Load skills first.')
    expect(prompt).toContain('Late instructions.')
    expect(prompt).toContain('FS_STALE_VERSION')
    expect(prompt).toContain('文件交付默认使用 Word（.docx）')
    expect(prompt).toContain('用户明确指定其他格式时按其要求')
    expect(prompt).toContain('screenplay_export_docx')
    expect(prompt).toContain('不重新转写视频或重写剧本')
    expect(prompt).toContain('忠实转写按原声和实际事件记录')
    expect(prompt).toContain('后续围绕改编方向调整非关键桥段')
    expect(prompt).toContain('100%—110%为提示目标')
    expect(prompt).toContain('不拿纯ASR对白量冒充含动作正文的原稿字数')
    expect(prompt).toContain(`http://127.0.0.1:${ctx.webServer.port}`)
    expect(prompt).toContain('你没有隐式读取到 DOM、路由或截图')
    expect(prompt).toContain('不启动替代服务器')
    expect(prompt).toContain('短剧工作间是当前工作目录中的 short-drama/。')
    expect(prompt).toContain('Inherited screenplay_project')
    expect(prompt).toContain('Team rules.')
    expect(first.contexts.map(context => context.text)).toEqual(['Runtime instructions.', 'Subagent rules.'])
    expect(first.tools.map(tool => tool.name)).toEqual(expect.arrayContaining(['read', ...inheritedNames, 'subagent_fork']))
    for (const name of inheritedNames) expect(ctx.tools.get(name, key)).toBeDefined()
    expect(ctx.tools.get('subagent', key)?.description).toBe('Late local tool')
    expect(ctx.tools.get('subagent_fork', key)?.description).toBe('Late inherited tool')
    expect(ctx.tools.get('subagent')).toBeDefined()
    model = 'glm-5.3-flashx'
    expect(renderPrompt(await ctx.systemPrompt.assemble({ scope: key })))
      .toContain('你是 muse-med 短剧编导 Agent。')
    expect(renderPrompt(await ctx.systemPrompt.assemble())).toContain('Global instructions.')
    expect(renderPrompt(await ctx.systemPrompt.assemble())).not.toContain('用户正在使用 Muse 桌面 GUI')
    expect(renderPrompt(await ctx.systemPrompt.assemble())).not.toContain('文件交付默认使用 Word')
    await policy.dispose()
    expect(ctx.tools.get('subagent', key)?.description).toBe('Late local tool')
    const afterPolicy = renderPrompt(await ctx.systemPrompt.assemble({ scope: key }))
    expect(afterPolicy).toContain('Inherited screenplay_project')
    expect(afterPolicy).not.toContain('FS_STALE_VERSION')
    expect(afterPolicy).toContain('短剧制作：镜头、人物与节奏')
  } finally {
    await ctx.fiber.dispose()
  }
})
