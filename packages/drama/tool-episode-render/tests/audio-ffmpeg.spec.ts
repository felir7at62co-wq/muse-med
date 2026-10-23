/** Real, network-free FFmpeg evidence for ducking, recovery, stems and aligned auditions. */

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import Tools, { validateJsonSchemaValue } from '@deepseek-ai/dsh-tools'
import { measureAudioWindows, previewAudio } from '../src/audio.ts'
import { fileSha256 } from '../src/cache.ts'
import { audioMixFilter } from '../src/delivery.ts'
import { resolveSettings } from '../src/index.ts'
import * as Render from '../src/index.ts'
import type { AudioWindow, DramaRenderReport, ResolvedAudioMixProfile } from '../src/types.ts'
import { createMediaRunner, ffmpeg, ffprobe, hasFfmpeg } from './audio-ffmpeg-harness.ts'
import { runContext } from './harness.ts'

const roots: string[] = []
const runners: ReturnType<typeof createMediaRunner>[] = []
afterEach(async () => {
  for (const runner of runners.splice(0)) await runner.dispose()
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})
async function fixture() {
  const project = await mkdtemp(join(tmpdir(), 'dsh-audio-offline-'))
  roots.push(project)
  const runner = createMediaRunner()
  runners.push(runner)
  const command = async (args: readonly string[]) => {
    const result = await runner.runCommand(ffmpeg, args)
    expect(result.interrupted, result.stderr).toBe(false)
    expect(result.signal, result.stderr).toBeNull()
    expect(result.code, result.stderr).toBe(0)
    return result
  }
  const original = join(project, 'original.wav')
  const music = join(project, 'music.wav')
  await command(['-n', '-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=8',
    '-af', "volume='2*between(t,2,4)':eval=frame", '-c:a', 'pcm_s16le', '-ac', '2', original])
  await command(['-n', '-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=1000:sample_rate=48000:duration=8',
    '-af', 'volume=0.8', '-c:a', 'pcm_s16le', '-ac', '2', music])
  const timeline = join(project, 'timeline.json')
  await writeFile(timeline, JSON.stringify({ body_end: 8,
    clips: [{ shot: 1, start_us: 0, duration_us: 8_000_000 }] }))
  const profile: ResolvedAudioMixProfile = { schema_version: 1, path: join(project, 'mix.json'),
    mode: 'ducking', original_gain: 1, music_gain: 1, analysis_window_ms: 100,
    ducking: { threshold_db: -30, ratio: 8, attack_ms: 20, release_ms: 200, knee: 2 } }
  const { path: profilePath, ...serialized } = profile
  await writeFile(profilePath, JSON.stringify(serialized))
  const settings = { ...resolveSettings({ ffmpegPath: ffmpeg, ffprobePath: ffprobe }), channel: runner.channel }
  const toolkit = { ffmpeg, ffprobe, channel: runner.channel }
  return { project, runner, command, original, music, timeline, profile, settings, toolkit }
}

function meanRms(rows: readonly AudioWindow[], start: number, end: number): number {
  const values = rows.filter(row => row.time_seconds >= start && row.time_seconds < end)
    .map(row => row.rms_dbfs).filter((value): value is number => value !== null)
  expect(values.length).toBeGreaterThan(0)
  return values.reduce((sum, value) => sum + value, 0) / values.length
}

function waveData(bytes: Buffer): Buffer {
  let offset = 12
  while (offset + 8 <= bytes.length) {
    const count = bytes.readUInt32LE(offset + 4)
    if (bytes.toString('ascii', offset, offset + 4) === 'data') return bytes.subarray(offset + 8, offset + 8 + count)
    offset += 8 + count + count % 2
  }
  throw new Error('WAV has no PCM data chunk')
}

