import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, onTestFinished } from 'vitest'
import { fileSha256 } from '../src/cache.ts'
import { acousticRate, measureAcousticWindow } from '../src/content-listening-acoustic.ts'
import { preflightContentListening } from '../src/content-listening-preflight.ts'
import { deliveryPictureClockSchema, planDeliveryPictureClock } from '../src/picture-clock.ts'
import { renderMusicStem } from '../src/render-resume.ts'
import { sourceRecordPathFor, SOURCE_RECORD_VERSION, writeSourceRecord } from '../src/source-record.ts'
import type { DeliverySourceRecord } from '../src/source-record.ts'
import type { MediaToolkit } from '../src/types.ts'
import { createMediaRunner, ffmpeg, ffprobe, hasFfmpeg } from './audio-ffmpeg-harness.ts'

function referenceSignal(rate: number, seconds: number): Float32Array {
  const pcm = new Float32Array(rate * seconds * 2)
  let state = 59249, previous = 0
  for (let i = 0; i < pcm.length; i += 2) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0
    previous += 0.035 * ((state / 0x80000000 - 1) - previous)
    pcm[i] = previous
    pcm[i + 1] = -previous * 0.8
  }
  return pcm
}

it('finds retained, missing or shifted stereo signal, with quiet and unrelated bands still unresolved', () => {
  const ref = referenceSignal(acousticRate, 2)
  const start = acousticRate / 2, end = start + acousticRate / 8, ceiling = ref.length / 2
  expect(measureAcousticWindow(ref, ref, start, end, ceiling).status).toBe('matching')
  const delay = 989, deferred = new Float32Array(ref.length)
  deferred.set(ref.subarray(0, ref.length - delay * 2), delay * 2)
  expect(measureAcousticWindow(ref, deferred, start, end, ceiling))
    .toMatchObject({ status: 'shifted_reference_signal', lagSamples: delay })
  const absent = ref.slice()
  absent.fill(0, start * 2, end * 2)
  expect(measureAcousticWindow(ref, absent, start, end, ceiling).status).toBe('missing_reference_signal')
  const soft = ref.map(value => value / 200)
  expect(measureAcousticWindow(soft, absent, start, end, ceiling).status).toBe('uncertain_reference')
  const unrelated = ref.map((value, i) => value * (i % 4 === 0 || i % 4 === 1 ? 1 : -1))
  expect(measureAcousticWindow(ref, unrelated, start, end, ceiling).status).toBe('uncertain_correspondence')
})

it('distinguishes truncated input from a missing playback signal and accepts a bounded unique shift', () => {
  const reference = referenceSignal(acousticRate, 1)
  const end = 1_000
  const truncated = reference.slice(0, end * 2 - 2)
  expect(measureAcousticWindow(truncated, reference, 0, end, end).status).toBe('uncertain_reference')
  expect(measureAcousticWindow(reference, new Float32Array(), 0, end, end).status).toBe('missing_reference_signal')
  expect(measureAcousticWindow(new Float32Array(end * 2), reference, 0, end, end))
    .toMatchObject({ status: 'uncertain_reference', nominal: { referenceRms: 0, gain: 0 } })
  const delay = 64
  const shifted = new Float32Array((end + delay) * 2)
  shifted.set(reference.subarray(0, end * 2), delay * 2)
  expect(measureAcousticWindow(reference, shifted, 0, end, end + delay))
    .toMatchObject({ status: 'shifted_reference_signal', lagSamples: delay, aligned: { correlation: 1 } })
})

