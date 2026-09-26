import { readFile } from 'node:fs/promises'
import { Context } from '@deepseek-ai/cordis'
import { entryListSchema } from '@deepseek-ai/cordis-plugin-include'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import * as yaml from 'js-yaml'
import { expect, it } from 'vitest'

it('matches the public BGM catalogue without claiming a bundled analysis model', async () => {
  // Emotion values live in the catalogue, so the packaged product matches,
  // selects and downloads without a local interpreter; nothing may point the
  // plugin at a model path this installer does not ship.
  const source = await readFile(new URL('../../desktop-host/presets/short-drama/agent.cordis.yml', import.meta.url), 'utf8')
  const rows = yaml.load(source, { schema: entryListSchema }) as Array<{ id: string; name: string; config?: unknown }>
  const row = rows.find(entry => entry.id === 'perception-bgm')!
  let captured: Record<string, unknown> | undefined
  const ctx = new Context()
  try {
    await ctx.plugin(Loader)
    ctx.loader.internal = { version: 'v2', async import(specifier: string) {
      if (specifier !== row.name) throw new Error(`Unexpected module ${specifier}`)
      return { name: 'bgm-config-probe', apply(_ctx: Context, config: Record<string, unknown>) { captured = config } }
    } } as unknown as NonNullable<typeof ctx.loader.internal>
    await ctx.loader.create(row)
    await ctx.loader.await()
    for (const entry of ctx.loader.entries()) await entry.fiber?.await()
  } finally {
    await ctx.fiber.dispose()
  }
  expect(captured).toEqual({ catalogUrl: 'https://muse.tos-cn-beijing.volces.com/bgm/index.json' })
})
