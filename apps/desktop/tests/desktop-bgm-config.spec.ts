import { readFile } from 'node:fs/promises'
import { Context } from '@deepseek-ai/cordis'
import { entryListSchema } from '@deepseek-ai/cordis-plugin-include'
import Loader, { type EntryOptions } from '@deepseek-ai/cordis-plugin-loader'
import * as yaml from 'js-yaml'
import { expect, it } from 'vitest'

function localEpisodeTools(rows: readonly EntryOptions[]): readonly EntryOptions[] {
  const tools: unknown = rows.find(row => row.id === 'local-episode-tools')?.config
  if (!Array.isArray(tools)) throw new Error('Missing local episode tools')
  return tools as EntryOptions[]
}

it.each(['creation', 'short-drama'])('keeps source attenuation through the %s BGM composer and final mixer', async (preset) => {
  const source = await readFile(new URL(`../../desktop-host/presets/${preset}/agent.cordis.yml`, import.meta.url), 'utf8')
  const rows = yaml.load(source, { schema: entryListSchema }) as EntryOptions[]
  const tools = localEpisodeTools(rows)
  expect(tools.find(row => row.id === 'tool-bgm-compose')?.config).toMatchObject({ maxSourceGainDb: -10 })
  expect(rows.find(row => row.id === 'perception-bgm')?.config).toMatchObject({ requireStoryEvidence: true })
  expect(tools.find(row => row.id === 'tool-episode-render')?.config).toMatchObject({ maxBgmVolume: 1 })
})

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
    ctx.loader.internal = { version: 'v2', loadCache: new Map(),
      register() { throw new Error('Unexpected loader hooks') },
      getOrCreateModuleJob() { throw new Error('Unexpected loader job') },
      resolveSync() { throw new Error('Unexpected loader resolution') },
      load() { throw new Error('Unexpected loader load') }, async import(specifier: string) {
        if (specifier !== row.name) throw new Error(`Unexpected module ${specifier}`)
        return { name: 'bgm-config-probe', apply(_ctx: Context, config: Record<string, unknown>) { captured = config } }
      } }
    await ctx.loader.create(row)
    await ctx.loader.await()
    for (const entry of ctx.loader.entries()) await entry.fiber?.await()
  } finally {
    await ctx.fiber.dispose()
  }
  expect(captured).toEqual({ catalogUrl: 'https://muse.tos-cn-beijing.volces.com/bgm/catalog.json', requireStoryEvidence: true })
})

it.each(['creation', 'short-drama'])('binds %s composition and rendering to resolved media executables', async (preset) => {
  const source = await readFile(new URL(`../../desktop-host/presets/${preset}/agent.cordis.yml`, import.meta.url), 'utf8')
  const rows = yaml.load(source, { schema: entryListSchema }) as EntryOptions[]
  const captured = new Map<string, Record<string, unknown>>()
  const ctx = new Context()
  try {
    await ctx.plugin(Loader)
    ctx.loader.internal = { version: 'v2', loadCache: new Map(),
      register() { throw new Error('Unexpected loader hooks') },
      getOrCreateModuleJob() { throw new Error('Unexpected loader job') },
      resolveSync() { throw new Error('Unexpected loader resolution') },
      load() { throw new Error('Unexpected loader load') }, async import(specifier: string) {
        return { name: specifier, apply(_ctx: Context, config: Record<string, unknown>) { captured.set(specifier, config) } }
      } }
    for (const row of localEpisodeTools(rows).filter(row => ['tool-bgm-compose', 'tool-episode-render'].includes(row.id))) {
      await ctx.loader.create(row)
    }
    await ctx.loader.await()
    for (const entry of ctx.loader.entries()) await entry.fiber?.await()
    for (const name of ['@deepseek-ai/dsh-tool-bgm-compose', '@deepseek-ai/dsh-tool-episode-render']) {
      expect(captured.get(name)?.ffmpegPath).toBe(process.env.DSH_FFMPEG_PATH ?? 'ffmpeg')
      expect(captured.get(name)?.ffprobePath).toBe(process.env.DSH_FFPROBE_PATH ?? 'ffprobe')
    }
  } finally {
    await ctx.fiber.dispose()
  }
})