it.skipIf(!hasFfmpeg)('preflights the same bound MP4 and exposes a real encoded final subtitle-tail omission', async () => {
  const project = await realpath(await mkdtemp(join(tmpdir(), 'muse-rendered-audio-preflight-'))), runner = createMediaRunner()
  onTestFinished(async () => {
    await runner.dispose()
    await rm(project, { recursive: true, force: true })
  })
  const rate = 48_000, duration = 3, episode = '21'
  const master = join(project, 'audio', '21.wav'), subtitle = join(project, 'display.srt'), raw = join(project, 'raw.f32')
  await mkdir(join(project, 'audio'))
  await writeFile(raw, Buffer.from(referenceSignal(rate, duration).buffer))
  const run = async (args: readonly string[]) => {
    const encoded = await runner.runCommand(ffmpeg, ['-nostdin', '-v', 'error', '-threads', '1', ...args])
    expect(encoded.code, encoded.stderr).toBe(0)
  }
  await run(['-f', 'f32le', '-ar', String(rate), '-ac', '2', '-i', raw, '-c:a', 'pcm_f32le', master])
  await writeFile(subtitle, '1\n00:00:00,500 --> 00:00:02,750\n示例\n')
  const toolkit = { ffmpeg, ffprobe, channel: runner.channel }
  const [subtitleSha, masterSha] = await Promise.all([fileSha256(subtitle), fileSha256(master)])
  const clock = deliveryPictureClockSchema.parse(planDeliveryPictureClock([{ shot: 1, startUs: 0, durationUs: 3_000_000 }], 24, 0))
  const builds = [
    { name: 'good', filter: '', signalIssue: false, tailStatus: 'matching' },
    { name: 'drop', filter: 'atrim=end_sample=132000,apad,atrim=end_sample=144000', signalIssue: true, tailStatus: 'missing_reference_signal' },
    { name: 'shift', filter: 'adelay=delays=5934S:all=1,atrim=end_sample=144000', signalIssue: true },
  ]
  for (const { name, filter, signalIssue, tailStatus } of builds) {
    const output = join(project, `${name}.mp4`)
    await run(['-f', 'lavfi', '-i', 'color=black:s=24x24:r=24:d=3', '-i', master,
      ...(filter === '' ? [] : ['-af', filter]),
      '-c:v', 'mpeg4', '-c:a', 'aac', '-ar', String(rate), '-movie_timescale', String(rate), output])
    const sha = await fileSha256(output), record = sourceRecordPathFor(output)
    const source: DeliverySourceRecord = { version: SOURCE_RECORD_VERSION, episode, rendered_at: new Date(0).toISOString(),
      output: { path: output, sha256: sha, size_bytes: (await stat(output)).size, duration_seconds: duration },
      inputs: [], input_files: [{ path: master, sha256: masterSha }, { path: subtitle, sha256: subtitleSha }],
      delivery_inputs: { picture_clock: clock, timeline_sha256: 'c'.repeat(64), master_audio_sha256: masterSha,
        subtitle_sha256: subtitleSha, subtitle_display: 'external', videos: [{ shot: 1, sha256: 'c'.repeat(64) }],
        music: { mode: 'none', gain: 0 } }, encoder: 'mpeg4', checks: [] }
    await writeSourceRecord(record, source)
    const input = { toolkit, project, episode, output }
    const result = await preflightContentListening({ ...input, subtitleSrt: subtitle })
    expect(result).toMatchObject({ status: signalIssue ? 'issues_found' : 'needs_review', source_sha256: sha,
      listening_verified: false, grants_approval: false, external_requests: 0, last_subtitle_end_us: 2_750_000 })
    if (tailStatus !== undefined) {
      expect(result).toMatchObject({ final_subtitle_signal_issue: signalIssue, final_subtitle_following_signal: {
        start_us: 2_750_000, end_us: 3_000_000, status: tailStatus,
      } })
    }
    if (name === 'shift') {
      const shifted = result.findings.find(finding => finding.status === 'shifted_reference_signal')
      expect(shifted?.lag_us).toBeGreaterThan(100_000)
    }
    expect(result.issue_count === 0).toBe(!signalIssue)
    expect(createHash('sha256').update(await readFile(record)).digest('hex')).toBe(result.source_record_sha256)
    expect(await fileSha256(output)).toBe(sha)
    if (name === 'good') {
      const stem = renderMusicStem(output)
      await run(['-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo:d=2.5', '-c:a', 'pcm_f32le', stem])
      const musicSha = await fileSha256(stem)
      const delivery = source.delivery_inputs
      if (delivery === undefined) throw new Error('Expected bound delivery inputs')
      await writeSourceRecord(record, { ...source, music_stem_sha256: musicSha,
        delivery_inputs: { ...delivery, subtitle_display: 'overlay', music: { mode: 'music', gain: 0.1 } } })
      const mixed = await preflightContentListening({ ...input, subtitleSrt: subtitle })
      expect(mixed).toMatchObject({ source_music_mode: 'music', status: 'needs_review', external_requests: 0 })
      expect(mixed.reference_files).toContainEqual({ path: stem, sha256: musicSha })
      expect(mixed).not.toHaveProperty('last_subtitle_end_us')
      expect(mixed).not.toHaveProperty('final_subtitle_following_signal')

      const blank = join(project, 'empty.srt')
      await writeFile(blank, '\n')
      const emptySha = await fileSha256(blank)
      await writeSourceRecord(record, { ...source,
        input_files: [{ path: master, sha256: masterSha }, { path: blank, sha256: emptySha }],
        delivery_inputs: { ...delivery, subtitle_sha256: emptySha } })
      const emptyDisplay = await preflightContentListening({ ...input, subtitleSrt: blank })
      expect(emptyDisplay).not.toHaveProperty('last_subtitle_end_us')
      expect(emptyDisplay).not.toHaveProperty('final_subtitle_following_signal')
      const noDisplay = await preflightContentListening(input)
      expect(noDisplay.reference_files).toHaveLength(2)
    }
  }
}, 30_000)

