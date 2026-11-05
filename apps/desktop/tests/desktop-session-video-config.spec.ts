/** Execute the product overlay's media-path expressions through the real Loader. */
import { fileURLToPath } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import { loadOverlayPatches } from '@deepseek-ai/dsh-app-boot'
import { afterEach, expect, it, vi } from 'vitest'

const patchPath = fileURLToPath(new URL('../../desktop-host/config/desktop.cordis.patch.yml', import.meta.url))

afterEach(() => { vi.unstubAllEnvs() })

it.each([
  { label: 'resolved media tools outside PATH', ffmpeg: '/bundled Muse media/ffmpeg/bin/ffmpeg',
    ffprobe: '/bundled Muse media/ffmpeg/bin/ffprobe',
    expected: { ffmpegPath: '/bundled Muse media/ffmpeg/bin/ffmpeg', ffprobePath: '/bundled Muse media/ffmpeg/bin/ffprobe' } },
  { label: 'no resolved media bindings', ffmpeg: undefined, ffprobe: undefined,
    expected: { ffmpegPath: 'ffmpeg', ffprobePath: 'ffprobe' } },
])('binds Session video processing to $label', async ({ ffmpeg, ffprobe, expected }) => {
  vi.stubEnv('DSH_FFMPEG_PATH', ffmpeg)
  vi.stubEnv('DSH_FFPROBE_PATH', ffprobe)
  const entries = loadOverlayPatches('muse-med', patchPath).flatMap(patch => patch.insert ?? [])
  const row = entries.find(entry => entry.id === 'session-video')
  if (row === undefined) throw new Error('Desktop overlay does not mount session-video')
  expect(row.name).toBe('@deepseek-ai/dsh-session-video')
  let captured: Record<string, unknown> | undefined
  const ctx = new Context()
  try {
    await ctx.plugin(Loader)
    ctx.loader.internal = { version: 'v2', loadCache: new Map(),
      register() { throw new Error('Unexpected loader hooks') },
      getOrCreateModuleJob() { throw new Error('Unexpected loader job') },
      resolveSync() { throw new Error('Unexpected loader resolution') },
      load() { throw new Error('Unexpected loader load') },
      async import(specifier: string) {
        if (specifier !== row.name) throw new Error(`Unexpected module ${specifier}`)
        return { name: 'session-video-config-probe', apply(_ctx: Context, config: Record<string, unknown>) { captured = config } }
      },
    }
    await ctx.loader.create(row)
    await ctx.loader.await()
    for (const entry of ctx.loader.entries()) await entry.fiber?.await()
  } finally {
    await ctx.fiber.dispose()
  }
  expect(captured).toMatchObject(expected)
})
