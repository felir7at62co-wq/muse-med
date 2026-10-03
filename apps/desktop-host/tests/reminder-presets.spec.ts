/** Product presets keep reminders scoped to their own mount and exclude delegated agents. */
import { readFileSync } from 'node:fs'
import { Context } from '@deepseek-ai/cordis'
import { createScope } from '@deepseek-ai/dsh-scope'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import Tools from '@deepseek-ai/dsh-tools'
import * as ToolSchedule from '@deepseek-ai/dsh-tool-schedule'
import { parse as parseYaml } from 'yaml'
import { expect, it } from 'vitest'
import { harness } from '../../../packages/schedule/schedule/tests/harness.ts'

interface PresetRow {
  readonly id: string
  readonly name: string
  readonly config?: {
    readonly backgroundMode?: string
    readonly toolFilter?: { readonly deny?: readonly string[] }
  } | readonly PresetRow[]
}

const reminderTools = ['schedule_create', 'schedule_delete', 'schedule_list', 'schedule_update']
const presets = ['standard', 'ptc', 'cordis', 'short-drama', 'editing', 'minimal']

function rows(preset: string): readonly PresetRow[] {
  return parseYaml(readFileSync(new URL(`../presets/${preset}/agent.cordis.yml`, import.meta.url), 'utf8'), {
    customTags: [{ tag: 'tag:yaml.org,2002:js', resolve: (value: string) => ({ __jsExpr: value }) }],
  }) as PresetRow[]
}

it('registers reminders only in the five complete Muse preset scopes and disposes them with the mount', async () => {
  const { ctx } = await harness()
  try {
    for (const preset of presets) {
      const entries = rows(preset)
      const scheduleRows = entries.filter(row => row.id === 'tool-schedule')
      const clockRows = entries.filter(row => row.id === 'time-context')
      const minimal = preset === 'minimal'
      expect(scheduleRows.map(row => row.name), preset).toEqual(minimal ? [] : ['@deepseek-ai/dsh-tool-schedule'])
      expect(clockRows.map(row => row.name), preset).toEqual(minimal ? [] : ['@deepseek-ai/dsh-time-context'])
      const key = {}
      const scope = createScope(ctx, key)
      try {
        if (scheduleRows.length > 0) await scope.ctx.plugin(ToolSchedule)
        expect(ctx.tools.schemas(key).map(tool => tool.name).sort(), preset).toEqual(minimal ? [] : reminderTools)
        expect(ctx.tools.schemas()).toEqual([])
        expect(ctx.tools.schemas({})).toEqual([])
      } finally {
        await scope.dispose()
      }
      expect(ctx.tools.schemas(key)).toEqual([])
    }
  } finally {
    await ctx.fiber.dispose()
  }
})

it('filters the four reminder tools from each complete preset spawn and fork delegation', () => {
  for (const preset of presets.filter(preset => preset !== 'minimal')) {
    const delegation = rows(preset).find(row => row.id === 'delegation')
    if (delegation === undefined || !Array.isArray(delegation.config)) throw new Error(`Missing ${preset} delegation`)
    const children = delegation.config as readonly PresetRow[]
    for (const id of ['tool-subagent', 'tool-subagent-fork']) {
      const row = children.find(candidate => candidate.id === id)
      if (row === undefined || row.config === undefined || Array.isArray(row.config)) throw new Error(`Missing ${preset} ${id}`)
      const config = row.config as Exclude<PresetRow['config'], readonly PresetRow[] | undefined>
      expect(config.backgroundMode, `${preset}/${id}`).toBe('continuable')
      expect(config.toolFilter?.deny, `${preset}/${id}`).toEqual(reminderTools)
    }
  }
})

it('keeps reminders absent when the optional Host schedule service is disabled', async () => {
  const ctx = new Context()
  try {
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(Tools)
    const key = {}
    const scope = createScope(ctx, key)
    try {
      await scope.ctx.plugin(ToolSchedule)
      expect(ctx.tools.schemas(key)).toEqual([])
      expect(ctx.tools.schemas()).toEqual([])
    } finally {
      await scope.dispose()
    }
  } finally {
    await ctx.fiber.dispose()
  }
})
