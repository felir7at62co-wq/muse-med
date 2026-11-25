/** The build reuses transcripts by audio digest, corrections by content key, and lays out the clock on every call. */
import { mkdir, readdir, readFile, symlink, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { changedShots, readSubtitleClockReceipt, subtitleClockPath, subtitleClockRows,
  type SubtitleClockReceiptV2 } from '@deepseek-ai/dsh-tool-episode-render/subtitles'
import * as Runner from '@deepseek-ai/dsh-tool-audio-transcribe/runner'
import { readDecisions, readReview } from '../src/build.ts'
import { HashCache } from '../src/hash-cache.ts'
import { localSource } from '../src/shots.ts'
import * as ShotSources from '../src/shots.ts'
import { runEpisodeSubtitles } from '../src/tool.ts'
import { fakeRules, gateway, project, services, settings, toolkit } from './fixture.ts'

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => { await Promise.all(cleanups.splice(0).map(cleanup => cleanup())) })

async function setup(shots = 4) {
  const f = await project(shots)
  cleanups.push(f.cleanup)
  const g = gateway(f.root, f.script)
  const rules = fakeRules()
  const build = (episodes = [1]) => runEpisodeSubtitles({ method: 'build', source: 'local', project: f.root, episodes }, settings, services(g.account, rules))
  return { f, g, rules, build, srt: join(f.root, 'editing', '01.srt') }
}

async function cueStarts(srt: string): Promise<string[]> {
  return (await readFile(srt, 'utf8')).split('\n').filter(line => line.includes('-->'))
}

async function currentRows(root: string) {
  const hash = await HashCache.load(root)
  const [episode] = await localSource(root, root, hash, hash.memoizeProbes(toolkit)).resolve([1])
  if (episode?.kind !== 'ok') throw new Error('episode is not resolved')
  return await subtitleClockRows(episode.clock)
}

it('packs every shot into one upload, waits, then publishes the SRT with a version 2 receipt', async () => {
  const { f, g, rules, build, srt } = await setup()
  const first = await build()
  expect(first).toMatchObject({ status: 'waiting', waiting: [1], asr: { pending_packs: 1 }, next: { tool: 'episode_subtitles',
    args: { method: 'build', episodes: [1], wait_seconds: 30 } } })
  expect(g.submits).toEqual([[await f.audioSha(1), await f.audioSha(2), await f.audioSha(3), await f.audioSha(4)]])
  await expect(readFile(srt)).rejects.toMatchObject({ code: 'ENOENT' })
  g.complete()
  const second = await build()
  expect(second).toMatchObject({ status: 'ready', ready: [1], asr: { new_seconds: 0, pending_packs: 0 },
    next: { tool: 'jianying_draft', args: { source: 'local', episodes: [1] } } })
  expect(g.submits).toHaveLength(1)
  expect(rules.calls.map(call => call.length)).toEqual([4])
  expect(await cueStarts(srt)).toEqual(['00:00:00,500 --> 00:00:01,950', '00:00:03,500 --> 00:00:04,950',
    '00:00:06,500 --> 00:00:07,950', '00:00:09,500 --> 00:00:10,950'])
  const receipt = (await readSubtitleClockReceipt(srt))?.receipt as SubtitleClockReceiptV2
  expect(receipt).toMatchObject({ version: 2, producer: 'episode_subtitles', episode: '01', review_pending: 0 })
  expect(changedShots(receipt, await currentRows(f.root))).toEqual([])
  const shotList = JSON.parse(await readFile(join(f.root, 'editing', '01-shots.json'), 'utf8')) as { shots: readonly unknown[] }
  expect(shotList.shots[0]).toMatchObject({ shot: 1, package: 1 })
  await build()
  expect(rules.calls).toHaveLength(1)
})

