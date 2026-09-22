/**
 * `verify`: the post-render check, and the delivery verdict `render` shares.
 *
 * The delivered file is judged on what it actually is — its duration, its
 * streams, its overall bitrate, its black stretches, its silent stretches, and
 * whether any subtitle cue would be burned outside the picture. `verify` reports
 * every check instead of stopping at the first failure, so one call is one
 * complete repair list; nothing here writes to the delivered file.
 *
 * @module @deepseek-ai/dsh-tool-episode-render/verify
 */

import { resolve } from 'node:path'
import { fileSha256 } from './cache.ts'
import { episodePaths, pathExists, shotFileName } from './paths.ts'
import { readVideoBans } from './video.ts'
import { DELIVERY_FPS, DELIVERY_HEIGHT, DELIVERY_WIDTH, ENDING_SECONDS, MIN_BITRATE_BPS } from './delivery.ts'
import { firstStreamOfType, frameRateOf, probeMedia } from './ffmpeg.ts'
import { buildReport, NO_TAIL_FRAME, type ReportInput } from './report.ts'
import { readSubtitleCues } from './subtitles.ts'
import { readTimeline } from './timeline.ts'
import type {
  DramaRenderReport,
  MediaFacts,
  MediaToolkit,
  RenderCheck,
  RenderSettings,
  SubtitleCue,
} from './types.ts'

/** Seconds a delivered duration may differ from the timeline's own sum. */
const DURATION_TOLERANCE_SECONDS = 0.15

/** Seconds a subtitle cue may cross a boundary before it counts as out of bounds. */
const CUE_TOLERANCE_SECONDS = 0.05

/** `blackdetect` reports a stretch once it lasts this long. */
const BLACK_DETECT_SECONDS = 0.1

/** `blackdetect`'s per-pixel luminance ceiling. */
const BLACK_PIXEL_THRESHOLD = 0.1

/** A black stretch at least this long means the delivery has a hole in it. */
const BLACK_FAILURE_SECONDS = 1

/** A black stretch at least this long is worth reading, but does not block. */
const BLACK_WARNING_SECONDS = 0.3

/** Level below which `silencedetect` counts as silence. */
const SILENCE_NOISE = '-50dB'

/** `silencedetect` reports a stretch once it lasts this long. */
const SILENCE_DETECT_SECONDS = 1

/** A silent stretch at least this long means the delivery lost its sound. */
const SILENCE_FAILURE_SECONDS = 3

/** A silent stretch at least this long is worth reading, but does not block. */
const SILENCE_WARNING_SECONDS = 1

/** One detected stretch of black frames or of silence. */
export interface DetectedSegment {
  /** Seconds from the file start to the stretch's first frame. */
  readonly startSeconds: number
  /** Seconds the stretch lasts. */
  readonly durationSeconds: number
}

/** Build one check, leaving the repair instruction empty exactly when it passed. */
function verdict(
  id: string,
  severity: 'failure' | 'warning',
  ok: boolean,
  detail: string,
  fix: string,
): RenderCheck {
  return { id, severity, ok, detail, fix: ok ? '' : fix }
}

/** Join the numeric fields of a detected segment list into one detail line. */
function describeSegments(segments: readonly DetectedSegment[]): string {
  if (segments.length === 0) return '未检出'
  return segments
    .map(segment => `${segment.startSeconds.toFixed(3)}s 起持续 ${segment.durationSeconds.toFixed(3)}s`)
    .join('；')
}

/** The longest stretch in a detected list. */
function longestSeconds(segments: readonly DetectedSegment[]): number {
  return segments.reduce((longest, segment) => Math.max(longest, segment.durationSeconds), 0)
}

/**
 * Judge the delivered file against the fixed delivery specification.
 * @param media - The measured facts.
 * @param expectedDurationSeconds - The duration the timeline and the ending require.
 * @returns Duration, geometry, frame rate, audio, and bitrate checks.
 */
