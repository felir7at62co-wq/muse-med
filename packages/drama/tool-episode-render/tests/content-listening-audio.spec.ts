/** Real media coverage for extracting the current final mix for review. */
import { copyFile, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { fileSha256 } from '../src/cache.ts'
import { prepareContentListeningAudio } from '../src/content-listening-audio.ts'
import { createMediaToolkit } from '../src/ffmpeg.ts'
import { writeSourceRecord, sourceRecordPathFor, SOURCE_RECORD_VERSION } from '../src/source-record.ts'
import { createMediaRunner, ffmpeg, ffprobe, hasFfmpeg } from './audio-ffmpeg-harness.ts'

it.skipIf(!hasFfmpeg)('binds the full 59.125 second final stereo mix and refuses a wrong episode or truncated mix', async () => {
  const project = await mkdtemp(join(tmpdir(), 'dsh-listening-audio-'))
  const runner = createMediaRunner()
  try {
    const build = async (name: string, audioDuration: number) => {
      const output = join(project, name)
      const encoded = await runner.runCommand(ffmpeg, ['-nostdin', '-v', 'error', '-n',
        '-f', 'lavfi', '-i', 'color=black:s=24x24:r=24:d=59.125',
        '-f', 'lavfi', '-i', `aevalsrc=0.15*sin(2*PI*330*t)|0.12*sin(2*PI*880*t):s=48000:d=${String(audioDuration)}:c=stereo`,
        '-c:v', 'mpeg4', '-c:a', 'aac', output])
      expect(encoded.code, encoded.stderr).toBe(0)
      const sha256 = await fileSha256(output)
      const size_bytes = (await stat(output)).size
      await writeSourceRecord(sourceRecordPathFor(output), { version: SOURCE_RECORD_VERSION, episode: '21',
        rendered_at: new Date(0).toISOString(), output: { path: output, sha256, size_bytes, duration_seconds: 59.125 },
        inputs: [], encoder: 'mpeg4', checks: [] })
      return { output, sha256 }
    }
    const full = await build('film.mp4', 59.125)
    const truncated = await build('short-audio.mp4', 58)
    const toolkit = createMediaToolkit({ ffmpeg, ffprobe, channel: runner.channel })
    const args = { toolkit, project, episode: '21', output: full.output }
    const prepared = await prepareContentListeningAudio(args)
    expect(prepared).toMatchObject({ status: 'prepared_for_review', listening_verified: false, grants_approval: false,
      source_sha256: full.sha256, duration_us: 59_125_000, sample_count: 2_838_000, sample_rate: 48000, channels: 2 })
    expect(prepared.source_record_sha256).toBe(await fileSha256(sourceRecordPathFor(full.output)))
    expect(prepared.wav_sha256).toBe(await fileSha256(prepared.wav_path))
    expect(JSON.parse(await readFile(prepared.receipt_path, 'utf8'))).toEqual(prepared)
    const pcm = await runner.runCommand(ffmpeg, ['-v', 'error', '-nostdin', '-i', full.output, '-map', '0:a:0',
      '-af', 'atrim=end_sample=2838000', '-c:a', 'pcm_s16le', '-f', 'hash', '-hash', 'sha256', '-'])
    expect(pcm.code, pcm.stderr).toBe(0)
    expect(pcm.stdout.trim()).toBe(`SHA256=${prepared.pcm_sha256}`)

    const audioRoot = join(project, 'audio')
    const retained = await readdir(audioRoot)
    await expect(prepareContentListeningAudio({ ...args, episode: '22' })).rejects.toThrow('集号')
    await expect(prepareContentListeningAudio({ ...args, output: truncated.output })).rejects.toThrow('未覆盖完整画面时长')
    const noReceipt = join(project, 'no-receipt.mp4')
    await copyFile(full.output, noReceipt)
    await expect(prepareContentListeningAudio({ ...args, output: noReceipt })).rejects.toThrow('找不到成片旁边的有效来源回执')
    const tampered = await readFile(full.output)
    tampered[15] = tampered[15]! ^ 1
    await writeFile(full.output, tampered)
    await expect(prepareContentListeningAudio(args)).rejects.toMatchObject({ code: 'CONTENT_LISTENING_PREPARATION_FAILED' })
    expect(await readdir(audioRoot)).toEqual(retained)
  } finally {
    await runner.dispose()
    await rm(project, { recursive: true, force: true })
  }
}, 30_000)
