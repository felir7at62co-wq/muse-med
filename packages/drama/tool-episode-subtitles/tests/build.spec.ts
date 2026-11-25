/** The build reuses transcripts by audio digest, corrections by content key, and lays out the clock on every call. */
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { changedShots, readSubtitleClockReceipt, subtitleClockRows, type SubtitleClockReceiptV2 } from '@deepseek-ai/dsh-tool-episode-render/subtitles'
import { HashCache } from '../src/hash-cache.ts'
import { localSource } from '../src/shots.ts'
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
