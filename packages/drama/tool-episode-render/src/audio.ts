/** Explicit project audio profiles, aligned auditions, and short-window measurements. */

import { lstat, mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import z from '@deepseek-ai/schemastery'
import { licenseRiskWarnings } from '@deepseek-ai/dsh-bgm-license-info'
import { readBgmPlan } from './bgm.ts'
import { fileSha256 } from './cache.ts'
import { audioMixFilter, deliveryRenderSettings } from './delivery.ts'
import { resolveDeliveryPolicy } from './delivery-policy.ts'
import { captureFfmpeg, MediaCommandError, runFfmpeg } from './ffmpeg.ts'
import { readTimeline } from './timeline.ts'
import type { AudioMixProfile, AudioMixReport, AudioWindow, BgmPlanReport, MediaToolkit, RenderSettings,
  ResolvedAudioMixProfile, Timeline } from './types.ts'

const Profile: z<Omit<AudioMixProfile, 'ducking'>> = z.object({
  schema_version: z.const(1).required(),
  mode: z.union(['legacy', 'no_bgm', 'ducking'] as const).required(),
  original_gain: z.number().min(0).max(8),
  music_gain: z.number().min(0).max(8),
  analysis_window_ms: z.number().min(10).max(1000).required(),
})
const Ducking = z.object({
  threshold_db: z.number().min(-60).max(0).required(),
  ratio: z.number().min(1).max(20).required(),
  attack_ms: z.number().min(0.01).max(2000).required(),
  release_ms: z.number().min(0.01).max(9000).required(),
  knee: z.number().min(1).max(8).required(),
})

/** Optional model-facing evidence for an explicitly selected project audio profile. */
export const AUDIO_MIX_RESULT_SCHEMA = {
  type: 'object', additionalProperties: false, properties: {
    schema_version: { type: 'integer', required: true, enum: [1] },
    profile_path: { type: 'string', required: true },
    mode: { type: 'string', required: true, enum: ['legacy', 'no_bgm', 'ducking'] },
    detector: { type: 'string', required: true, enum: ['source_audio_rms_not_speech_vad', 'none'] },
    original_audio: { type: 'string', required: true },
    music_audio: { type: 'string', required: true },
    music_stem: { type: 'string', required: true },
    composition_gain_status: { type: 'string', required: true, enum: ['provided', 'not_provided'] },
    composition: { type: 'object', additionalProperties: false, properties: {
      path: { type: 'string', required: true }, bed_sha256: { type: 'string', required: true },
      segments: { type: 'array', required: true, items: { type: 'object', additionalProperties: false, properties: {
        track: { type: 'string', required: true }, source: { type: 'string', required: true },
        start_seconds: { type: 'number', required: true }, end_seconds: { type: 'number', required: true },
        source_mean_db: { type: 'number', required: true }, applied_gain_db: { type: 'number', required: true },
      } } },
    } },
    parameters: { type: 'object', required: true, additionalProperties: false, properties: {
      schema_version: { type: 'integer', required: true, enum: [1] },
      mode: { type: 'string', required: true, enum: ['legacy', 'no_bgm', 'ducking'] },
      original_gain: { type: 'number', required: true },
      music_gain: { type: 'number', required: true },
      analysis_window_ms: { type: 'number', required: true },
      ducking: { type: 'object', additionalProperties: false, properties: {
        threshold_db: { type: 'number', required: true }, ratio: { type: 'number', required: true },
        attack_ms: { type: 'number', required: true }, release_ms: { type: 'number', required: true },
        knee: { type: 'number', required: true },
      } },
    } },
    preview: { type: 'object', additionalProperties: false, properties: {
      start_seconds: { type: 'number', required: true }, duration_seconds: { type: 'number', required: true },
      selected_mix: { type: 'string', required: true }, without_added_music: { type: 'string', required: true },
      music_stem: { type: 'string', required: true }, analysis: { type: 'string', required: true },
    } },
  },
} as const

/** Reject a lexical or real path outside one real project directory. */
function assertOwned(project: string, candidate: string, alias = project): void {
  const outside = (parent: string) => {
    const relation = relative(parent, candidate)
    return relation === '..' || relation.startsWith(`..${sep}`) || isAbsolute(relation)
  }
  if (outside(project) && outside(alias)) {
    throw new Error(`音频路径必须位于项目目录内：${candidate}`)
  }
}

/** Resolve and require a nonempty project-owned input after link resolution.
 * @param project - Project root.
 * @param candidate - Project-relative or absolute input.
 * @returns The input's real path inside the real project.
 */
export async function requireProjectAudioFile(project: string, candidate: string): Promise<string> {
  const root = await realpath(project)
  const file = resolve(project, candidate)
  assertOwned(root, file, resolve(project))
  const actual = await realpath(file)
  assertOwned(root, actual)
  const info = await stat(actual)
  if (!info.isFile() || info.size === 0) throw new Error(`音频输入不是非空文件：${file}`)
  return actual
}

/** Validate a new output and its real parent without replacing any existing path.
 * @param project - Project root.
 * @param output - New project-owned output file.
 */
export async function requireNewAudioOutput(project: string, output: string): Promise<void> {
  const root = await realpath(project)
  assertOwned(root, resolve(output), resolve(project))
  let ancestor = dirname(output)
  while (true) {
    try {
      assertOwned(root, await realpath(ancestor))
      break
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      ancestor = dirname(ancestor)
    }
  }
  try {
    await lstat(output)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
    throw error
  }
  throw new Error(`音频交付不会覆盖已有路径：${output}`)
}

/** Load one explicit, versioned profile and capture the deployment gains once.
 * @param project - Project root.
 * @param candidate - Explicit project-owned JSON file.
 * @param settings - Existing gain configuration.
 * @returns The validated profile with real path and effective gains.
 */
export async function loadAudioMixProfile(
  project: string, candidate: string, settings: Pick<RenderSettings, 'masterVolume' | 'bgmVolume' | 'maxBgmVolume'>,
): Promise<ResolvedAudioMixProfile> {
  const file = await requireProjectAudioFile(project, candidate)
  if ((await stat(file)).size > 32_768) throw new Error('音频配置文件不能超过 32 KiB。')
  const document: unknown = JSON.parse((await readFile(file, 'utf8')).replace(/^\ufeff/u, ''))
  const profile = Profile(document as Parameters<typeof Profile>[0])
  let ducking: AudioMixProfile['ducking']
  if (profile.mode === 'ducking') {
    const raw = (document as { ducking?: unknown }).ducking
    if (raw === undefined) throw new Error('ducking 音频配置必须显式给出 threshold_db、ratio、attack_ms、release_ms、knee。')
    ducking = Ducking(raw)
  }
  return { schema_version: 1, mode: profile.mode, analysis_window_ms: profile.analysis_window_ms,
    path: file, original_gain: profile.original_gain ?? settings.masterVolume,
    music_gain: profile.mode === 'no_bgm' ? 0 : Math.min(profile.music_gain ?? settings.bgmVolume, settings.maxBgmVolume ?? 8),
    ...(ducking === undefined ? {} : { ducking }) }
}

/** Capture the profile's effective parameters without claiming a speech-only source.
 * @param profile - Validated project profile.
 * @param original - Retained original sound.
 * @param music - Added music; empty in no_bgm mode.
 * @param stem - Music-only output, if produced.
 * @returns Model-visible mix evidence.
 */
export function audioMixReport(
  profile: ResolvedAudioMixProfile, original: string, music: string, stem: string,
): AudioMixReport {
  const { path, ...parameters } = profile
  return { schema_version: 1, profile_path: path, mode: profile.mode, parameters,
    detector: profile.mode === 'ducking' ? 'source_audio_rms_not_speech_vad' : 'none',
    original_audio: original, music_audio: music, music_stem: stem, composition_gain_status: 'not_provided' }
}

/** Require a composer receipt to describe the exact music bytes used by the audition. */
async function compositionReceipt(project: string, candidate: string, music: string): Promise<NonNullable<AudioMixReport['composition']>> {
  const file = await requireProjectAudioFile(project, candidate)
  if ((await stat(file)).size > 2_097_152) throw new Error('配乐合成收据不能超过 2 MiB。')
  const schema = z.object({ media: z.object({ sha256: z.string().required() }).required(),
    segments: z.array(z.object({ track: z.string().required(), source: z.string().required(),
      start_seconds: z.number().required(), end_seconds: z.number().required(),
      source_mean_db: z.number().required(), applied_gain_db: z.number().required() })).required() })
  const document: unknown = JSON.parse((await readFile(file, 'utf8')).replace(/^\ufeff/u, ''))
  const receipt = schema(document as Parameters<typeof schema>[0])
  const digest = await fileSha256(music)
  if (receipt.media.sha256.toLowerCase() !== digest) throw new Error('配乐合成收据的 SHA-256 与本次 BGM 不同。')
  // Schemastery retains unknown receipt fields. Project only this report's closed
  // schema; rights and story metadata stay in the independently parsed bgm_plan.
  return { path: file, bed_sha256: digest, segments: receipt.segments.map(segment => ({
    track: segment.track, source: segment.source,
    start_seconds: segment.start_seconds, end_seconds: segment.end_seconds,
    source_mean_db: segment.source_mean_db, applied_gain_db: segment.applied_gain_db,
  })) }
}

/** Parse one astats metadata stream; negative infinity is digital silence, not a missing measure.
 * @param text - FFmpeg ametadata output.
 * @returns Ordered, measured RMS and sample-peak frames.
 */
export function parseAudioWindows(text: string): AudioWindow[] {
  const rows: AudioWindow[] = []
  let time: number | undefined
  let rms: number | null | undefined
  let peak: number | null | undefined
  const flush = (): void => {
    if (time === undefined) return
    if (rms === undefined || peak === undefined) throw new Error('短时音频测量缺少 RMS 或峰值。')
    rows.push({ time_seconds: time, rms_dbfs: rms, peak_dbfs: peak, silent: rms === null && peak === null })
  }
  for (const line of text.split(/\r?\n/u)) {
    const frame = /^frame:\d+\s+pts:\S+\s+pts_time:([0-9.e+-]+)/u.exec(line)
    if (frame !== null) { flush(); time = Number(frame[1]); rms = undefined; peak = undefined; continue }
    const value = /^lavfi\.astats\.Overall\.(RMS_level|Peak_level)=(-?inf|-?[0-9.e+-]+)/iu.exec(line)
    if (value === null) continue
    const parsed = value[2]?.toLowerCase() === '-inf' ? null : Number(value[2])
    if (parsed !== null && !Number.isFinite(parsed)) throw new Error('短时音频测量不是有效数值。')
    if (value[1] === 'RMS_level') rms = parsed
    else peak = parsed
  }
  flush()
  if (rows.length === 0) throw new Error('FFmpeg 没有返回短时音频测量。')
  return rows
}

/** Measure fixed 48 kHz frames, independently of the input codec frame size.
 * @param toolkit - Existing renderer media channel.
 * @param file - Audio to measure.
 * @param windowMs - Explicit frame duration between 10 and 1000 milliseconds.
 * @returns Per-frame RMS and sample peaks; no listening verdict.
 */
export async function measureAudioWindows(toolkit: MediaToolkit, file: string, windowMs: number): Promise<AudioWindow[]> {
  const samples = Math.round(48 * windowMs)
  const args = ['-hide_banner', '-nostats', '-v', 'error', '-i', file, '-af',
    `aresample=48000,asetnsamples=n=${String(samples)}:p=0,astats=metadata=1:reset=1,ametadata=mode=print:file=-`,
    '-f', 'null', '-']
  const outcome = await captureFfmpeg(toolkit, args)
  if (outcome.code !== 0) throw new MediaCommandError(toolkit.ffmpeg, args, outcome.code, outcome.stderr)
  return parseAudioWindows(outcome.stdout)
}

/** Measure EBU R128 momentary (400 ms) and short-term (3 s) perceived loudness.
 * @param toolkit - Existing renderer media channel.
 * @param file - Audition audio to measure from its own zero.
 * @returns 100 ms observations with explicit window-warmup flags and LUFS values.
 */
export async function measureAudioLoudness(toolkit: MediaToolkit, file: string): Promise<{
  time_seconds: number
  momentary_lufs: number | null
  short_term_lufs: number | null
  momentary_full_window: boolean
  short_term_full_window: boolean
}[]> {
  const args = ['-hide_banner', '-nostats', '-v', 'error', '-i', file,
    '-af', 'ebur128=metadata=1,ametadata=mode=print:file=-', '-f', 'null', '-']
  const outcome = await captureFfmpeg(toolkit, args)
  if (outcome.code !== 0) throw new MediaCommandError(toolkit.ffmpeg, args, outcome.code, outcome.stderr)
  const chunks = outcome.stdout.split(/(?=frame:\d+\s+pts:)/u)
  const rows = []
  for (const chunk of chunks) {
    const time = /pts_time:([0-9.e+-]+)/u.exec(chunk)
    const m = /lavfi\.r128\.M=(-?[0-9.e+-]+)/u.exec(chunk)
    const s = /lavfi\.r128\.S=(-?[0-9.e+-]+)/u.exec(chunk)
    if (time === null || m === null || s === null) continue
    const seconds = Number(time[1])
    const momentary = seconds + 0.100001 >= 0.4
    const shortTerm = seconds + 0.100001 >= 3
    rows.push({ time_seconds: seconds, momentary_lufs: momentary ? Number(m[1]) : null,
      short_term_lufs: shortTerm ? Number(s[1]) : null,
      momentary_full_window: momentary, short_term_full_window: shortTerm })
  }
  if (rows.length === 0) throw new Error('FFmpeg 没有返回 EBU R128 短时响度。')
  return rows
}

/** Inputs for a bounded project-owned audio audition. */
export interface AudioPreviewInput {
  /** Existing renderer media channel. */
  readonly toolkit: MediaToolkit
  /** Resolved deployment settings. */
  readonly settings: RenderSettings
  /** Project root. */
  readonly project: string
  /** Two-digit episode. */
  readonly episode: string
  /** Project-owned timeline. */
  readonly timelinePath: string
  /** Project-owned original sound. */
  readonly audio: string
  /** Explicit profile file. */
  readonly profilePath: string
  /** Added music, unused and unopened in no_bgm mode. */
  readonly bgm?: string
  /** Existing plan metadata, ignored when no music is added. */
  readonly bgmPlan?: string
  /** Optional composer receipt whose media hash must match the BGM. */
  readonly bgmGeneration?: string
  /** Optional explicit use for advisory license-risk reporting. */
  readonly intendedUse?: 'commercial' | 'non_commercial' | 'unknown'
  /** Body timeline offset. */
  readonly startSeconds: number
  /** Audition length, at most 60 seconds. */
  readonly durationSeconds: number
}

/** A bounded audition's files and timeline, without a subjective acceptance claim. */
export interface AudioPreviewResult {
  /** Shared body timeline. */
  readonly timeline: Timeline
  /** Structured audio-profile evidence and paths. */
  readonly mix: AudioMixReport
  /** Track names, intervals and declared license metadata, never listening approval. */
  readonly bgmPlan: BgmPlanReport
  /** Newly created files. */
  readonly written: string[]
  /** Selected mix WAV. */
  readonly output: string
}

/** Render aligned selected/no-added-music auditions using the final renderer's audio graph.
 * @param input - Explicit profile and bounded body interval.
 * @returns New WAV and short-window measurement paths; never replaces a prior preview.
 */
export async function previewAudio(input: AudioPreviewInput): Promise<AudioPreviewResult> {
  if (!Number.isFinite(input.startSeconds) || input.startSeconds < 0
    || !Number.isFinite(input.durationSeconds) || input.durationSeconds <= 0 || input.durationSeconds > 60) {
    throw new Error('audio_preview 的 start_seconds 必须非负，duration_seconds 必须大于 0 且不超过 60。')
  }
  const startSample = Math.round(input.startSeconds * 48_000)
  const sampleCount = Math.round(input.durationSeconds * 48_000)
  if (!Number.isSafeInteger(startSample) || sampleCount < 1) throw new Error('音频试听窗口至少需要一个 48 kHz 样本，起点不能超出安全整数范围。')
  const timelineFile = await requireProjectAudioFile(input.project, input.timelinePath)
  const timeline = await readTimeline(timelineFile, input.settings.enforceSubtitleVisual)
  if (input.startSeconds + input.durationSeconds > timeline.bodyEndSeconds + 0.000001) {
    throw new Error('音频试听窗口不能超过正文时间线。')
  }
  const policy = await resolveDeliveryPolicy(
    input.project, timeline.delivery, input.settings.defaultSubtitleVisual, input.settings.enforceSubtitleVisual,
  )
  const profile = await loadAudioMixProfile(input.project, input.profilePath,
    deliveryRenderSettings(input.settings, policy.delivery))
  const original = await requireProjectAudioFile(input.project, input.audio)
  let music = ''
  if (profile.mode !== 'no_bgm') {
    if (input.bgm === undefined) throw new Error('当前音频配置需要 bgm；无新增配乐请显式使用 no_bgm。')
    music = await requireProjectAudioFile(input.project, input.bgm)
  }
  const planFile = music && input.bgmPlan !== undefined
    ? await requireProjectAudioFile(input.project, input.bgmPlan) : undefined
  const declaredPlan = await readBgmPlan(planFile, input.episode, timeline.bodyEndSeconds, music, input.project)
  const use = music ? input.intendedUse ?? declaredPlan.intended_use : declaredPlan.intended_use
  const bgmPlan = { ...declaredPlan, intended_use: use,
    license_records: declaredPlan.license_records.map(record => ({ ...record,
      warnings: licenseRiskWarnings(record.license_info, use) })) }
  const composition = music && input.bgmGeneration !== undefined
    ? await compositionReceipt(input.project, input.bgmGeneration, music) : undefined
  const parent = resolve(input.project, 'audio', 'previews')
  await requireNewAudioOutput(input.project, join(parent, '.preview-allocation'))
  await mkdir(parent, { recursive: true })
  const directory = await mkdtemp(join(parent, `ep${input.episode}-`))
  const selected = join(directory, 'selected_mix.wav')
  const baseline = join(directory, 'without_added_music.wav')
  const stem = music ? join(directory, 'music_stem.wav') : ''
  const analysis = join(directory, 'analysis.json')
  try {
    const spec = { bodyEndSeconds: timeline.bodyEndSeconds, totalSeconds: timeline.bodyEndSeconds,
      endingSeconds: 0, masterVolume: profile.original_gain, bgmVolume: profile.music_gain,
      originalInput: 0 }
    // Stream-copy AAC joins can contain near-duplicate PTS. Cut after the shared
    // full-history graph on the delivered PCM clock, not those source timestamps.
    const trim = 'aresample=48000,asetpts=N/SR/TB,'
      + `atrim=start_sample=${String(startSample)}:end_sample=${String(startSample + sampleCount)},asetpts=N/SR/TB`
    const outputArgs = ['-c:a', 'pcm_s16le', '-ar', '48000', '-ac', '2']
    await runFfmpeg(input.toolkit, ['-n', '-v', 'error', '-i', original,
      ...(music ? ['-stream_loop', '-1', '-i', music] : []),
      '-filter_complex', audioMixFilter({ ...spec, profile, musicStem: Boolean(music) })
        + `;[a]${trim}[preview]` + (stem ? `;[musicstem]${trim}[previewstem]` : ''),
      '-map', '[preview]', ...outputArgs, selected,
      ...(stem ? ['-map', '[previewstem]', ...outputArgs, stem] : [])])
    await runFfmpeg(input.toolkit, ['-n', '-v', 'error', '-i', original,
      '-filter_complex', audioMixFilter({ ...spec, profile: { ...profile, mode: 'no_bgm', music_gain: 0 } })
        + `;[a]${trim}[preview]`,
      '-map', '[preview]', ...outputArgs, baseline])
    const measurements: Record<string, AudioWindow[]> = {}
    const loudness: Record<string, Awaited<ReturnType<typeof measureAudioLoudness>>> = {}
    const measuredFiles: [string, string][] = [['selected_mix', selected], ['without_added_music', baseline]]
    if (stem) measuredFiles.push(['music_stem', stem])
    for (const [name, file] of measuredFiles) {
      measurements[name] = await measureAudioWindows(input.toolkit, file, profile.analysis_window_ms)
      loudness[name] = await measureAudioLoudness(input.toolkit, file)
    }
    await writeFile(analysis, `${JSON.stringify({ schema_version: 1, start_seconds: input.startSeconds,
      duration_seconds: input.durationSeconds, window_ms: profile.analysis_window_ms,
      measurement: 'frame_rms_and_sample_peak_dbfs',
      detector: profile.mode === 'ducking' ? 'source_audio_rms_not_speech_vad' : 'none',
      sidechain_history: 'processed_from_body_zero_before_preview_trim',
      trim_clock: '48khz_samples_after_shared_mix', output_sample_rate: 48_000, output_sample_count: sampleCount,
      loudness_windows_ms: { momentary: 400, short_term: 3000, observation_interval: 100 },
      loudness_timeline: 'preview_relative_with_explicit_warmup_flags',
      listening_review: 'not_performed', measurements, loudness }, null, 2)}\n`, { flag: 'wx' })
    const mix = { ...audioMixReport(profile, original, music, stem), preview: {
      start_seconds: input.startSeconds, duration_seconds: input.durationSeconds,
      selected_mix: selected, without_added_music: baseline, music_stem: stem, analysis },
    ...(composition === undefined ? {} : { composition_gain_status: 'provided' as const, composition }) }
    return { timeline, mix, bgmPlan, output: selected, written: [selected, baseline, ...(stem ? [stem] : []), analysis] }
  } catch (error) {
    await rm(directory, { recursive: true, force: true })
    throw error
  }
}
