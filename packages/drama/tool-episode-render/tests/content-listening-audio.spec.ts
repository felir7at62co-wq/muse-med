/** Real media coverage for extracting the current final mix for review. */
import { copyFile, mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { expect, it, onTestFinished, vi } from 'vitest'
import { fileSha256 } from '../src/cache.ts'
import { pictureDurationUs, prepareContentListeningAudio } from '../src/content-listening-audio.ts'
import { preflightContentListening } from '../src/content-listening-preflight.ts'
import { matchesListeningSourcePath } from '../src/content-listening-source.ts'
import { createMediaToolkit } from '../src/ffmpeg.ts'
import { resolveSettings, runDramaRender } from '../src/index.ts'
import { episodePaths } from '../src/paths.ts'
import { readSourceRecord, writeSourceRecord, sourceRecordPathFor, SOURCE_RECORD_VERSION } from '../src/source-record.ts'
import type { MediaToolkit } from '../src/types.ts'
import { createMediaRunner, ffmpeg, ffprobe, hasFfmpeg } from './audio-ffmpeg-harness.ts'

it.skipIf(!hasFfmpeg)('prepares and preflights a native render whose source record names the selected project alias', async () => {
  const temp = await realpath(await mkdtemp(join(tmpdir(), 'dsh-listening-render-alias-')))
  const project = join(temp, 'project'), projectAlias = join(temp, 'alias')
  const runner = createMediaRunner()
  onTestFinished(async () => { await runner.dispose(); await rm(temp, { recursive: true, force: true }) })
  await mkdir(project)
  await symlink(project, projectAlias, 'junction')
  const geometry = { width: 480, height: 854, fps: 30 }
  const paths = episodePaths(projectAlias, '21')
  const subtitleSrt = join(projectAlias, 'editing', 'fixture.srt')
  const mixProfile = join(projectAlias, 'audio', 'mix.json')
  const output = join(projectAlias, 'exports', 'alias-21.mp4')
  await Promise.all([paths.videoDir, dirname(paths.masterAudio), dirname(paths.timeline), dirname(output)]
    .map(directory => mkdir(directory, { recursive: true })))
  const capture = async (args: readonly string[]) => {
    const result = await runner.runCommand(ffmpeg, ['-nostdin', '-v', 'error', '-n', ...args])
    expect(result.code, result.stderr).toBe(0)
  }
  await Promise.all([
    writeFile(join(projectAlias, 'project_config.json'), JSON.stringify({ project_bible: {
      visual_medium: 'animation_3d', delivery: { ...geometry, audio: { require_music_decision: true } },
    } })),
    writeFile(paths.timeline, JSON.stringify({
      delivery: geometry, clips: [{ shot: 1, start_us: 0, duration_us: 1_000_000 }], body_end: 1,
    })),
    writeFile(subtitleSrt, '1\n00:00:00,100 --> 00:00:00,400\nFixture\n'),
    writeFile(mixProfile, JSON.stringify({ schema_version: 1, mode: 'no_bgm', original_gain: 1, analysis_window_ms: 20 })),
    capture(['-f', 'lavfi', '-i', 'testsrc2=s=480x854:r=30:d=1', '-vf', 'noise=alls=60:allf=t+u',
      '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '13', '-pix_fmt', 'yuv420p', join(paths.videoDir, 'shot_001.mp4')]),
    capture(['-f', 'lavfi', '-i', 'sine=frequency=330:sample_rate=48000:duration=1', '-ac', '2', '-c:a', 'pcm_s16le', paths.masterAudio]),
  ])
  const settings = { ...resolveSettings({ ffmpegPath: ffmpeg, ffprobePath: ffprobe, preferNvenc: false,
    ...(process.env.DSH_FONTS_DIR === undefined ? {} : { fontsDir: process.env.DSH_FONTS_DIR }) }), channel: runner.channel }
  const report = await runDramaRender({ method: 'render', project: projectAlias, episode: 21, timeline: paths.timeline,
    subtitleSrt, lastShot: 1, mixProfile, output, resume: true }, settings)
  expect(report.ok, JSON.stringify(report.checks)).toBe(true)
  const record = await readSourceRecord(sourceRecordPathFor(report.output))
  expect(record?.output.path).toBe(report.output)
  expect(record?.input_files?.find(file => file.path === join(projectAlias, 'project_config.json'))?.sha256).toMatch(/^[a-f0-9]{64}$/u)
  const actualOutput = await realpath(report.output)
  expect(actualOutput).not.toBe(report.output)
  const toolkit = createMediaToolkit({ ffmpeg, ffprobe, channel: runner.channel })
  const base = { toolkit, project, projectAlias, episode: '21', output: actualOutput }
  await expect(prepareContentListeningAudio(base)).resolves.toMatchObject({
    source_path: actualOutput, source_sha256: record?.output.sha256, duration_us: 1_000_000,
  })
  await expect(preflightContentListening({ ...base, subtitleSrt: await realpath(subtitleSrt) })).resolves.toMatchObject({
    source_sha256: record?.output.sha256, external_requests: 0, source_music_mode: 'none',
  })
}, 90_000)

it('refuses foreign links and identical files at a different identity when binding receipts', async () => {
  const temp = await realpath(await mkdtemp(join(tmpdir(), 'dsh-listening-receipt-path-')))
  onTestFinished(async () => { await rm(temp, { recursive: true, force: true }) })
  const project = join(temp, 'project'), outside = join(temp, 'outside')
  await Promise.all([mkdir(project), mkdir(outside)])
  const physical = join(project, 'film.mp4'), duplicate = join(project, 'copy.mp4')
  await Promise.all([physical, duplicate, join(outside, 'film.mp4')].map(path => writeFile(path, 'same bytes')))
  const link = join(project, 'escape')
  await symlink(outside, link, 'junction')
  const same = (path: unknown, projectAlias?: string) =>
    matchesListeningSourcePath({ project, ...(projectAlias === undefined ? {} : { projectAlias }) }, physical, path)
  await expect(same(undefined)).resolves.toBe(false)
  await expect(same('film.mp4')).resolves.toBe(false)
  await expect(same(duplicate)).resolves.toBe(false)
  await expect(same(join(link, 'film.mp4'))).resolves.toBe(false)
  await expect(same(join(outside, 'film.mp4'), outside)).resolves.toBe(false)
})

it.skipIf(!hasFfmpeg)('binds the full 59.125 second final stereo mix and refuses a wrong episode or truncated mix', async () => {
  const project = await realpath(await mkdtemp(join(tmpdir(), 'dsh-listening-audio-')))
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

const receiptStat = vi.hoisted(() => ({ deniedPath: '' }))
vi.mock('node:fs/promises', async (original) => {
  const fs = await original<typeof import('node:fs/promises')>()
  return { ...fs, lstat: async (...args: Parameters<typeof fs.lstat>) => {
    if (args[0] === receiptStat.deniedPath) throw Object.assign(new Error('fixture receipt access denied'), { code: 'EACCES' })
    return await fs.lstat(...args)
  } }
})

it.each([
  [12, '', '无法读取成片画面时间'],
  [0, '{', '成片画面时间报告损坏'],
  [0, '{"streams":[]}', '试听准备要求一条从零开始'],
  [0, '{"streams":[{"start_time":"0.1","duration":"1"}]}', '试听准备要求一条从零开始'],
] as const)('rejects an invalid or unavailable picture clock (ffprobe exit %s, %s)', async (code, stdout, reason) => {
  const toolkit: MediaToolkit = { ffmpeg: 'ffmpeg', ffprobe: 'ffprobe', channel: { run: async () => ({ code, stdout, stderr: '' }) } }
  await expect(pictureDurationUs(toolkit, 'fixture.mp4')).rejects.toThrow(reason)
})

async function preparationFixture() {
  const project = await realpath(await mkdtemp(join(tmpdir(), 'muse-preparation-guard-')))
  onTestFinished(async () => { await rm(project, { recursive: true, force: true }) })
  const output = join(project, 'film.mp4'), receipt = sourceRecordPathFor(output), audioRoot = join(project, 'audio')
  await writeFile(output, 'controlled video bytes')
  const sha = await fileSha256(output)
  const record = { version: SOURCE_RECORD_VERSION, episode: '21', rendered_at: new Date(0).toISOString(),
    output: { path: output, sha256: sha, size_bytes: (await stat(output)).size, duration_seconds: 1 },
    inputs: [], encoder: 'mpeg4', checks: [] }
  await writeSourceRecord(receipt, record)
  return { project, episode: '21', output, receipt, audioRoot, record }
}

it('rejects a non-MP4, an unusable source receipt, a stale picture duration and a redirected audio root', async () => {
  const f = await preparationFixture()
  const toolkit: MediaToolkit = { ffmpeg: 'ffmpeg', ffprobe: 'ffprobe', channel: { run: async (_command, args) => {
    expect(args).toContain('stream=start_time,duration')
    return { code: 0, stdout: '{"streams":[{"start_time":"0","duration":"1"}]}', stderr: '' }
  } } }
  const call = (output = f.output) => prepareContentListeningAudio({ ...f, toolkit, output })
  const wav = join(f.project, 'audio.wav')
  await writeFile(wav, 'not a picture')
  await expect(call(wav)).rejects.toThrow('请提供本集实际渲染输出的 MP4')

  receiptStat.deniedPath = f.receipt
  try { await expect(call()).rejects.toMatchObject({ code: 'EACCES' }) }
  finally { receiptStat.deniedPath = '' }
  await writeFile(f.receipt, '')
  await expect(call()).rejects.toThrow('找不到成片旁边的有效来源回执')

  await writeSourceRecord(f.receipt, { ...f.record, output: { ...f.record.output, duration_seconds: 2 } })
  await expect(call()).rejects.toThrow('实际画面时长与成片来源回执不符')
  await writeSourceRecord(f.receipt, f.record)
  const redirected = join(f.project, 'other-audio')
  await mkdir(redirected)
  await symlink(redirected, f.audioRoot, 'junction')
  await expect(call()).rejects.toThrow('项目 audio 目录发生重定向')
  expect(await readdir(redirected)).toEqual([])
})

it.each(['receipt changed', 'cancelled'] as const)('rolls back extracted audio when %s at the final validation', async (fault) => {
  const f = await preparationFixture()
  const original = await readFile(f.receipt, 'utf8')
  const owner = new AbortController()
  const toolkit: MediaToolkit = { ffmpeg: 'ffmpeg', ffprobe: 'ffprobe', channel: { run: async (command, args) => {
    if (command === 'ffprobe' && args.includes('v')) {
      return { code: 0, stdout: '{"streams":[{"start_time":"0","duration":"1"}]}', stderr: '' }
    }
    if (command === 'ffprobe') {
      return { code: 0, stderr: '', stdout: JSON.stringify({ streams: [{
        codec_name: args.at(-1)?.endsWith('.wav') ? 'pcm_s16le' : 'aac', sample_rate: '48000',
        channels: 2, time_base: '1/48000', start_pts: 0, duration_ts: 48000,
      }] }) }
    }
    if (args.includes('-hash')) {
      if (fault === 'receipt changed') await writeFile(f.receipt, `${original}\n`)
      else owner.abort(new Error('fixture review cancelled'))
      return { code: 0, stdout: `SHA256=${'a'.repeat(64)}\n`, stderr: '' }
    }
    const target = args.at(-1)
    if (target === undefined) throw new Error('Expected disposable WAV argument')
    await writeFile(target, 'controlled playback bytes')
    return { code: 0, stdout: '', stderr: '' }
  } } }
  await expect(prepareContentListeningAudio({ ...f, toolkit, signal: owner.signal }))
    .rejects.toThrow(fault === 'receipt changed' ? '提取期间成片来源回执发生变化' : 'fixture review cancelled')
  expect(await readdir(f.audioRoot)).toEqual([])
  expect(await fileSha256(f.output)).toBe(f.record.output.sha256)
})
