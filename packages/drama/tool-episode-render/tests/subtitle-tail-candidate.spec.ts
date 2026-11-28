import { writeFileSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, onTestFinished, vi } from 'vitest'
import { fileSha256 } from '../src/cache.ts'
import { planDeliveryPictureClock } from '../src/picture-clock.ts'
import { sourceRecordPathFor, SOURCE_RECORD_VERSION, writeSourceRecord } from '../src/source-record.ts'
import { prepareSubtitleTailCandidate } from '../src/subtitle-tail-candidate.ts'
import { stubChannel } from './harness.ts'

const sampleSubtitle = '1\n00:00:00,100 --> 00:00:00,500\n你好世界\n'

async function fixture(options: {
  wordEnd?: number
  subtitle?: string | Buffer
  outputExtension?: string
  overlay?: boolean
  noClock?: boolean
  pictureDuration?: string
  splitClock?: boolean
  words?: readonly { text: string; start: number; end: number }[]
} = {}) {
  const { wordEnd = 0.6, subtitle = sampleSubtitle, outputExtension = '.mp4', overlay = false, noClock = false,
    pictureDuration = '1', splitClock = false } = options
  const folder = await mkdtemp(join(tmpdir(), 'muse-subtitle-tail-'))
  onTestFinished(() => rm(folder, { recursive: true, force: true }))
  const project = await realpath(folder)
  const episode = '21'
  const output = join(project, `native${outputExtension}`)
  const subtitleSrt = join(project, 'display.srt')
  await writeFile(output, 'fixture render byte identity')
  await writeFile(subtitleSrt, subtitle)
  const sourceSha = await fileSha256(output)
  const subtitleSha = await fileSha256(subtitleSrt)
  const timeline = splitClock
    ? [{ shot: 1, startUs: 0, durationUs: 250_000 }, { shot: 2, startUs: 250_000, durationUs: 750_000 }]
    : [{ shot: 1, startUs: 0, durationUs: 1_000_000 }]
  const clock = planDeliveryPictureClock(timeline, 24, 0)
  if (clock === undefined) throw new Error('Fixture picture clock missing')
  await writeSourceRecord(sourceRecordPathFor(output), {
    version: SOURCE_RECORD_VERSION,
    episode,
    rendered_at: new Date(0).toISOString(),
    output: { path: output, sha256: sourceSha, size_bytes: (await stat(output)).size, duration_seconds: 1 },
    inputs: [],
    input_files: [{ path: subtitleSrt, sha256: subtitleSha }],
    delivery_inputs: {
      ...(noClock ? {} : { picture_clock: clock }),
      timeline_sha256: 'a'.repeat(64),
      master_audio_sha256: 'b'.repeat(64),
      subtitle_sha256: subtitleSha,
      subtitle_display: overlay ? 'overlay' : 'external',
      videos: [{ shot: 1, sha256: sourceSha }],
      music: { mode: 'none', gain: 0 },
    },
    encoder: 'fixture',
    checks: [],
  })
  const directory = join(project, 'transcript', 'offline', 'local-A12B34')
  await mkdir(directory, { recursive: true })
  const wordReceipt = join(directory, 'receipt.json')
  const words = join(directory, 'words.json')
  const recognizedWords = options.words ?? [
    { text: '你好', start: 0.1, end: 0.3 }, { text: '世界', start: 0.3, end: wordEnd },
  ]
  await writeFile(words, JSON.stringify([{ start: 0.1, end: wordEnd,
    text: recognizedWords.map(word => word.text).join(''), words: recognizedWords }]))
  await writeFile(wordReceipt, JSON.stringify({
    kind: 'muse_offline_word_timing', version: 1, project, receipt: wordReceipt,
    source: { path: output, sha256: sourceSha },
    transcript: { path: words, sha256: await fileSha256(words) },
    pcm: { sha256: 'c'.repeat(64), sampleRate: 16000, samples: 16000 },
    model: { name: 'Systran/faster-whisper-small', revision: '536b0662742c02347bc0e980a01041f333bce120',
      sha256: '3e305921506d8872816023e4c273e75d2419fb89b24da97b4fe7bce14170d671' },
    listening_verified: false,
  }))
  const verifyOfflineWords = vi.fn<Parameters<typeof prepareSubtitleTailCandidate>[0]['verifyOfflineWords']>()
  const { channel } = stubChannel([() => ({
    code: 0, stderr: '', stdout: JSON.stringify({ streams: [{ start_time: '0', duration: pictureDuration }] }),
  })])
  return { input: { toolkit: { ffmpeg: 'ffmpeg', ffprobe: 'ffprobe', channel }, project, episode, output, subtitleSrt,
    wordReceipt, verifyOfflineWords }, sourceSha, subtitleSha }
}

