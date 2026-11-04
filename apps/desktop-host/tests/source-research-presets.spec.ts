/** Source snapshot and report tools stay scoped to the six nonminimal product presets. */
import { readFileSync } from 'node:fs'
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import Tools from '@deepseek-ai/dsh-tools'
import Agents from '@deepseek-ai/dsh-agent'
import LocalFileSystem from '@deepseek-ai/dsh-fs-local'
import { createScope } from '@deepseek-ai/dsh-scope'
import { parse as parseYaml } from 'yaml'
import { expect, it } from 'vitest'
import { loadSourceResearchPlugin } from './fixtures/source-research-plugin.ts'
import * as CreationPolicy from '../src/creation-policy.ts'

interface PresetRow {
  readonly id?: string
  readonly name?: string
}

it('registers source snapshot and report tools in every nonminimal preset and disposes each contribution', async () => {
  const ctx = new Context()
  try {
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(Tools)
    await ctx.plugin(Agents)
    await ctx.plugin(LocalFileSystem)
    const SourceResearch = await loadSourceResearchPlugin(ctx)
    for (const preset of ['standard', 'ptc', 'cordis', 'short-drama', 'creation', 'bot-coordinator', 'minimal']) {
      const rows = parseYaml(readFileSync(new URL(`../presets/${preset}/agent.cordis.yml`, import.meta.url), 'utf8'), {
        customTags: [{ tag: 'tag:yaml.org,2002:js', resolve: (value: string) => ({ __jsExpr: value }) }],
      }) as PresetRow[]
      const row = rows.find(candidate => candidate.id === 'muse-source-research')
      if (preset === 'minimal') expect(row).toBeUndefined()
      else expect(row?.name, preset).toBe('muse-source-research')
      const key = {}
      const scope = createScope(ctx, key)
      try {
        if (preset === 'creation') await scope.ctx.plugin(CreationPolicy)
        if (row !== undefined) await scope.ctx.plugin(SourceResearch)
        expect(ctx.tools.schemas(key).map(tool => tool.name).sort(), preset).toEqual(preset === 'minimal' ? [] : [
          'source_report', 'source_snapshot',
        ])
        expect(ctx.tools.schemas()).toEqual([])
      } finally {
        await scope.dispose()
      }
      expect(ctx.tools.schemas(key)).toEqual([])
    }
  } finally {
    await ctx.fiber.dispose()
  }
})