it.skipIf(!hasFfmpeg)('measures energy reduction, pause recovery, LUFS warmup, pure stems and shared sidechain history', async () => {
  const f = await fixture()
  const plan = join(f.project, 'plan.json')
  const generation = join(f.project, 'generation.json')
  await writeFile(plan, JSON.stringify({ episodes: [{ episode: '24', body_duration_seconds: 8,
    intended_use: 'commercial', segments: [{ track: 'Synthetic 1 kHz fixture', source: f.music,
      start_seconds: 0, end_seconds: 8, reason: 'Offline measurement fixture' }] }] }))
  const musicDigest = await fileSha256(f.music)
  // Keep the real composer's complete segment shape: Schemastery preserves unknown
  // keys, so a six-field input fixture cannot catch closed ToolResult schema leaks.
  await writeFile(generation, JSON.stringify({ method: 'compose', episode: '24', project: f.project,
    plan, timeline: f.timeline, output: f.music, intended_use: 'commercial', license_records: [],
    media: { codec: 'pcm_s16le', sample_rate: 48000, channels: 2, duration_seconds: 8,
      size_bytes: (await readFile(f.music)).length, sha256: musicDigest },
    segments: [{ track_id: 'synthetic-tone', track: 'Synthetic 1 kHz fixture', source: f.music,
      license_info: { status: 'unknown' }, source_sha256: musicDigest,
      start_seconds: 0, end_seconds: 8, reason: 'Offline measurement fixture',
      input_duration_seconds: 8, source_start_seconds: 0, source_start_kind: 'explicit',
      source_mean_db: -23, applied_gain_db: 0, valence: 0.5, arousal: 0.5 }] }))
  const ctx = new Context()
  let toolReport: DramaRenderReport
  try {
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(Tools)
    await ctx.plugin(Render, { ffmpegPath: ffmpeg, ffprobePath: ffprobe })
    const tool = ctx.tools.get('drama_render')
    if (tool === undefined) throw new Error('missing drama_render')
    const args = { method: 'audio_preview', project: f.project, episode: 24, timeline: f.timeline,
      audio: f.original, mix_profile: f.profile.path, bgm: f.music, bgm_plan: plan,
      bgm_generation: generation, intended_use: 'commercial', start_seconds: 3, duration_seconds: 4 }
    expect(validateJsonSchemaValue(tool.parameters, args, '')).toEqual([])
    const value = await tool.execute(args, runContext())
    expect(validateJsonSchemaValue(tool.output.schema, value, '')).toEqual([])
    toolReport = value as DramaRenderReport
  } finally {
    await ctx.fiber.dispose()
  }
  if (toolReport.audio_mix === undefined) throw new Error('missing audio_mix')
  const result = { mix: toolReport.audio_mix, bgmPlan: toolReport.bgm_plan }
  expect(Object.keys(result.mix.composition?.segments[0] ?? {}).sort()).toEqual([
    'applied_gain_db', 'end_seconds', 'source', 'source_mean_db', 'start_seconds', 'track',
  ])
  expect(result.mix).toMatchObject({ composition_gain_status: 'provided', composition: {
    segments: [{ track: 'Synthetic 1 kHz fixture', applied_gain_db: 0 }] } })
  expect(result.bgmPlan).toMatchObject({ intended_use: 'commercial',
    segments: [{ track: 'Synthetic 1 kHz fixture', start_seconds: 0, end_seconds: 8 }] })
  expect(result.bgmPlan.license_records[0]?.license_info.status).toBe('unknown')
  const preview = result.mix.preview!
  const report = JSON.parse(await readFile(preview.analysis, 'utf8')) as {
    measurements: Record<string, AudioWindow[]>
    loudness: Record<string, {
      momentary_lufs: number | null
      short_term_lufs: number | null
      momentary_full_window: boolean
      short_term_full_window: boolean
    }[]>
    sidechain_history: string
  }
  const stem = report.measurements.music_stem!
  expect(meanRms(stem, 2.5, 3.5) - meanRms(stem, 0.2, 0.7)).toBeGreaterThan(8)
  expect(stem.every(row => row.peak_dbfs === null || row.peak_dbfs < 0)).toBe(true)
  expect(report.loudness.selected_mix![0]).toMatchObject({ momentary_lufs: null, short_term_lufs: null,
    momentary_full_window: false, short_term_full_window: false })
  expect(report.loudness.selected_mix!.at(-1)).toMatchObject({ momentary_full_window: true, short_term_full_window: true })
  expect(report.sidechain_history).toBe('processed_from_body_zero_before_preview_trim')

  const fullMix = join(f.project, 'full-mix.wav')
  const fullStem = join(f.project, 'full-stem.wav')
  const sliced = join(f.project, 'slice.wav')
  await f.command(['-n', '-v', 'error', '-i', f.original, '-i', f.music, '-filter_complex', audioMixFilter({
    bodyEndSeconds: 8, totalSeconds: 8, endingSeconds: 0, masterVolume: 1, bgmVolume: 1,
    profile: f.profile, originalInput: 0, musicStem: true }),
  '-map', '[a]', '-c:a', 'pcm_s16le', '-ar', '48000', '-ac', '2', fullMix,
  '-map', '[musicstem]', '-c:a', 'pcm_s16le', '-ar', '48000', '-ac', '2', fullStem])
  await f.command(['-n', '-v', 'error', '-i', fullStem, '-af', 'atrim=start=3:duration=4,asetpts=PTS-STARTPTS',
    '-c:a', 'pcm_s16le', '-ar', '48000', '-ac', '2', sliced])
  const previewPcm = waveData(await readFile(preview.music_stem))
  const fullPcm = waveData(await readFile(sliced))
  expect(previewPcm.length).toBe(fullPcm.length)
  let peakDifference = 0
  for (let index = 0; index < previewPcm.length; index += 2) {
    peakDifference = Math.max(peakDifference, Math.abs(previewPcm.readInt16LE(index) - fullPcm.readInt16LE(index)))
  }
  // Separate PCM encodes may round at one least-significant bit; a reset envelope differs by hundreds.
  expect(peakDifference).toBeLessThanOrEqual(2)
  const leakage = join(f.project, 'original-frequency.wav')
  const retained = join(f.project, 'music-frequency.wav')
  for (const [frequency, output] of [[440, leakage], [1000, retained]] as const) {
    await f.command(['-n', '-v', 'error', '-i', preview.music_stem, '-af',
      `bandpass=f=${String(frequency)}:width_type=h:width=20`, '-c:a', 'pcm_s16le', output])
  }
  const leakedRms = meanRms(await measureAudioWindows(f.toolkit, leakage, 100), 2, 3.5)
  const musicRms = meanRms(await measureAudioWindows(f.toolkit, retained, 100), 2, 3.5)
  expect(musicRms - leakedRms).toBeGreaterThan(25)
  console.info('offline audio measurements', JSON.stringify({ recovery_db: meanRms(stem, 2.5, 3.5) - meanRms(stem, 0.2, 0.7),
    original_frequency_rejection_db: musicRms - leakedRms, full_vs_preview_peak_pcm_difference: peakDifference }))
})

