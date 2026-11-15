/** Clock receipts keep generated and display-only subtitles tied to their actual source bytes. */
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import type { ResolvedShot } from '../src/prepare.ts'
import { StaleSubtitleClockError, subtitleClockPath, verifySubtitleClock, writeDerivedSubtitleClock,
  writeSubtitleClock } from '../src/subtitle-clock.ts'
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