it('writes a separate candidate by extending only the last subtitle end to measured word timing', async () => {
  const { input, sourceSha, subtitleSha } = await fixture()
  const result = await prepareSubtitleTailCandidate(input)
  if (result.status !== 'candidate') throw new Error(result.reason)
  expect(result).toMatchObject({
    status: 'candidate', source_sha256: sourceSha, subtitle_sha256: subtitleSha, old_end_seconds: 0.5,
    candidate_end_seconds: 0.6, listening_verified: false, grants_approval: false, external_requests: 0,
  })
  expect(await readFile(result.candidate_path, 'utf8')).toBe(sampleSubtitle.replace('00:00:00,500', '00:00:00,600'))
  const receipt: unknown = JSON.parse(await readFile(result.evidence_path, 'utf8'))
  expect(receipt).toEqual(result)
  expect(await readFile(input.subtitleSrt, 'utf8')).toBe(sampleSubtitle)
  expect(await fileSha256(input.output)).toBe(sourceSha)
  expect(input.verifyOfflineWords).toHaveBeenCalledTimes(2)
})

it('keeps an excessive extension pending without writing a candidate', async () => {
  const { input } = await fixture({ wordEnd: 0.8 })
  expect(await prepareSubtitleTailCandidate(input)).toMatchObject({ status: 'needs_review', grants_approval: false })
  expect(await readdir(input.project)).not.toContain('editing')
  expect(await readFile(input.subtitleSrt, 'utf8')).toBe(sampleSubtitle)
})

it('refuses changed subtitles and session receipts before publishing any candidate', async () => {
  const { input } = await fixture()
  input.verifyOfflineWords.mockImplementation(() => { throw new Error('receipt did not come from this session') })
  expect(await prepareSubtitleTailCandidate(input)).toMatchObject({ status: 'needs_review', grants_approval: false })
  await writeFile(input.subtitleSrt, sampleSubtitle.replace('你好', '再见'))
  expect(await prepareSubtitleTailCandidate(input)).toMatchObject({ status: 'needs_review', grants_approval: false })
  expect(input.verifyOfflineWords).toHaveBeenCalledTimes(1)
  expect(await readdir(input.project)).not.toContain('editing')
})

it.each([
  { options: { outputExtension: '.mov' }, reason: '超出本机读取范围' },
  { options: { overlay: true }, reason: '不能证明字幕是完整外加显示内容' },
  { options: { noClock: true }, reason: '缺少实际正文画面边界' },
  { options: { pictureDuration: '0.9' }, reason: '画面时长与来源回执不一致' },
  { options: { subtitle: Buffer.from([0xff]) }, reason: '不是可原样回写的 UTF-8' },
  { options: { subtitle: ' ' }, reason: '字幕顺序、时间或接缝不适合' },
  { options: { splitClock: true }, reason: '跨实际镜头' },
])('rejects unusable render or subtitles before reading word evidence: $reason', async ({ options, reason }) => {
  const { input } = await fixture(options)
  const result = await prepareSubtitleTailCandidate(input)
  if (result.status !== 'needs_review') throw new Error('Unexpected candidate for invalid input')
  expect(result.reason).toContain(reason)
  expect(input.verifyOfflineWords).not.toHaveBeenCalled()
  expect(await readdir(input.project)).not.toContain('editing')
})

it('preserves the source subtitle separator and the preceding cue', async () => {
  const priorCue = '1\n00:00:00.000 --> 00:00:00.050\n先前一句\n\n'
  const tail = sampleSubtitle.replace(/^1/u, '2').replaceAll(',', '.')
  const { input } = await fixture({ subtitle: priorCue + tail })
  const result = await prepareSubtitleTailCandidate(input)
  if (result.status !== 'candidate') throw new Error(result.reason)
  expect(await readFile(result.candidate_path, 'utf8')).toBe(priorCue + tail.replace('00:00:00.500', '00:00:00.600'))
  expect(await readFile(input.subtitleSrt, 'utf8')).toBe(priorCue + tail)
})

