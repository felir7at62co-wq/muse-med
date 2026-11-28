import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, onTestFinished } from 'vitest'
import { fileSha256 } from '../src/cache.ts'
import { acousticRate, measureAcousticWindow } from '../src/content-listening-acoustic.ts'
import { preflightContentListening } from '../src/content-listening-preflight.ts'
import { planDeliveryPictureClock } from '../src/picture-clock.ts'
import { sourceRecordPathFor, SOURCE_RECORD_VERSION, writeSourceRecord } from '../src/source-record.ts'
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

it.skipIf(!hasFfmpeg)('preflights the same bound MP4 and exposes a real encoded final subtitle-tail omission', async () => {
  const project = await mkdtemp(join(tmpdir(), 'muse-rendered-audio-preflight-')), runner = createMediaRunner()
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
  const clock = planDeliveryPictureClock([{ shot: 1, startUs: 0, durationUs: 3_000_000 }], 24, 0)
  if (clock === undefined) throw new Error('Fixture picture clock missing')
  for (const dropped of [false, true]) {
    const output = join(project, dropped ? 'drop.mp4' : 'good.mp4')
    await run(['-f', 'lavfi', '-i', 'color=black:s=24x24:r=24:d=3', '-i', master,
      ...(dropped ? ['-af', 'atrim=end_sample=132000,apad,atrim=end_sample=144000'] : []),
      '-c:v', 'mpeg4', '-c:a', 'aac', '-ar', String(rate), '-movie_timescale', String(rate), output])
    const sha = await fileSha256(output), record = sourceRecordPathFor(output)
    await writeSourceRecord(record, { version: SOURCE_RECORD_VERSION, episode, rendered_at: new Date(0).toISOString(),
      output: { path: output, sha256: sha, size_bytes: (await stat(output)).size, duration_seconds: duration },
      inputs: [], input_files: [{ path: master, sha256: masterSha }, { path: subtitle, sha256: subtitleSha }],
      delivery_inputs: { picture_clock: clock, timeline_sha256: 'c'.repeat(64), master_audio_sha256: masterSha,
        subtitle_sha256: subtitleSha, subtitle_display: 'external', videos: [{ shot: 1, sha256: 'c'.repeat(64) }],
        music: { mode: 'none', gain: 0 } }, encoder: 'mpeg4', checks: [] })
    const result = await preflightContentListening({ toolkit, project, episode, output, subtitleSrt: subtitle })
    expect(result).toMatchObject({ status: dropped ? 'issues_found' : 'needs_review', source_sha256: sha,
      listening_verified: false, grants_approval: false, external_requests: 0, last_subtitle_end_us: 2_750_000,
      final_subtitle_signal_issue: dropped, final_subtitle_following_signal: {
        start_us: 2_750_000, end_us: 3_000_000, status: dropped ? 'missing_reference_signal' : 'matching',
      } })
    expect(result.issue_count === 0).toBe(!dropped)
    expect(createHash('sha256').update(await readFile(record)).digest('hex')).toBe(result.source_record_sha256)
    expect(await fileSha256(output)).toBe(sha)
  }
}, 30_000)
