/** Local indexing persists measured audio incrementally and reuses content across metadata changes. */
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { afterEach, expect, it, vi } from 'vitest'
import { apply, inject, defaultWeightsPath } from '../src/index.ts'
import { EmotionWorker } from '../src/worker.ts'
import type { BgmConfig } from '../src/config.ts'

const roots: string[] = [], contexts: Context[] = []
afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

async function fixture(options: BgmConfig = {}) {
  const root = await mkdtemp(join(tmpdir(), 'bgm-local-'))
  roots.push(root)
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(SystemPrompt).await()
  await ctx.plugin(ToolRuntime, { mode: 'native' }).await()
  const indexPath = join(root, 'state', 'index.json')
  const config = { pythonExecutable: process.execPath, indexPath, dataDir: join(root, 'model-data'), ...options }
  const plugin = ctx.plugin({ name: 'perception-bgm', apply, inject }, config)
  await plugin.await()
  let count = 0
  return { root, ctx, indexPath, config, plugin, run: (args: Record<string, unknown>) => ctx.tools.execute({
    callId: ToolCallId(`bgm-${++count}`), name: 'bgm_match', arguments: args, signal: new AbortController().signal,
  }) }
}

function analysis() {
  const start = vi.spyOn(EmotionWorker.prototype, 'start').mockResolvedValue({ ready: true, face: 'emotion', missing: [] })
  vi.spyOn(EmotionWorker.prototype, 'alive', 'get').mockReturnValue(true)
  const call = vi.spyOn(EmotionWorker.prototype, 'call').mockResolvedValue({ valence: 6.123456, arousal: 3.567891, moods: ['calm'] })
  return { start, call }
}

it('indexes recursive audio in sorted order, saves each measurement, and reuses identical bytes after mtime changes', async () => {
  const worker = analysis()
  const f = await fixture({ callTimeoutMs: 123_456, env: { HF_HOME: 'explicit-cache' } })
  const music = join(f.root, 'music'), nested = join(music, 'nested')
  await mkdir(nested, { recursive: true })
  const paths = [join(music, 'a.MP3'), join(nested, 'b.wav')]
  for (const path of paths) await writeFile(path, 'measured audio')
  await writeFile(join(music, 'ignore.txt'), 'not audio')
  let priorAnalyses = 0
  worker.call.mockImplementation(async (_method, parameters) => {
    if (priorAnalyses++ > 0) expect(JSON.parse(await readFile(f.indexPath, 'utf8'))).toHaveLength(1)
    expect(parameters).toEqual({ audio_path: paths[priorAnalyses - 1], weights_path: defaultWeightsPath(), data_dir: f.config.dataDir })
    return { valence: 6.123456, arousal: 3.567891, moods: ['calm'] }
  })
  expect((await f.run({ method: 'index', directory: music })).value).toMatchObject({ scanned: 2, indexed: 2, analysed: 2, unchanged: 0, failures: [] })
  expect(worker.start).toHaveBeenCalledOnce()
  expect(worker.call).toHaveBeenCalledTimes(2)
  const bytes = await readFile(f.indexPath, 'utf8')
  expect((await f.run({ method: 'index', directory: music })).value).toMatchObject({ analysed: 0, unchanged: 2 })
  expect(await readFile(f.indexPath, 'utf8')).toBe(bytes)
  const info = await stat(paths[0]!)
  await utimes(paths[0]!, info.atime, new Date(info.mtimeMs + 10_000))
  expect((await f.run({ method: 'index', directory: music })).value).toMatchObject({ analysed: 0, unchanged: 2 })
  expect(worker.call).toHaveBeenCalledTimes(2)
  const updated = JSON.parse(await readFile(f.indexPath, 'utf8')) as { modified_ms: number }[]
  expect(updated[0]?.modified_ms).toBe((await stat(paths[0]!)).mtimeMs)
})

it('retains successful tracks and records worker failures without losing the remainder of an indexing run', async () => {
  const worker = analysis(), f = await fixture()
  const music = join(f.root, 'music')
  await mkdir(music)
  for (const name of ['a.mp3', 'b.mp3', 'c.mp3']) await writeFile(join(music, name), name)
  worker.call.mockRejectedValueOnce(new Error('decoder unavailable')).mockRejectedValueOnce('worker closed')
  const result = await f.run({ method: 'index', directory: music })
  expect(result.isError).toBe(false)
  expect(result.value).toMatchObject({ scanned: 3, indexed: 1, analysed: 1, failures: [
    { path: join(music, 'a.mp3'), error: 'decoder unavailable' }, { path: join(music, 'b.mp3'), error: 'worker closed' },
  ] })
  const index = JSON.parse(await readFile(f.indexPath, 'utf8')) as { path: string; sha256: string }[]
  expect(index).toEqual([expect.objectContaining({ path: join(music, 'c.mp3'),
    sha256: `sha256:${createHash('sha256').update('c.mp3').digest('hex')}` })])
})