it('refuses an incomplete correction response before publishing an episode', async () => {
  const { g, rules, build, srt } = await setup(1)
  await build()
  g.complete()
  const run = vi.spyOn(rules, 'run').mockResolvedValueOnce([])
  try {
    await expect(build()).rejects.toThrow('缺少字幕规则结果')
    await expect(readFile(srt)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(build()).resolves.toMatchObject({ status: 'ready' })
    expect(g.submits).toHaveLength(1)
  } finally { run.mockRestore() }
})

it('reports blocked recognition for all affected shots and leaves the episode unpublished', async () => {
  const { build, rules, srt } = await setup(2)
  const start = vi.spyOn(Runner, 'startAudioTranscriptionBatch').mockImplementation(async (_root, inputs) => ({
    items: inputs.map(input => ({ input, status: 'failed', receipt: 'failed-pack', job_id: 'failed-job' })),
  }))
  try {
    expect(await build()).toMatchObject({ status: 'blocked', blocked: [{ episode: 1, reason: 'asr_failed', shots: [1, 2] }] })
    expect(await build()).toMatchObject({ status: 'blocked', blocked: [{ episode: 1, reason: 'asr_failed', shots: [1, 2] }] })
    expect(start).toHaveBeenCalledTimes(1)
    expect(rules.calls).toEqual([])
    await expect(readFile(srt)).rejects.toMatchObject({ code: 'ENOENT' })
  } finally { start.mockRestore() }
})

it('reports the transcription service retry delay while the episode waits', async () => {
  const { build, rules, srt } = await setup(1)
  const start = vi.spyOn(Runner, 'startAudioTranscriptionBatch').mockImplementation(async (_root, inputs) => ({
    items: inputs.map(input => ({ input, status: 'processing', receipt: 'queued-pack', job_id: 'queued-job',
      error_code: 'queue_full', retry_after_seconds: 7 })),
  }))
  try {
    expect(await build()).toMatchObject({ status: 'waiting', waiting: [1], asr: { pending_packs: 1, retry_after: 7 } })
    expect(rules.calls).toEqual([])
    await expect(readFile(srt)).rejects.toMatchObject({ code: 'ENOENT' })
  } finally { start.mockRestore() }
})

it.each([
  { kind: 'missing measured duration', message: '镜头与实测时长数量不一致' },
  { kind: 'missing requested episode', message: '没有构建结果' },
] as const)('fails before publication for $kind', async ({ kind, message }) => {
  const { build, g, srt } = await setup(1)
  const source = ShotSources.localSource
  const stub = vi.spyOn(ShotSources, 'localSource').mockImplementation((...args) => {
    const actual = source(...args)
    return { ...actual, resolve: async (...request) => {
      if (kind === 'missing requested episode') return []
      return (await actual.resolve(...request)).map(episode => episode.kind === 'ok' ? { ...episode, clock: [] } : episode)
    } }
  })
  try {
    await expect(build()).rejects.toThrow(message)
    expect(g.submits).toEqual([])
    await expect(readFile(srt)).rejects.toMatchObject({ code: 'ENOENT' })
  } finally { stub.mockRestore() }
})

it('reports an unreadable receipt without moving the existing subtitle', async () => {
  const { build, g, srt } = await setup(1)
  await build()
  g.complete()
  await mkdir(subtitleClockPath(srt), { recursive: true })
  await writeFile(srt, 'manual subtitle')
  await expect(build()).rejects.toMatchObject({ code: 'EISDIR' })
  await expect(readFile(srt, 'utf8')).resolves.toBe('manual subtitle')
})

it('reports a directory at the subtitle path without replacing it', async () => {
  const { build, g, srt } = await setup(1)
  await build()
  g.complete()
  await mkdir(srt, { recursive: true })
  await expect(build()).rejects.toMatchObject({ code: 'EISDIR' })
  await expect(readdir(srt)).resolves.toEqual([])
})

it('keeps manual subtitles when a backup path is an unresolvable link', async () => {
  const { build, g, srt } = await setup(1)
  await build()
  g.complete()
  await writeFile(srt, 'manual subtitle')
  const instant = new Date('2026-11-25T09:30:00.000Z')
  const backup = `${srt}.manual-${instant.toISOString().replace(/[-:.]/gu, '')}`
  await symlink(backup, backup, process.platform === 'win32' ? 'junction' : 'file')
  vi.setSystemTime(instant)
  try {
    await expect(build()).rejects.toMatchObject({ code: 'ELOOP' })
    await expect(readFile(srt, 'utf8')).resolves.toBe('manual subtitle')
  } finally {
    vi.setSystemTime()
    await unlink(backup)
  }
})

it('keeps manual subtitle bytes and an invalid receipt next to a fresh measured subtitle', async () => {
  const { f, g, build, srt } = await setup(1)
  await mkdir(join(f.root, 'editing'), { recursive: true })
  await build()
  g.complete()
  const manual = '我的手工字幕\n'
  const invalid = '{"version":2,'
  const original = srt + '.clock.json'
  const now = new Date('2026-11-25T17:40:00.000Z')
  const occupied = `${srt}.manual-20261125T174000000Z`
  await Promise.all([writeFile(srt, manual), writeFile(original, invalid), writeFile(occupied, '已有备份')])
  vi.useFakeTimers({ toFake: ['Date'] })
  try {
    vi.setSystemTime(now)
    await expect(build()).resolves.toMatchObject({ status: 'ready' })
    expect(await readFile(occupied, 'utf8')).toBe('已有备份')
    expect(await readFile(occupied + '-2', 'utf8')).toBe(manual)
    expect(await readFile(occupied + '-2.clock.json', 'utf8')).toBe(invalid)
    expect((await readSubtitleClockReceipt(srt))?.receipt).toMatchObject({ version: 2, producer: 'episode_subtitles' })
  } finally { vi.useRealTimers() }
})

it('surfaces malformed saved review and decision files rather than pretending they are absent', async () => {
  const { f } = await setup(1)
  const review = join(f.root, 'review.json'), decisions = join(f.root, 'decisions.json')
  await Promise.all([writeFile(review, '{'), mkdir(decisions)])
  await expect(readReview(review)).rejects.toBeInstanceOf(SyntaxError)
  await expect(readDecisions(decisions)).rejects.toMatchObject({ code: 'EISDIR' })
})

it('redoes recognition only for new audio, correction only for a script edit, and neither for a trim', async () => {
  const { f, g, rules, build, srt } = await setup()
  await build(); g.complete(); await build()

  await f.regenerate(3, '第3句新台词')
  expect(await build()).toMatchObject({ status: 'waiting', changed: { 1: [3] } })
  expect(g.submits.at(-1)).toEqual([await f.audioSha(3)])
  g.complete()
  expect(await build()).toMatchObject({ status: 'ready', changed: { 1: [3] } })
  expect(rules.calls.at(-1)?.map(shot => shot.lines)).toEqual([['第3句台词']])
  expect(g.submits).toHaveLength(2)

  await f.editLine(2, '第2句改过的台词')
  expect(await build()).toMatchObject({ status: 'ready', changed: { 1: [2] }, asr: { new_seconds: 0 } })
  expect(g.submits).toHaveLength(2)
  expect(rules.calls.at(-1)?.map(shot => shot.lines)).toEqual([['第2句改过的台词']])

  const before = await cueStarts(srt), calls = rules.calls.length
  await f.trim(2, 1.5)
  const trimmed = await build()
  expect(trimmed).toMatchObject({ status: 'needs_review', needs_review: { 1: 1 } })
  expect(trimmed).not.toHaveProperty('changed')
  expect(g.submits).toHaveLength(2)
  expect(rules.calls).toHaveLength(calls)
  expect(await cueStarts(srt)).toEqual([before[0], '00:00:03,500 --> 00:00:04,500', '00:00:05,000 --> 00:00:06,750',
    '00:00:08,000 --> 00:00:09,450'])
})

it('reports trim of shot 2 and regenerated shot 4 as changed shots, then re-transcribes only shot 4', async () => {
  const { f, g, build, srt } = await setup()
  await build(); g.complete(); await build()
  const receipt = (await readSubtitleClockReceipt(srt))?.receipt as SubtitleClockReceiptV2
  await f.trim(2, 2.5)
  await f.regenerate(4, '第4句重做')
  expect(changedShots(receipt, await currentRows(f.root))).toEqual([2, 4])
  await build(); g.complete(); await build()
  expect(g.submits.slice(1)).toEqual([[await f.audioSha(4)]])
  const rebuilt = (await readSubtitleClockReceipt(srt))?.receipt as SubtitleClockReceiptV2
  expect(changedShots(rebuilt, await currentRows(f.root))).toEqual([])
})

it('blocks an episode whose package has no approved selection or changed after approval', async () => {
  const { f, build } = await setup(2)
  await import('node:fs/promises').then(fs => fs.rm(join(f.root, 'reviews', 'ep01-p02.json')))
  expect(await build()).toMatchObject({ status: 'blocked', blocked: [{ episode: 1, reason: 'selection_missing', shots: [2] }] })
  expect(await build([1, 2])).toMatchObject({ blocked: [{ episode: 1, reason: 'selection_missing' }, { episode: 2, reason: 'package_missing' }] })
})

it('pages review items and rebuilds with decisions without new recognition', async () => {
  const { f, g, rules, build, srt } = await setup(2)
  await f.speak(2, '你在吗')
  await build(); g.complete()
  expect(await build()).toMatchObject({ status: 'needs_review', needs_review: { 1: 1 } })
  const page = await runEpisodeSubtitles({ method: 'review', source: 'local', project: f.root, episodes: [1] }, settings, services(g.account, rules))
  expect(page).toMatchObject({ pending: 1, items: [{ episode: 1, shot: 2, kind: 'doubt', heard: '吗' }] })
  const id = (page.items as { id: string }[])[0]!.id
  const decided = await runEpisodeSubtitles({ method: 'review', source: 'local', project: f.root, episodes: [1],
    decisions: [{ id, action: 'drop' }, { id: 'unknown-id', action: 'heard' }] }, settings, services(g.account, rules))
  expect(decided).toMatchObject({ pending: 0, items: [], applied: 1, unknown: ['unknown-id'], status: 'ready',
    next: { tool: 'jianying_draft' } })
  expect(g.submits).toHaveLength(1)
  expect(rules.calls.at(-1)?.map(shot => shot.decisions)).toEqual([[{ id, action: 'drop' }]])
  expect(await readFile(srt, 'utf8')).toContain('你在\n')
  expect((await readSubtitleClockReceipt(srt))?.receipt).toMatchObject({ review_pending: 0 })
})

it('passes two choices to the correction rules in stable ID order', async () => {
  const { f, g, rules, build } = await setup(1)
  await f.speak(1, '好吗吗')
  await build()
  g.complete()
  await build()
  const review = { method: 'review', source: 'local', project: f.root, episodes: [1] } as const
  const page = await runEpisodeSubtitles(review, settings, services(g.account, rules))
  const ids = (page.items as { id: string }[]).map(({ id }) => id).sort()
  expect(ids).toHaveLength(2)
  const decisions = [...ids].reverse().map(id => ({ id, action: 'drop' as const }))
  const result = await runEpisodeSubtitles({ ...review, decisions }, settings, services(g.account, rules))
  expect(result).toMatchObject({ applied: 2, pending: 0 })
  expect(rules.calls.at(-1)?.flatMap(({ decisions }) => decisions.map(({ id }) => id))).toEqual(ids)
  expect(g.submits).toHaveLength(1)
})

it('uses the played window for clock findings and omits dropped cues without another upload', async () => {
  const { f, g, rules, build, srt } = await setup(1)
  await f.trim(1, 1)
  await build()
  g.complete()
  const text = '这段密集台词需要更多时间才能读完'
  const run = vi.spyOn(rules, 'run').mockImplementation(async shots => shots.map(shot => ({
    key: shot.key, pending: 0,
    cues: [{ start: 0.5, end: 1.5, text }, { start: 1.55, end: 1.75, text: '片段之外' }],
    items: [{ id: 'context', kind: 'doubt', heard: '这段', script: '这段', start: 0.5, end: 0.8, decision: null }],
  })))
  try {
    expect(await build()).toMatchObject({ status: 'needs_review', needs_review: { 1: 4 } })
    const page = await runEpisodeSubtitles({ method: 'review', source: 'local', project: f.root, episodes: [1] },
      settings, services(g.account, rules))
    expect(page.items).toMatchObject([
      { id: 'context', kind: 'doubt', start: 0.5, end: 0.8 },
      { kind: 'cut_by_trim', heard: text, start: 0.5, end: 1 },
      { kind: 'too_fast', heard: text, start: 0.5, end: 1 },
      { kind: 'cut_by_trim', heard: '片段之外', start: 1, end: 1 },
    ])
    const decisions = (page.items as { id: string }[]).map(({ id }) => ({ id, action: 'drop' as const }))
    const resolved = await runEpisodeSubtitles({ method: 'review', source: 'local', project: f.root, episodes: [1], decisions },
      settings, services(g.account, rules))
    expect(resolved).toMatchObject({ applied: 4 })
    expect(await cueStarts(srt)).toEqual([])
    expect(g.submits).toHaveLength(1)
  } finally { run.mockRestore() }
})

it('moves a hand-made or hand-edited SRT aside with its receipt before publishing and reports where it went', async () => {
  const { f, g, build, srt } = await setup(2)
  await mkdir(join(f.root, 'editing'), { recursive: true })
  const manual = '1\n00:00:00,500 --> 00:00:02,000\n用户手改过的字幕\n'
  await writeFile(srt, manual)
  await build(); g.complete()
  const first = await build()
  const kept = (first.manual_srt_kept as Record<string, string>)['1']!
  expect(kept.replaceAll('\\', '/')).toMatch(/^editing\/01\.srt\.manual-\d{8}T\d{9}Z$/u)
  expect(await readFile(join(f.root, kept), 'utf8')).toBe(manual)
  expect(await readFile(srt, 'utf8')).not.toContain('用户手改过的字幕')

  const published = await readFile(srt, 'utf8')
  expect(await build()).not.toHaveProperty('manual_srt_kept')
  await writeFile(srt, published.replace('第1句台词', '第1句台词（手改）'))
  const second = await build()
  const edited = (second.manual_srt_kept as Record<string, string>)['1']!
  expect(edited).not.toBe(kept)
  expect(await readFile(join(f.root, edited), 'utf8')).toContain('（手改）')
  expect((await readSubtitleClockReceipt(join(f.root, edited)))?.receipt).toMatchObject({ version: 2, producer: 'episode_subtitles' })
  expect(await readFile(srt, 'utf8')).toBe(published)
  expect((await readdir(join(f.root, 'editing'))).filter(name => name.includes('.manual-'))).toHaveLength(3)
})

it('records the line, name and decision digests in the receipt so a script edit changes it without new media', async () => {
  const { f, g, build, srt } = await setup(2)
  await build(); g.complete(); await build()
  const before = (await readSubtitleClockReceipt(srt))?.receipt as SubtitleClockReceiptV2
  expect(before.inputs?.lines_sha256).toMatch(/^[0-9a-f]{64}$/u)
  await f.editLine(2, '第2句改过的台词')
  await build()
  const after = (await readSubtitleClockReceipt(srt))?.receipt as SubtitleClockReceiptV2
  expect(after.inputs?.lines_sha256).not.toBe(before.inputs?.lines_sha256)
  expect(after.inputs?.names_sha256).toBe(before.inputs?.names_sha256)
  expect(after.source_clock_sha256).toBe(before.source_clock_sha256)
})
