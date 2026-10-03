/** Hongguo tools belong to each creative preset, with no global or minimal contribution. */
import { readFileSync } from 'node:fs'
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import Tools from '@deepseek-ai/dsh-tools'
import { createScope } from '@deepseek-ai/dsh-scope'
import { parse as parseYaml } from 'yaml'
import { expect, it } from 'vitest'
import * as Hongguo from '../../../third_party/plugins/muse-hongguo-search/src/index.js'

interface PresetRow {
  readonly id?: string
  readonly name?: string
  readonly config?: Hongguo.HongguoConfig
}

it('activates four Hongguo tools in every creative preset and leaves minimal unchanged', async () => {
  const ctx = new Context()
  try {
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(Tools)
    for (const preset of ['standard', 'ptc', 'cordis', 'short-drama', 'editing', 'minimal']) {
      const rows = parseYaml(readFileSync(new URL(`../presets/${preset}/agent.cordis.yml`, import.meta.url), 'utf8'), {
        customTags: [{ tag: 'tag:yaml.org,2002:js', resolve: (value: string) => ({ __jsExpr: value }) }],
      }) as PresetRow[]
      const row = rows.find(candidate => candidate.id === 'muse-hongguo-search')
      if (preset === 'minimal') expect(row).toBeUndefined()
      else expect(row?.name, preset).toBe('muse-hongguo-search')
      const key = {}
      const scope = createScope(ctx, key)
      try {
        if (row !== undefined) await scope.ctx.plugin(Hongguo, row.config ?? {})
        const names = ctx.tools.schemas(key).map(tool => tool.name)
        expect(names, preset).toEqual(preset === 'minimal' ? [] : [
          'hongguo_search', 'hongguo_rankings', 'hongguo_detail', 'hongguo_collections',
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
