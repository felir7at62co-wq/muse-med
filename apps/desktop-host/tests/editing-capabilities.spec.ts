import { readFileSync } from 'node:fs'
import { parse as parseYaml } from 'yaml'
import { expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt, { renderPrompt } from '@deepseek-ai/dsh-system-prompt'
import { createScope } from '@deepseek-ai/dsh-scope'
import * as Persona from '@deepseek-ai/dsh-persona'

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

it('gives editing every standard capability while keeping its own persona', () => {
  const standard = rows('standard')
  const editing = rows('editing')
  for (const row of standard.filter(row => row.id !== 'persona' && row.id !== 'compaction')) {
    expect(editing.find(candidate => candidate.id === row.id), row.id).toEqual(row)
  }
  expect(editing.some(row => row.id === 'editing-tools')).toBe(false)
  expect(editing.find(row => row.id === 'persona')?.config).not.toEqual(standard.find(row => row.id === 'persona')?.config)
})

it('renders only the editing identity and selected model despite other prompt contributions', async () => {
  const ctx = new Context()
  try {
    await ctx.plugin(SystemPrompt, { personaPrefix: 'Global instructions.' })
    let model = 'deepseek-flash'
    ctx.systemPrompt.variable('model', () => model)
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
    const first = await ctx.systemPrompt.assemble({ scope: key })
    expect(renderPrompt(first)).toBe('你是muse-med编辑智能体，由deepseek-flash驱动')
    expect(first.contexts).toEqual([])
    model = 'glm-5.3-flashx'
    expect(renderPrompt(await ctx.systemPrompt.assemble({ scope: key })))
      .toBe('你是muse-med编辑智能体，由glm-5.3-flashx驱动')
    expect(renderPrompt(await ctx.systemPrompt.assemble())).toContain('Global instructions.')
  } finally {
    await ctx.fiber.dispose()
  }
})