it('rejects incomplete source, clock, music, and subtitle receipts before reading media', async () => {
  const project = await realpath(await mkdtemp(join(tmpdir(), 'muse-reject-preflight-')))
  onTestFinished(async () => { await rm(project, { recursive: true, force: true }) })
  await mkdir(join(project, 'audio'))
  const output = join(project, 'episode.mp4'), master = join(project, 'audio', '21.wav'), subtitle = join(project, 'display.srt')
  await Promise.all([writeFile(output, 'synthetic output'), writeFile(master, 'synthetic master'), writeFile(subtitle, 'subtitle')])
  const [sha, masterSha, subtitleSha, info] = await Promise.all([
    fileSha256(output), fileSha256(master), fileSha256(subtitle), stat(output),
  ])
  const toolkit: MediaToolkit = { ffmpeg: 'ffmpeg', ffprobe: 'ffprobe', channel: { run: async () => {
    throw new Error('Incomplete receipts should be rejected before media decoding')
  } } }
  const clock = deliveryPictureClockSchema.parse(planDeliveryPictureClock([{ shot: 1, startUs: 0, durationUs: 1_000_000 }], 24, 0))
  const deliveryInputs = { timeline_sha256: sha, master_audio_sha256: masterSha,
    subtitle_sha256: subtitleSha, subtitle_display: 'external' as const, videos: [{ shot: 1, sha256: sha }] }
  const delivery = { ...deliveryInputs, picture_clock: clock }
  const source: DeliverySourceRecord = { version: SOURCE_RECORD_VERSION, episode: '21', rendered_at: new Date(0).toISOString(),
    output: { path: output, sha256: sha, size_bytes: info.size, duration_seconds: 1 }, inputs: [], encoder: 'mpeg4', checks: [],
    input_files: [{ path: master, sha256: masterSha }], delivery_inputs: { ...delivery, music: { mode: 'none', gain: 0 } } }
  const reject = async (receipt: DeliverySourceRecord, reason: string, subtitleSrt?: string) => {
    await writeSourceRecord(sourceRecordPathFor(output), receipt)
    await expect(preflightContentListening({ toolkit, project, output, episode: '21',
      ...(subtitleSrt === undefined ? {} : { subtitleSrt }) })).rejects.toThrow(reason)
  }
  await reject({ ...source, episode: '22' }, '当前集完整原生渲染来源回执')
  await reject({ ...source, delivery_inputs: deliveryInputs }, '缺少已核实的正文画面时间')
  await reject({ ...source, input_files: [{ path: master, sha256: sha }] }, '未绑定本集正文母轨')
  await reject({ ...source, delivery_inputs: delivery }, '缺少确定的音乐选择')
  const needsStem: DeliverySourceRecord = { ...source, delivery_inputs: { ...delivery, music: { mode: 'music', gain: 0.1 } } }
  await reject(needsStem, '缺少同版独立音乐轨摘要')
  await reject({ ...needsStem, music_stem_sha256: 'invalid' }, '缺少同版独立音乐轨摘要')
  await reject(source, '与当前成片绑定的实际显示字幕不符', subtitle)
})
