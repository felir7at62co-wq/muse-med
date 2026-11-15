/** Per-episode frame-observation states read from a source-video folder and durable observation reports. */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import type {} from '@deepseek-ai/dsh-fs'
import { afterEach, expect, it } from 'vitest'
import { videoEpisodeFrames, videoEpisodeNumber } from '../src/video-episode-frames.ts'

const cleanups: (() => Promise<unknown>)[] = []
const signal = new AbortController().signal
const limits = { videoEpisodeMaxFiles: 100, videoEpisodeMaxReports: 100, videoEpisodeMaxReportBytes: 1024 * 1024 }

afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'video-episode-frames-'))
  cleanups.push(() => rm(root, { recursive: true, force: true }))
  const ctx = new Context()
  cleanups.push(() => ctx.fiber.dispose())
  await mountAgentLoopTestDependencies(ctx, { workingDirectory: true })
  await mkdir(join(root, 'videos', 'extra'), { recursive: true })
  await mkdir(join(root, '.muse', 'video-observations'), { recursive: true })
  for (const name of ['剧 001.mp4', '剧 002.mp4', '剧 003.mp4', '剧 004.mp4', 'extra/剧 005.mov', '剧 006.mp4', '剧 006.mkv', 'notes.txt']) {
    await writeFile(join(root, 'videos', name), name)
  }
  async function report(name: string, video: string, options: { complete?: boolean; recorded?: number; version?: string } = {}) {
    const target = await ctx.fs.resolve(join(root, 'videos', video), { cwd: root, signal })
    const version = options.version ?? (await ctx.fs.stat(target, signal))?.version
    const frames = ['F00001', 'F00002'].map((id, index) => ({ id, time: index,
      ...index < (options.recorded ?? 2) ? { observation: { visible: `${video} 第${index + 1}帧：人物伸手`, change: '无' } } : {} }))
    await writeFile(join(root, '.muse', 'video-observations', name), JSON.stringify({ id: name, path: target.displayPath,
      episode: video, source_version: version, scan_complete: options.complete ?? true, frames }, null, 2))
  }
  return { root, ctx, report }
}

it('reads episode numbers from the last digit run of a video name', () => {
  expect(videoEpisodeNumber('万物有声鉴宝天骄 014.mp4')).toBe(14)
  expect(videoEpisodeNumber('episode-0034.mp4')).toBe(34)
  expect(videoEpisodeNumber('预告.mp4')).toBeUndefined()
})

it('classifies complete, incomplete, stale, unviewed, missing and ambiguous episodes', async () => {
  const f = await fixture()
  await f.report('a.json', '剧 001.mp4')
  await f.report('b.json', '剧 002.mp4', { recorded: 1 })
  await f.report('c.json', '剧 003.mp4', { version: 'older-version' })
  await f.report('d.json', 'extra/剧 005.mov', { complete: false })
  const result = await videoEpisodeFrames(f.ctx.fs, f.root, 'videos', [1, 2, 3, 4, 5, 6, 7], limits, signal)
  expect(result.videos).toBe(7)
  expect(result.episodes.map(episode => [episode.episode, episode.state, episode.frames, episode.recorded])).toEqual([
    [1, 'complete', 2, 2], [2, 'incomplete', 2, 1], [3, 'stale', undefined, undefined], [4, 'not_viewed', undefined, undefined],
    [5, 'incomplete', 2, 2], [6, 'ambiguous_video', undefined, undefined], [7, 'no_video', undefined, undefined]])
})

it('prefers a complete current report over an older incomplete one for the same video', async () => {
  const f = await fixture()
  await f.report('old.json', '剧 001.mp4', { recorded: 0, complete: false })
  await f.report('new.json', '剧 001.mp4')
  expect((await videoEpisodeFrames(f.ctx.fs, f.root, 'videos', [1], limits, signal)).episodes[0]?.state).toBe('complete')
})

it('fails instead of truncating when the folder or report count exceeds its bound', async () => {
  const f = await fixture()
  await f.report('a.json', '剧 001.mp4')
  await expect(videoEpisodeFrames(f.ctx.fs, f.root, 'videos', [1], { ...limits, videoEpisodeMaxFiles: 3 }, signal))
    .rejects.toThrow('VIDEO_EPISODE_SOURCE_LIMIT')
  await expect(videoEpisodeFrames(f.ctx.fs, f.root, 'videos', [1], { ...limits, videoEpisodeMaxReports: 0 }, signal))
    .rejects.toThrow('VIDEO_EPISODE_REPORT_LIMIT')
  await expect(videoEpisodeFrames(f.ctx.fs, f.root, 'missing', [1], limits, signal)).rejects.toThrow('VIDEO_EPISODE_SOURCE_DIR')
})