it.skipIf(!hasFfmpeg)('refuses a composer receipt for different music bytes before producing an audition', async () => {
  const f = await fixture()
  const generation = join(f.project, 'wrong-generation.json')
  await writeFile(generation, JSON.stringify({ media: { sha256: '0'.repeat(64) }, segments: [] }))
  await expect(previewAudio({ toolkit: f.toolkit, settings: f.settings, project: f.project,
    episode: '24', timelinePath: f.timeline, audio: f.original, profilePath: f.profile.path,
    bgm: f.music, bgmGeneration: generation, startSeconds: 3, durationSeconds: 4 })).rejects.toThrow('SHA-256')
})

it.skipIf(!hasFfmpeg).each(['legacy', 'ducking'] as const)('produces sample-aligned 48 kHz %s auditions across overlapping AAC join timestamps', async (mode) => {
  const f = await fixture()
  const original = join(f.project, 'original-32000.m4a')
  const music = join(f.project, 'music-44100.wav')
  // AAC stream-copy joins can retain a priming frame with a near-duplicate PTS.
  // This reproduces the real 32 kHz reference: a time-only trim kept two extra
  // 1024-sample frames and made a requested 20 s audition 20.064 s long.
  const durations = [10.048, 17.056, 14.08, 14.08]
  for (const [index, duration] of durations.entries()) {
    await f.command(['-n', '-v', 'error', '-f', 'lavfi', '-i', `sine=frequency=440:sample_rate=32000:duration=${String(duration)}`,
      '-c:a', 'aac', '-ar', '32000', '-ac', '2', join(f.project, `part-${String(index)}.m4a`)])
  }
  const concat = join(f.project, 'concat.txt')
  await writeFile(concat, durations.map((_, index) => `file 'part-${String(index)}.m4a'`).join('\n'))
  await f.command(['-n', '-v', 'error', '-f', 'concat', '-safe', '0', '-i', concat, '-c', 'copy', original])
  const frameProbe = await f.runner.runCommand(ffprobe, ['-v', 'error', '-select_streams', 'a:0', '-show_frames',
    '-show_entries', 'frame=pts_time', '-of', 'json', original])
  expect(frameProbe.code, frameProbe.stderr).toBe(0)
  const frames = (JSON.parse(frameProbe.stdout) as { frames: { pts_time: string }[] }).frames
  expect(frames.some((frame, index) => index > 0
    && Number(frame.pts_time) - Number(frames[index - 1]?.pts_time) < 0.001)).toBe(true)
  await f.command(['-n', '-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=1000:sample_rate=44100:duration=56',
    '-c:a', 'pcm_s16le', '-ar', '44100', '-ac', '2', music])
  await writeFile(f.timeline, JSON.stringify({ body_end: 55.264,
    clips: [{ shot: 1, start_us: 0, duration_us: 55_264_000 }] }))
  await writeFile(f.profile.path, JSON.stringify({ ...f.profile, mode, music_gain: 0.23988329190194904 }))
  const result = await previewAudio({ toolkit: f.toolkit, settings: f.settings, project: f.project,
    episode: '24', timelinePath: f.timeline, audio: original, profilePath: f.profile.path,
    bgm: music, startSeconds: 10.048, durationSeconds: 20 })
  if (result.mix.preview === undefined) throw new Error('missing preview')
  const preview = result.mix.preview
  for (const output of [preview.selected_mix, preview.without_added_music, preview.music_stem]) {
    expect(waveData(await readFile(output)).length / 4, output).toBe(960_000)
    const probe = await f.runner.runCommand(ffprobe, ['-v', 'error', '-show_entries',
      'stream=sample_rate,duration', '-of', 'json', output])
    expect(probe.code, probe.stderr).toBe(0)
    expect(JSON.parse(probe.stdout)).toMatchObject({ streams: [{ sample_rate: '48000', duration: '20.000000' }] })
  }
  const analysis = JSON.parse(await readFile(preview.analysis, 'utf8')) as { measurements: Record<string, AudioWindow[]> }
  for (const rows of Object.values(analysis.measurements)) expect(rows).toHaveLength(200)
})