it('inspects one resolved file, rounds measurements, and retains an explicit discarded-sample count', async () => {
  const worker = analysis(), f = await fixture()
  const audio = join(f.root, 'source.mp3')
  expect((await f.run({ method: 'inspect', audio_path: audio })).value).toEqual({ path: audio,
    valence: 6.1235, arousal: 3.5679, moods: ['calm'], dropped_trailing_samples: 0 })
  worker.call.mockResolvedValueOnce({ valence: 5, arousal: 6, moods: [], dropped_trailing_samples: 27 })
  expect((await f.run({ method: 'inspect', audio_path: audio })).value).toMatchObject({ dropped_trailing_samples: 27 })
  expect(worker.start).toHaveBeenCalledOnce()
})

it.each([{ method: 'index' }, { method: 'index', directory: '  ' }, { method: 'inspect' },
  { method: 'inspect', audio_path: '  ' }, { method: 'download', track_id: 'sha256:' + '0'.repeat(64) }])('rejects incomplete local requests before starting Python', async (args) => {
  const worker = analysis(), f = await fixture()
  expect((await f.run(args)).isError).toBe(true)
  expect(worker.start).not.toHaveBeenCalled()
})

it('reports missing interpreter configuration only when analysis is requested', async () => {
  const f = await fixture({ pythonExecutable: '' })
  const result = await f.run({ method: 'inspect', audio_path: 'source.mp3' })
  expect(result.isError).toBe(true)
  expect(result.content.some(block => block.type === 'text' && block.text.includes('no usable Python'))).toBe(true)
})

it('reports the dependency handshake failure before analysing a track', async () => {
  const worker = analysis(), f = await fixture()
  worker.start.mockResolvedValueOnce({ ready: false, face: 'emotion', missing: ['torch', 'numpy'] })
  const result = await f.run({ method: 'inspect', audio_path: 'source.mp3' })
  expect(result.content.some(block => block.type === 'text' && block.text.includes('torch; numpy'))).toBe(true)
  expect(worker.call).not.toHaveBeenCalled()
})

it.each(['missing', 'invalid-json', 'non-array', 'empty'] as const)('asks for indexing when the local index is %s', async (mode) => {
  const f = await fixture()
  if (mode !== 'missing') {
    await mkdir(join(f.root, 'state'))
    await writeFile(f.indexPath, mode === 'invalid-json' ? '{' : mode === 'non-array' ? '{}' : '[]')
  }
  const result = await f.run({ method: 'match', valence: 5, arousal: 5 })
  expect(result.isError).toBe(true)
  expect(result.content.some(block => block.type === 'text' && block.text.includes('run index'))).toBe(true)
})

it('ranks local measurements by distance and clamps candidate limits without Python', async () => {
  const worker = analysis(), f = await fixture()
  await mkdir(join(f.root, 'state'))
  const tracks = Array.from({ length: 25 }, (_, index) => ({ path: `track-${index}.mp3`, sha256: 'hash', bytes: 1,
    modified_ms: 0, valence: 1 + index / 25, arousal: 2 + index / 25, moods: ['calm'] }))
  await writeFile(f.indexPath, JSON.stringify(tracks))
  for (const [limit, count] of [[undefined, 5], [0, 1], [100, 20], [2.9, 2]] as const) {
    const result = await f.run({ method: 'match', valence: 2, arousal: 3, ...limit === undefined ? {} : { limit } })
    const value = result.value
    if (!value || typeof value !== 'object' || Array.isArray(value) || !Array.isArray(value.candidates)) {
      throw new Error('match candidates unavailable')
    }
    expect(value.evaluated_tracks).toBe(25)
    expect(value.candidates).toHaveLength(count)
    expect(value.candidates[0]).toMatchObject({ path: 'track-24.mp3' })
  }
  expect(worker.start).not.toHaveBeenCalled()
})

it('re-analyses changed audio and persists an empty directory as a valid index', async () => {
  const worker = analysis(), f = await fixture()
  const music = join(f.root, 'music')
  await mkdir(music)
  const audio = join(music, 'a.mp3')
  await writeFile(audio, 'old')
  await f.run({ method: 'index', directory: music })
  await writeFile(audio, 'new audio')
  expect((await f.run({ method: 'index', directory: music })).value).toMatchObject({ analysed: 1, unchanged: 0 })
  expect(worker.call).toHaveBeenCalledTimes(2)
  const empty = join(f.root, 'empty')
  await mkdir(empty)
  expect((await f.run({ method: 'index', directory: empty })).value).toMatchObject({ scanned: 0, indexed: 1, failures: [] })
})
