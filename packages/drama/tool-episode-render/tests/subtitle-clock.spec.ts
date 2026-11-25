/** Clock receipts keep generated and display-only subtitles tied to their actual source bytes. */
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import type { ResolvedShot } from '../src/prepare.ts'
import { changedInputs, changedShots, InvalidSubtitleClockError, parseSubtitleClockReceipt, readSubtitleClockReceipt,
  StaleSubtitleClockError, subtitleClockPath, subtitleClockRows, verifySubtitleClock, writeDerivedSubtitleClock,
  writeSubtitleClock, type SubtitleClockReceiptV2 } from '../src/subtitle-clock.ts'
import { cleanup, tempProject } from './harness.ts'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => cleanup(root))) })
const sha = (text: string) => createHash('sha256').update(text).digest('hex')
const text = '1\n00:00:00,100 --> 00:00:01,000\n现在回去\n'

async function fixture() {
  const project = await tempProject()
  roots.push(project)
  const source = join(project, 'source.srt'), target = join(project, 'display.srt')
  const video = join(project, 'source.mp4'), audio = join(project, 'source.wav')
  await writeFile(source, text)
  await writeFile(video, 'picture bytes')
  await writeFile(audio, 'voice bytes')
  const shots: ResolvedShot[] = [{ source: { shot: 1, video, audio }, video, audio, durationUs: 2_000_000 }]
  return { project, source, target, video, audio, shots }
}

it('leaves an unbound manual subtitle and its derivative unbound without resolving media', async () => {
  const f = await fixture(), readShots = vi.fn(() => f.shots)
  await expect(verifySubtitleClock(f.source, '01', readShots)).resolves.toBeUndefined()
  await expect(writeDerivedSubtitleClock(f.source, f.target, text)).resolves.toBeUndefined()
  expect(readShots).not.toHaveBeenCalled()
})

it('verifies generated source bytes and carries only the verified clock to display text', async () => {
  const f = await fixture()
  await writeSubtitleClock(f.source, text, '01', f.shots, new Map([[1, sha('voice bytes')]]))
  const original = await verifySubtitleClock(f.source, '01', () => f.shots)
  const display = text.replace('现在回去', '现在 回去')
  await writeFile(f.target, display)
  await expect(writeDerivedSubtitleClock(f.source, f.target, display)).resolves.toBe(subtitleClockPath(f.target))
  const derived = await verifySubtitleClock(f.target, '01', async () => f.shots)
  const originalReceipt: unknown = JSON.parse(original ?? '{}')
  const derivedReceipt: unknown = JSON.parse(derived ?? '{}')
  if (originalReceipt === null || typeof originalReceipt !== 'object'
    || !('source_clock_sha256' in originalReceipt) || typeof originalReceipt.source_clock_sha256 !== 'string') {
    throw new Error('Expected a verified source clock receipt')
  }
  expect(derivedReceipt).toMatchObject({ srt_sha256: sha(display),
    source_clock_sha256: originalReceipt.source_clock_sha256 })
  expect(await readFile(f.source, 'utf8')).toBe(text)
})

it('refuses mismatched aligned-audio evidence before publishing a clock receipt', async () => {
  const f = await fixture()
  await expect(writeSubtitleClock(f.source, text, '01', f.shots, new Map([[1, undefined]])))
    .rejects.toThrow('同源对齐')
  await expect(readFile(subtitleClockPath(f.source))).rejects.toMatchObject({ code: 'ENOENT' })
})

it('shares media hashing when picture and embedded sound use one file', async () => {
  const f = await fixture(), shots = [{ ...f.shots[0] as ResolvedShot, audio: f.video }]
  await writeSubtitleClock(f.source, text, '01', shots)
  await expect(verifySubtitleClock(f.source, '01', () => shots)).resolves.toBeTypeOf('string')
})

it.each(['video', 'audio', 'episode', 'duration'] as const)('rejects a generated subtitle after its %s changes', async (field) => {
  const f = await fixture()
  await writeSubtitleClock(f.source, text, '01', f.shots)
  if (field === 'video' || field === 'audio') await writeFile(f[field], 'replacement bytes')
  const shots = field === 'duration' ? f.shots.map(shot => ({ ...shot, durationUs: shot.durationUs + 1 })) : f.shots
  await expect(verifySubtitleClock(f.source, field === 'episode' ? '02' : '01', () => shots))
    .rejects.toBeInstanceOf(StaleSubtitleClockError)
})