it.skipIf(!hasFfmpeg).each([0, undefined])('keeps no_bgm auditions aligned with profile gain %s and project fallback without reading music', async (originalGain) => {
  const f = await fixture()
  await writeFile(join(f.project, 'project_config.json'), JSON.stringify({
    project_bible: { delivery: { audio: { master_gain: 0.7 } } },
  }))
  await writeFile(f.profile.path, JSON.stringify({ schema_version: 1, mode: 'no_bgm',
    ...(originalGain === undefined ? {} : { original_gain: originalGain }), analysis_window_ms: 100 }))
  const args = { toolkit: f.toolkit, settings: f.settings, project: f.project, episode: '24',
    timelinePath: f.timeline, audio: f.original, profilePath: f.profile.path,
    bgm: join(f.project, 'missing-music.wav'), bgmPlan: join(f.project, 'missing-plan.json'),
    bgmGeneration: join(f.project, 'missing-generation.json'), startSeconds: 1, durationSeconds: 4 }
  const first = await previewAudio(args)
  const second = await previewAudio(args)
  expect(first.output).not.toBe(second.output)
  expect(first.mix).toMatchObject({ mode: 'no_bgm', music_audio: '', music_stem: '', detector: 'none',
    parameters: { original_gain: originalGain ?? 0.7 } })
  expect(first.bgmPlan.path).toBe('')
  expect(await fileSha256(first.output)).toBe(await fileSha256(first.mix.preview!.without_added_music))
  expect(await fileSha256(first.output)).toBe(await fileSha256(second.output))
})