export function deliveryChecks(media: MediaFacts, expectedDurationSeconds: number): RenderCheck[] {
  const durationDelta = Math.abs(media.durationSeconds - expectedDurationSeconds)
  const geometryOk = media.width === DELIVERY_WIDTH && media.height === DELIVERY_HEIGHT && media.videoCodec === 'h264'
  const fpsOk = Math.abs(media.fps - DELIVERY_FPS) <= 0.01
  const audioOk = media.hasAudio && media.audioCodec === 'aac' && media.audioSampleRate === 48000
  return [
    verdict('duration', 'failure', durationDelta <= DURATION_TOLERANCE_SECONDS,
      `实测 ${media.durationSeconds.toFixed(6)}s，应为 ${expectedDurationSeconds.toFixed(6)}s，差 ${durationDelta.toFixed(6)}s`,
      '请检查时间线的 body_end 与片尾长度是否与实际画面一致；'
      + `若差在 ${String(DURATION_TOLERANCE_SECONDS)}s 以内请先确认没有丢帧，否则重跑 render（加 force=true 清缓存）。`),
    verdict('video_stream', 'failure', geometryOk,
      `实测 ${String(media.width)}x${String(media.height)} ${media.videoCodec}`,
      `交付规格是 ${String(DELIVERY_WIDTH)}x${String(DELIVERY_HEIGHT)} 的 h264。`
      + '请确认片段都是按交付样式编码后拼接的，并删掉 exports/.render_cache 后重跑 render。'),
    verdict('frame_rate', 'failure', fpsOk,
      `实测 ${media.fps.toFixed(4)}fps，应为 ${String(DELIVERY_FPS)}fps`,
      '请确认拼接的每一段都用 fps=60 编码；删掉 exports/.render_cache 后重跑 render。'),
    verdict('audio_stream', 'failure', audioOk,
      `实测 音轨=${media.hasAudio ? `${media.audioCodec} ${String(media.audioSampleRate)}Hz` : '缺失'}`,
      '交付规格要求 AAC 48kHz 音轨。请确认 audio/<集>.wav 存在且混音步骤成功，然后重跑 render。'),
    verdict('bitrate_floor', 'failure', media.bitrateBps >= MIN_BITRATE_BPS,
      `实测 ${(media.bitrateBps / 1_000_000).toFixed(3)} Mbps，下限 ${(MIN_BITRATE_BPS / 1_000_000).toFixed(1)} Mbps`,
      `总码率低于 ${(MIN_BITRATE_BPS / 1_000_000).toFixed(1)} Mbps 说明素材或编码参数被降档。`
      + '请确认源片段本身不是低码率转码件，并重跑 render（必要时加 force=true 重编所有片段）。'),
  ]
}

/**
 * Read the black stretches out of a `blackdetect` log.
 *
 * A stretch that is still black when the file ends is logged without an end
 * timestamp, so it is closed at the file's own duration.
 * @param stderr - Everything ffmpeg wrote to standard error.
 * @param totalSeconds - The probed file duration, used to close an open stretch.
 * @returns Every detected stretch, in log order.
 */
export function parseBlackSegments(stderr: string, totalSeconds: number): DetectedSegment[] {
  const segments: DetectedSegment[] = []
  let pendingStart: number | undefined
  const pattern = /black_start:\s*([\d.]+)(?:\s+black_end:\s*([\d.]+))?(?:\s+black_duration:\s*([\d.]+))?/g
  for (const match of stderr.matchAll(pattern)) {
    const start = Number(match[1])
    const duration = match[3]
    if (duration === undefined) {
      pendingStart = start
      continue
    }
    segments.push({ startSeconds: start, durationSeconds: Number(duration) })
    pendingStart = undefined
  }
  if (pendingStart !== undefined) {
    segments.push({ startSeconds: pendingStart, durationSeconds: Math.max(0, totalSeconds - pendingStart) })
  }
  return segments
}

/**
 * Read the silent stretches out of a `silencedetect` log.
 *
 * `silencedetect` writes the start and the end on separate lines and omits the
 * end when the file stops while still silent, so an unclosed start is taken to
 * the file's own duration.
 * @param stderr - Everything ffmpeg wrote to standard error.
 * @param totalSeconds - The probed file duration, used to close an open stretch.
 * @returns Every detected stretch, in log order.
 */
export function parseSilenceSegments(stderr: string, totalSeconds: number): DetectedSegment[] {
  const segments: DetectedSegment[] = []
  let pendingStart: number | undefined
  for (const line of stderr.split(/\r?\n/)) {
    const start = /silence_start:\s*(-?[\d.]+)/.exec(line)
    if (start !== null) {
      pendingStart = Number(start[1])
      continue
    }
    const duration = /silence_duration:\s*([\d.]+)/.exec(line)
    if (duration !== null && pendingStart !== undefined) {
      segments.push({ startSeconds: pendingStart, durationSeconds: Number(duration[1]) })
      pendingStart = undefined
    }
  }
  if (pendingStart !== undefined) {
    segments.push({ startSeconds: pendingStart, durationSeconds: Math.max(0, totalSeconds - pendingStart) })
  }
  return segments
}

/**
 * Detect the delivered file's black stretches.
 * @param toolkit - The binaries and channel to use.
 * @param file - Absolute path of the delivered file.
 * @param totalSeconds - The probed file duration.
 * @returns Every detected stretch, in log order.
 * @throws {Error} When the detection pass itself fails.
 */