it('refuses a redirected candidate directory', async () => {
  const { input } = await fixture()
  const unrelated = join(input.project, 'unrelated')
  await mkdir(unrelated)
  await symlink(unrelated, join(input.project, 'editing'), 'junction')
  const result = await prepareSubtitleTailCandidate(input)
  if (result.status !== 'needs_review') throw new Error('Unexpected candidate in redirected directory')
  expect(result.reason).toContain('目录发生重定向')
  expect(await readdir(unrelated)).toEqual([])
})

it.each([
  { words: [{ text: '你好世界', start: 0.1, end: 0.6 }], reason: '没有唯一且连续' },
  { words: [{ text: '你好', start: 0.1, end: 0.15 }, { text: '世界', start: 0.4, end: 0.6 }], reason: '没有唯一且连续' },
  { words: [{ text: '你好', start: 0.1, end: 0.45 }, { text: '世界', start: 0.52, end: 0.6 }], reason: '没有唯一且连续' },
  { words: [{ text: '你好', start: 0.1, end: 0.3 }, { text: '世界', start: 0.3, end: 0.6 }],
    subtitle: sampleSubtitle.replaceAll('00:00:', '0:00:'), reason: '无法逐字节证明' },
  { words: [{ text: '你好', start: 0.1, end: 0.3 }, { text: '世界', start: 0.3, end: 0.6 }],
    subtitle: sampleSubtitle.replaceAll('00:00:', '0:00:')
      + '\n引用\n以下只是示例\n00:00:00,100 --> 00:00:00,500\n', reason: '无法逐字节证明' },
])('requires a continuous unique tail and an exactly reversible timestamp: $reason', async ({ words, subtitle, reason }) => {
  const { input } = await fixture({ words, ...(subtitle === undefined ? {} : { subtitle }) })
  const result = await prepareSubtitleTailCandidate(input)
  if (result.status !== 'needs_review') throw new Error('Unexpected candidate for an unsuitable tail')
  expect(result.reason).toContain(reason)
  expect(await readdir(input.project)).not.toContain('editing')
})

it('accepts one complete repeated word pair when it is the only full occurrence in the cue', async () => {
  const { input } = await fixture({
    subtitle: sampleSubtitle.replace('你好世界', '回来回来'),
    words: [{ text: '回来', start: 0.1, end: 0.3 }, { text: '回来', start: 0.3, end: 0.6 }],
  })
  expect(await prepareSubtitleTailCandidate(input)).toMatchObject({
    status: 'candidate', candidate_end_seconds: 0.6, listening_verified: false,
  })
})

it('removes the staged candidate if the session rejects the second word read', async () => {
  const { input } = await fixture()
  input.verifyOfflineWords.mockImplementationOnce(() => {})
    .mockImplementationOnce(() => { throw new Error('session evidence no longer matches') })
  const result = await prepareSubtitleTailCandidate(input)
  if (result.status !== 'needs_review') throw new Error('Unexpected candidate for invalidated word evidence')
  expect(result.reason).toContain('重比较后出现其他差异')
  expect(await readdir(join(input.project, 'editing'))).toEqual([])
  expect(await readFile(input.subtitleSrt, 'utf8')).toBe(sampleSubtitle)
})

it('removes the staged candidate if the original subtitle changes during re-verification', async () => {
  const { input } = await fixture()
  const changed = sampleSubtitle.replace('你好', '再见')
  input.verifyOfflineWords.mockImplementationOnce(() => {})
    .mockImplementationOnce(() => { writeFileSync(input.subtitleSrt, changed) })
  const result = await prepareSubtitleTailCandidate(input)
  if (result.status !== 'needs_review') throw new Error('Unexpected candidate for changed inputs')
  expect(result.reason).toContain('比对期间原件或候选已改变')
  expect(await readdir(join(input.project, 'editing'))).toEqual([])
  expect(await readFile(input.subtitleSrt, 'utf8')).toBe(changed)
})
