/** Explicitly opted-in, credential-free smoke of the published BGM catalogue. */
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { expect, it, vi } from 'vitest'
import { apply, inject } from '../src/index.ts'
import { EmotionWorker } from '../src/worker.ts'

it.skipIf(process.env.DSH_BGM_PUBLIC_SMOKE !== '1')('matches and downloads one public track without Python', async () => {
  const root = await mkdtemp(join(import.meta.dirname, 'public-smoke-'))
  const ctx = new Context()
  const start = vi.spyOn(EmotionWorker.prototype, 'start').mockRejectedValue(new Error('No Python'))
  try {
    let tool: { execute(args: Record<string, unknown>, exec: { signal: AbortSignal }): Promise<unknown> } | undefined
    ctx.provide('tools', { register(value: typeof tool) { tool = value; return () => {} } })
    await ctx.plugin({ apply, inject, name: 'perception-bgm' }, {
      catalogUrl: 'https://muse.tos-cn-beijing.volces.com/bgm/index.json',
      cacheDir: root, pythonExecutable: join(root, 'missing-python'),
    })
    if (!tool) throw new Error('Missing bgm_match')
    const exec = { signal: new AbortController().signal }
    const match = await tool.execute({ method: 'match', valence: 5, arousal: 5, limit: 1 }, exec) as {
      evaluated_tracks: number
      candidates: { track_id: string; name: string; path?: string }[]
    }
    const chosen = match.candidates[0]
    if (!chosen) throw new Error('Public catalogue is empty')
    expect(chosen.path).toBeUndefined()
    const downloaded = await tool.execute({ method: 'download', track_id: chosen.track_id }, exec) as {
      path: string
      bytes: number
      sha256: string
      cached: boolean
    }
    const bytes = await readFile(downloaded.path)
    expect(bytes.length).toBe(downloaded.bytes)
    expect(`sha256:${createHash('sha256').update(bytes).digest('hex')}`).toBe(chosen.track_id)
    expect(downloaded.sha256).toBe(chosen.track_id)
    expect(downloaded.cached).toBe(false)
    expect(start).not.toHaveBeenCalled()
    console.log('public BGM smoke', JSON.stringify({ tracks: match.evaluated_tracks,
      name: chosen.name, bytes: bytes.length, sha256: downloaded.sha256 }))
  } finally {
    start.mockRestore()
    await ctx.fiber.dispose()
    await rm(root, { recursive: true, force: true })
  }
}, 120000)