export async function detectBlackSegments(
  toolkit: MediaToolkit,
  file: string,
  totalSeconds: number,
): Promise<DetectedSegment[]> {
  const outcome = await toolkit.channel.run(toolkit.ffmpeg, [
    '-v', 'info', '-i', file,
    '-vf', `blackdetect=d=${String(BLACK_DETECT_SECONDS)}:pix_th=${String(BLACK_PIXEL_THRESHOLD)}`,
    '-an', '-f', 'null', '-',
  ])
  if (outcome.code !== 0) {
    throw new Error(`黑帧检测失败：${file}（${outcome.stderr.trim()}）。`
      + '请确认交付文件可完整解码后重跑 verify。')
  }
  return parseBlackSegments(outcome.stderr, totalSeconds)
}

/**
 * Detect the delivered file's silent stretches.
 * @param toolkit - The binaries and channel to use.
 * @param file - Absolute path of the delivered file.
 * @param totalSeconds - The probed file duration.
 * @returns Every detected stretch, in log order.
 * @throws {Error} When the detection pass itself fails.
 */
export async function detectSilenceSegments(
  toolkit: MediaToolkit,
  file: string,
  totalSeconds: number,
): Promise<DetectedSegment[]> {
  const outcome = await toolkit.channel.run(toolkit.ffmpeg, [
    '-v', 'info', '-i', file,
    '-af', `silencedetect=noise=${SILENCE_NOISE}:d=${String(SILENCE_DETECT_SECONDS)}`,
    '-vn', '-f', 'null', '-',
  ])
  if (outcome.code !== 0) {
    throw new Error(`静音检测失败：${file}（${outcome.stderr.trim()}）。`
      + '请确认交付文件可完整解码后重跑 verify。')
  }
  return parseSilenceSegments(outcome.stderr, totalSeconds)
}

/**
 * Judge whether every subtitle cue is burned inside the picture.
 * @param cues - The installed subtitles.
 * @param bodyEndSeconds - Where the body ends; the ending carries no dialogue.
 * @param measuredSeconds - The delivered file's measured duration.
 * @returns The bounds check, plus a warning when the subtitle carries no cue at all.
 */
export function subtitleChecks(
  cues: readonly SubtitleCue[],
  bodyEndSeconds: number,
  measuredSeconds: number,
): RenderCheck[] {
  const outside = cues.filter(cue => cue.startSeconds < 0
    || cue.endSeconds < cue.startSeconds
    || cue.endSeconds > bodyEndSeconds + CUE_TOLERANCE_SECONDS
    || cue.endSeconds > measuredSeconds + CUE_TOLERANCE_SECONDS)
  const detail = outside.length === 0
    ? `${String(cues.length)} 条字幕都在 0–${bodyEndSeconds.toFixed(3)}s 之内`
    : outside.map(cue => `第 ${String(cue.index)} 条 ${cue.startSeconds.toFixed(3)}–${cue.endSeconds.toFixed(3)}s`).join('；')
  return [
    verdict('subtitle_bounds', 'failure', outside.length === 0, detail,
      `字幕必须落在 0–${bodyEndSeconds.toFixed(3)}s（body_end）之内，片尾 2 秒不承载台词。`
      + '请修正这些 cue 的起止时间后重跑 render。'),
    verdict('subtitle_present', 'warning', cues.length > 0,
      `实测 ${String(cues.length)} 条字幕`,
      '字幕文件里没有任何 cue。若这集确实没有台词请忽略；否则请检查 SRT 的时间行与空行格式。'),
  ]
}

/** Report exact output bans and current selected-source risks, without certifying historical output sources. */
async function videoBanChecks(input: VerifyInput, shots: readonly number[]): Promise<RenderCheck[]> {
  try {
    const bans = (await readVideoBans(input.project)).filter(row => row.banned)
    if (bans.length === 0) return []
    const paths = episodePaths(input.project, input.episode)
    const files = [input.output, ...shots.map(shot => resolve(paths.videoDir, shotFileName(shot)))]
    const affected: string[] = []
    for (const file of files) {
      if (!await pathExists(file)) continue
      const hash = await fileSha256(file)
      const ban = bans.find(row => row.sha256 === hash)
      if (ban !== undefined) affected.push(`${file === input.output ? '输出版本已禁用' : '当前选片含禁用素材，已有输出需复核'}：`
        + `${file} [${hash}] labels=${ban.labels.join('、')} reason=${ban.reason}`)
    }
    return [verdict('video_bans', 'failure', affected.length === 0,
      affected.length > 0 ? affected.join('；') : '当前可读输出与选片未命中禁用 SHA256；未确认历史输出的原源映射。',
      '请更换禁用版本后重新准备和渲染，或经用户同意解除禁用；解除禁用不代表审核通过。已有文件未删除。')]
  } catch (error) {
    return [verdict('video_bans', 'failure', false, String(error), '请修复禁用清单或文件读取问题后重新检查；已有文件未删除。')]
  }
}