it('rejects edited subtitle bytes before consulting the current source clock', async () => {
  const f = await fixture()
  await writeSubtitleClock(f.source, text, '01', f.shots)
  await writeFile(f.source, text.replace('现在', '明天'))
  const readShots = vi.fn(() => f.shots)
  await expect(verifySubtitleClock(f.source, '01', readShots)).rejects.toThrow('生成字幕')
  await expect(writeDerivedSubtitleClock(f.source, f.target, text)).rejects.toThrow('原字幕或来源时钟已变化')
  expect(readShots).not.toHaveBeenCalled()
})

it.each([
  null, [], {}, { version: 2 },
  { version: 1, srt_sha256: sha(text) },
  { version: 1, source_clock_sha256: 'a'.repeat(64) },
  { version: 1, srt_sha256: sha(text), source_clock_sha256: 5 },
  { version: 1, srt_sha256: sha(text), source_clock_sha256: 'invalid' },
])('rejects an invalid clock receipt without creating a display receipt: %j', async (receipt) => {
  const f = await fixture()
  await writeFile(subtitleClockPath(f.source), JSON.stringify(receipt))
  await expect(verifySubtitleClock(f.source, '01', () => f.shots)).rejects.toThrow('生成字幕')
  await expect(writeDerivedSubtitleClock(f.source, f.target, text)).rejects.toThrow('原字幕或来源时钟已变化')
  await expect(readFile(subtitleClockPath(f.target))).rejects.toMatchObject({ code: 'ENOENT' })
})

it('does not convert unreadable clock paths into unbound manual subtitles', async () => {
  const f = await fixture()
  await mkdir(subtitleClockPath(f.source))
  await expect(verifySubtitleClock(f.source, '01', () => f.shots)).rejects.toMatchObject({ code: 'EISDIR' })
  await expect(writeDerivedSubtitleClock(f.source, f.target, text)).rejects.toMatchObject({ code: 'EISDIR' })
})

const producer = { producer: 'episode_subtitles', rules_sha256: 'e'.repeat(64), review_pending: 3 }

async function threeShots() {
  const f = await fixture()
  const shots: ResolvedShot[] = []
  for (const shot of [1, 2, 3]) {
    const video = join(f.project, `p${String(shot)}.mp4`), audio = join(f.project, `p${String(shot)}.wav`)
    await writeFile(video, `picture ${String(shot)}`)
    await writeFile(audio, `voice ${String(shot)}`)
    shots.push({ source: { shot, video, audio }, video, audio, durationUs: 1_000_000 * shot })
  }
  return { ...f, shots }
}

it('writes version 2 rows with the same source clock digest version 1 consumers check', async () => {
  const f = await threeShots()
  await writeSubtitleClock(f.source, text, '02', f.shots)
  const v1 = (await readSubtitleClockReceipt(f.source))?.receipt
  await writeSubtitleClock(f.source, text, '02', f.shots, undefined, { ...producer,
    jingliu: new Map([[2, { shot_id: 's2', video_path: '/fw/media/p2.mp4', etag: 'x', clip_in_us: 0, speed: 1 }]]) })
  const v2 = (await readSubtitleClockReceipt(f.source))?.receipt
  expect(v2).toMatchObject({ version: 2, producer: 'episode_subtitles', episode: '02', review_pending: 3,
    srt_sha256: v1?.srt_sha256, source_clock_sha256: v1?.source_clock_sha256 })
  expect(v2?.version === 2 && v2.shots.map(row => [row.shot, row.duration_us, row.audio_sha256, row.jingliu?.shot_id]))
    .toEqual([[1, 1_000_000, sha('voice 1'), undefined], [2, 2_000_000, sha('voice 2'), 's2'], [3, 3_000_000, sha('voice 3'), undefined]])
  await expect(verifySubtitleClock(f.source, '02', () => f.shots)).resolves.toBeTypeOf('string')
  const display = text.replace('现在回去', '现在 回去')
  await writeFile(f.target, display)
  await writeDerivedSubtitleClock(f.source, f.target, display)
  expect((await readSubtitleClockReceipt(f.target))?.receipt).toEqual({ ...v2, srt_sha256: sha(display) })
})

