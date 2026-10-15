import { readFileSync } from 'node:fs'
import { parse as parseYaml } from 'yaml'
import { expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt, { renderPrompt } from '@deepseek-ai/dsh-system-prompt'
import { createScope } from '@deepseek-ai/dsh-scope'
import * as Persona from '@deepseek-ai/dsh-persona'
import Tools, { defineContentToolFixture } from '@deepseek-ai/dsh-tools'
import WebServer from '@deepseek-ai/dsh-host-webserver'
import * as EditingPolicy from '../src/editing-policy.ts'

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

it('keeps standard editing capabilities without delegation or managed acceptance', () => {
  const standard = rows('standard')
  const editing = rows('editing')
  for (const row of standard.filter(row => !['persona', 'compaction', 'delegation'].includes(row.id))) {
    expect(editing.find(candidate => candidate.id === row.id), row.id).toEqual(row)
  }
  expect(editing.some(row => row.id === 'delegation')).toBe(false)
  expect(editing.some(row => row.id === 'screenplay-project')).toBe(false)
  expect(editing.find(row => row.id === 'editing-policy')?.name).toBe('@deepseek-ai/dsh-desktop-host/editing-policy')
  expect(editing.find(row => row.id === 'persona')?.config).not.toEqual(standard.find(row => row.id === 'persona')?.config)
})

it('keeps general guidance and runtime facts without restricting inherited or later tools', async () => {
  const ctx = new Context()
  try {
    await ctx.plugin(SystemPrompt, { personaPrefix: 'Global instructions.' })
    await ctx.plugin(Tools)
    await ctx.plugin(WebServer, { host: '127.0.0.1', port: 0 })
    let model = 'deepseek-flash'
    ctx.systemPrompt.variable('model', () => model)
    ctx.systemPrompt.variable('cwd', () => '/editing-workspace')
    ctx.systemPrompt.section({ name: 'tool:guidance', order: 100, text: 'Load skills first.' })
    ctx.systemPrompt.context({ name: 'runtime:guidance', order: 1, text: 'Runtime instructions.' })
    const key = { preset: 'editing' }
    const scope = createScope(ctx, key)
    const config = rows('editing').find(row => row.id === 'persona')?.config as Persona.Config
    await scope.ctx.plugin(Persona, Persona.Config(config))
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
    expect(prompt).toContain('你是muse-med编辑智能体，由deepseek-flash驱动')
    expect(prompt).toContain('Load skills first.')
    expect(prompt).toContain('Late instructions.')
    expect(prompt).toContain('FS_STALE_VERSION')
    expect(prompt).toContain('文件交付默认使用 Word（.docx）')
    expect(prompt).toContain('用户明确指定其他格式时按其要求')
    expect(prompt).toContain('screenplay_export_docx')
    expect(prompt).toContain('不重新转写视频或重写剧本')
    expect(prompt).toContain(`http://127.0.0.1:${ctx.webServer.port}`)
    expect(prompt).toContain('你没有隐式读取到 DOM、路由或截图')
    expect(prompt).toContain('不启动替代服务器')
    expect(prompt).toContain('当前工作目录是 /editing-workspace。')
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
      .toContain('你是muse-med编辑智能体，由glm-5.3-flashx驱动')
    expect(renderPrompt(await ctx.systemPrompt.assemble())).toContain('Global instructions.')
    expect(renderPrompt(await ctx.systemPrompt.assemble())).not.toContain('用户正在使用 Muse 桌面 GUI')
    expect(renderPrompt(await ctx.systemPrompt.assemble())).not.toContain('文件交付默认使用 Word')
    await policy.dispose()
    expect(ctx.tools.get('subagent', key)?.description).toBe('Late local tool')
    expect(renderPrompt(await ctx.systemPrompt.assemble({ scope: key }))).toContain('Inherited screenplay_project')
    expect(renderPrompt(await ctx.systemPrompt.assemble({ scope: key }))).not.toContain('FS_STALE_VERSION')
  } finally {
    await ctx.fiber.dispose()
  }
})