/** Everything one `verify` call needs. */
export interface VerifyInput {
  /** The binaries and channel to use, or a stub in tests. */
  readonly toolkit: MediaToolkit
  /** The deployment-varying choices this verify resolves. */
  readonly settings: RenderSettings
  /** Absolute project root. */
  readonly project: string
  /** Two-digit episode number. */
  readonly episode: string
  /** Absolute path of the delivered file to check. */
  readonly output: string
  /** Absolute path of the timeline the delivery claims to follow. */
  readonly timelinePath: string
  /** Absolute path of the subtitle the delivery claims to burn. */
  readonly subtitleSrt: string
}

/**
 * Check one delivered file against its timeline and its subtitle.
 * @param input - The resolved call.
 * @returns The canonical result; every failed check carries its own Chinese repair instruction.
 * @throws {Error} When the delivered file cannot be probed or a detection pass fails.
 */
export async function verifyEpisode(input: VerifyInput): Promise<DramaRenderReport> {
  const timeline = await readTimeline(input.timelinePath)
  const expectedDurationSeconds = Number((timeline.bodyEndSeconds + ENDING_SECONDS).toFixed(6))
  const probed = await probeMedia(input.toolkit, input.output)
  const video = firstStreamOfType(probed, 'video')
  const audio = firstStreamOfType(probed, 'audio')
  const media: MediaFacts = {
    durationSeconds: probed.durationSeconds,
    sizeBytes: probed.sizeBytes,
    bitrateBps: probed.bitRateBps,
    videoCodec: video?.codecName ?? '',
    width: video?.width ?? 0,
    height: video?.height ?? 0,
    fps: frameRateOf(video),
    hasAudio: audio !== undefined,
    audioCodec: audio?.codecName ?? '',
    audioSampleRate: audio?.sampleRate ?? 0,
  }
  const black = await detectBlackSegments(input.toolkit, input.output, media.durationSeconds)
  const silence = await detectSilenceSegments(input.toolkit, input.output, media.durationSeconds)
  const cues = await readSubtitleCues(input.subtitleSrt)
  const checks: RenderCheck[] = [
    ...deliveryChecks(media, expectedDurationSeconds),
    ...await videoBanChecks(input, timeline.clips.map(clip => clip.shot)),
    verdict('black_frames', 'failure', longestSeconds(black) < BLACK_FAILURE_SECONDS,
      describeSegments(black),
      `检出持续 ${String(BLACK_FAILURE_SECONDS)} 秒以上的黑场。`
      + '请检查对应时间点的源镜头是否本身是黑场或丢帧，修好素材后重跑 render。'),
    verdict('fade_to_black', 'warning', longestSeconds(black) < BLACK_WARNING_SECONDS,
      describeSegments(black),
      `检出持续 ${String(BLACK_WARNING_SECONDS)} 秒以上的黑场，未达失败线但值得确认画面对不对。`),
    verdict('silence', 'failure', longestSeconds(silence) < SILENCE_FAILURE_SECONDS,
      describeSegments(silence),
      `检出持续 ${String(SILENCE_FAILURE_SECONDS)} 秒以上的静音。`
      + '请检查整集原声是否缺段（audio/<集>.wav 是否由 prepare 完整拼出），修好后重跑 render。'),
    verdict('long_pauses', 'warning', longestSeconds(silence) < SILENCE_WARNING_SECONDS,
      describeSegments(silence),
      `检出持续 ${String(SILENCE_WARNING_SECONDS)} 秒以上的静音，未达失败线但值得确认是否符合这集的节奏。`),
    ...subtitleChecks(cues, timeline.bodyEndSeconds, media.durationSeconds),
  ]
  const sources = new Map<number, string>()
  const reportInput: ReportInput = {
    method: 'verify',
    project: input.project,
    episode: input.episode,
    timeline,
    sources,
    expectedDurationSeconds,
    written: [],
    output: input.output,
    encoder: '',
    gpuRequested: false,
    gpuUsed: false,
    encoderFallbackReason: '',
    encodedShots: [],
    reusedShots: [],
    tailFrame: NO_TAIL_FRAME,
    media,
    checks,
    warnings: [],
    logPath: '',
  }
  return buildReport(reportInput)
}