it('names exactly the shots whose duration, picture or sound changed', async () => {
  const f = await threeShots()
  await writeSubtitleClock(f.source, text, '02', f.shots, undefined, producer)
  const receipt = (await readSubtitleClockReceipt(f.source))?.receipt as SubtitleClockReceiptV2
  expect(changedShots(receipt, await subtitleClockRows(f.shots))).toEqual([])
  await writeFile(f.shots[2]!.audio, 'voice 3 regenerated')
  const trimmed = f.shots.map(shot => shot.source.shot === 1 ? { ...shot, durationUs: 900_000 } : shot)
  expect(changedShots(receipt, await subtitleClockRows(trimmed))).toEqual([1, 3])
  expect(changedShots(receipt, await subtitleClockRows(trimmed.slice(0, 2)))).toEqual([1, 3])
  await expect(verifySubtitleClock(f.source, '02', () => trimmed)).rejects.toBeInstanceOf(StaleSubtitleClockError)
})

it('persists correction inputs and identifies changes independently of the media clock', async () => {
  const f = await fixture()
  const inputs = { lines_sha256: sha('spoken lines'), names_sha256: sha('cast names'), decisions_sha256: sha('review decisions') }
  const current = { ...inputs, rules_sha256: producer.rules_sha256 }
  await writeSubtitleClock(f.source, text, '01', f.shots, undefined, { ...producer, inputs })
  const receipt = (await readSubtitleClockReceipt(f.source))?.receipt
  if (receipt?.version !== 2) throw new Error('Expected a version 2 source clock')
  expect(receipt.inputs).toEqual(inputs)
  expect(changedInputs(receipt, current)).toEqual([])
  expect(changedInputs(receipt, { ...current, names_sha256: sha('new cast') })).toEqual(['names'])
  expect(changedInputs(receipt, { ...current, rules_sha256: sha('new rules'), decisions_sha256: sha('new picks') }))
    .toEqual(['rules', 'decisions'])
  const { inputs: _inputs, ...legacy } = receipt
  expect(changedInputs(legacy, current)).toEqual(['lines', 'names', 'decisions'])
  expect(parseSubtitleClockReceipt({ ...receipt, inputs: [] })).toBeUndefined()
  expect(parseSubtitleClockReceipt({ ...receipt, inputs: { ...inputs, lines_sha256: 'short' } })).toBeUndefined()
  expect(parseSubtitleClockReceipt({ ...receipt, shots: [{ ...receipt.shots[0], jingliu: {
    shot_id: 'shot-1', video_path: '/fw/media/clip.mp4', etag: 'clip-etag', clip_in_us: 0, speed: 0,
  } }] })).toBeUndefined()
})

it('reports a truncated receipt as invalid JSON without treating it as a manual subtitle', async () => {
  const f = await fixture()
  await writeFile(subtitleClockPath(f.source), '{"version":2,')
  await expect(readSubtitleClockReceipt(f.source)).rejects.toBeInstanceOf(InvalidSubtitleClockError)
  await expect(verifySubtitleClock(f.source, '01', () => f.shots)).rejects.toThrow('生成字幕')
})

it.each([
  { version: 3 },
  { shots: [{ shot: 1, duration_us: 0, video_sha256: 'a'.repeat(64), audio_sha256: 'a'.repeat(64) }] },
  { shots: 'none' },
  { review_pending: -1 },
  { rules_sha256: 'short' },
])('rejects an invalid version 2 receipt: %j', async (change) => {
  const f = await fixture()
  await writeFile(subtitleClockPath(f.source), JSON.stringify({ version: 2, srt_sha256: sha(text), source_clock_sha256: 'a'.repeat(64),
    producer: 'episode_subtitles', rules_sha256: 'e'.repeat(64), episode: '01', review_pending: 0, shots: [], ...change }))
  await expect(verifySubtitleClock(f.source, '01', () => f.shots)).rejects.toThrow('生成字幕')
  await expect(writeDerivedSubtitleClock(f.source, f.target, text)).rejects.toThrow('原字幕或来源时钟已变化')
})
