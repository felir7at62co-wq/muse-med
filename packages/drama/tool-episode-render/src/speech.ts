/**
 * Subtitle timing measured from each shot's own audio.
 *
 * The lines are already known — the shot script declares them — so nothing here
 * recognizes speech. FFmpeg's `silencedetect` reports the silent stretches of a
 * clip; this module inverts them into the moments that clip is actually
 * speaking, and places the declared lines inside those moments.
 *
 * A line placed on its own detected stretch is measured (`audio_silence`). When
 * one stretch has to carry several lines, the split inside it is a character
 * count (`estimated_within_run`), and the caller reports those counts instead of
 * letting them pass as measurement. A shot that declares lines while its audio
 * has no detected speech is a defect, not an empty placement: nobody says that
 * line, so the delivery would carry a subtitle for silence.
 *
 * @module @deepseek-ai/dsh-tool-episode-render/speech
 */

import type { MediaToolkit } from './types.ts'
import { parseSilenceSegments } from './verify.ts'
import type { DetectedSegment } from './verify.ts'

/** Level below which the cue pass counts a clip as silent. */
export const CUE_SILENCE_NOISE = '-35dB'

/** Seconds a gap must last before the cue pass calls it a break between lines. */
export const CUE_SILENCE_MIN_SECONDS = 0.15

/** Seconds a stretch must last to count as speech rather than a click. */
export const CUE_MIN_REGION_SECONDS = 0.1

/** One stretch of a clip in which speech is present, in seconds from the clip's start. */
export interface SpeechRegion {
  /** Region start, seconds from the clip start. */
  readonly startSeconds: number
  /** Region end, seconds from the clip start. */
  readonly endSeconds: number
}

/** One shot's declared subtitle lines, in the order they are spoken. */
export interface LinePlanShot {
  /** Shot number. */
  readonly shot: number
  /** One already-split line per cue; the caller owns the split. */
  readonly lines: readonly string[]
}

/** How one cue's times were obtained. */
export type CueTimingSource =
  /** Measured: the line occupies a stretch FFmpeg found to be speaking. */
  | 'audio_silence'
  /** Estimated: the line shares a speaking stretch with its neighbours. */
  | 'estimated_within_run'

/** One cue placed on the episode clock. */
export interface PlacedCue {
  /** Shot this line belongs to. */
  readonly shot: number
  /** The line's text, exactly as declared. */
  readonly text: string
  /** Cue start on the episode clock. */
  readonly startSeconds: number
  /** Cue end on the episode clock. */
  readonly endSeconds: number
  /** Whether the times were measured or estimated. */
  readonly timingSource: CueTimingSource
}

/** What placing one shot's lines produced. */
export interface ShotPlacement {
  /** Shot number. */
  readonly shot: number
  /** The placed cues, in line order. */
  readonly cues: readonly PlacedCue[]
  /** Speaking stretches detected in this shot's audio. */
  readonly regions: number
  /** Cues whose times were estimated rather than measured. */
  readonly estimated: number
  /** The blocking defect for this shot, or an empty string. */
  readonly defect: string
  /** Non-blocking observations about this shot. */
  readonly warnings: readonly string[]
}

/**
 * Count the characters that are actually spoken: CJK, Latin letters, and digits.
 * @param text - The line to weigh, punctuation and spaces excluded.
 * @returns The number of counted characters.
 */
export function effectiveCharacterCount(text: string): number {
  return (text.match(/[\u4e00-\u9fffA-Za-z0-9]/g) ?? []).length
}

/**
 * Invert detected silence into the stretches that are speaking.
 * @param silence - The silent stretches FFmpeg reported, in log order.
 * @param totalSeconds - The clip's probed duration.
 * @returns Every speaking stretch in time order, with stretches shorter than {@link CUE_MIN_REGION_SECONDS} dropped.
 */
export function invertSilence(
  silence: readonly DetectedSegment[],
  totalSeconds: number,
): SpeechRegion[] {
  const regions: SpeechRegion[] = []
  let cursor = 0
  const ordered = [...silence].sort((left, right) => left.startSeconds - right.startSeconds)
  for (const gap of ordered) {
    const end = Math.min(Math.max(gap.startSeconds, cursor), totalSeconds)
    if (end - cursor >= CUE_MIN_REGION_SECONDS) regions.push({ startSeconds: cursor, endSeconds: end })
    cursor = Math.max(cursor, Math.min(gap.startSeconds + gap.durationSeconds, totalSeconds))
  }
  if (totalSeconds - cursor >= CUE_MIN_REGION_SECONDS) {
    regions.push({ startSeconds: cursor, endSeconds: totalSeconds })
  }
  return regions
}

/**
 * Detect one clip's speaking stretches.
 *
 * The clip is analysed on its own, before any music bed is mixed under it, so
 * the threshold sees speech rather than a mix.
 * @param toolkit - The binaries and channel to use.
 * @param file - Absolute path of the clip whose audio carries this shot's dialogue.
 * @param totalSeconds - The clip's probed duration.
 * @returns Every speaking stretch, in time order.
 * @throws {Error} When the detection pass itself fails.
 */
export async function detectSpeechRegions(
  toolkit: MediaToolkit,
  file: string,
  totalSeconds: number,
): Promise<SpeechRegion[]> {
  const outcome = await toolkit.channel.run(toolkit.ffmpeg, [
    '-v', 'info', '-i', file,
    '-af', `silencedetect=noise=${CUE_SILENCE_NOISE}:d=${String(CUE_SILENCE_MIN_SECONDS)}`,
    '-vn', '-f', 'null', '-',
  ])
  if (outcome.code !== 0) {
    throw new Error(`发声检测失败：${file}（${outcome.stderr.trim()}）。`
      + '请确认该镜的成片可完整解码后重试。')
  }
  return invertSilence(parseSilenceSegments(outcome.stderr, totalSeconds), totalSeconds)
}

/**
 * Place one shot's declared lines on the episode clock.
 * @param shot - Shot number.
 * @param lines - The shot's lines, already split to cue length, in spoken order.
 * @param regions - Speaking stretches detected in this shot's audio.
 * @param clipStartSeconds - Where this shot starts on the episode clock.
 * @param clipDurationSeconds - This shot's probed duration.
 * @returns The placed cues plus this shot's defect and warnings.
 */
export function placeShotCues(
  shot: number,
  lines: readonly string[],
  regions: readonly SpeechRegion[],
  clipStartSeconds: number,
  clipDurationSeconds: number,
): ShotPlacement {
  const spoken = lines.map(line => line.trim()).filter(line => line !== '')
  if (spoken.length === 0) {
    return { shot, cues: [], regions: regions.length, estimated: 0, defect: '', warnings: [] }
  }
  const clipEnd = clipStartSeconds + clipDurationSeconds
  const clamp = (value: number): number => Math.min(Math.max(value, clipStartSeconds), clipEnd)
  if (regions.length === 0) {
    return {
      shot,
      cues: [],
      regions: 0,
      estimated: 0,
      defect: `镜头 ${String(shot)} 声明了 ${String(spoken.length)} 条台词，但这镜的音频里没有检出发声。`
        + '这一镜很可能没有读出剧本台词，请先复核该镜成片，不要直接给它排字幕。',
      warnings: [],
    }
  }
  if (regions.length >= spoken.length) {
    const cues = spoken.map((text, index) => {
      const region = regions[index] as SpeechRegion
      return {
        shot,
        text,
        startSeconds: clamp(clipStartSeconds + region.startSeconds),
        endSeconds: clamp(clipStartSeconds + region.endSeconds),
        timingSource: 'audio_silence' as const,
      }
    })
    const warnings = regions.length > spoken.length
      ? [`镜头 ${String(shot)} 检出 ${String(regions.length)} 段发声但只声明 ${String(spoken.length)} 条台词：`
        + '多出的发声可能是叹词、气声或剧本漏写的台词，请复核该镜。']
      : []
    return { shot, cues, regions: regions.length, estimated: 0, defect: '', warnings }
  }
  const first = regions[0] as SpeechRegion
  const last = regions[regions.length - 1] as SpeechRegion
  const from = first.startSeconds
  const to = last.endSeconds
  const weights = spoken.map(effectiveCharacterCount)
  const totalWeight = weights.reduce((sum, weight) => sum + weight, 0)
  const cues: PlacedCue[] = []
  let consumed = 0
  let elapsed = from
  for (const [index, text] of spoken.entries()) {
    const weight = weights[index] ?? 0
    consumed += weight
    const next = index === spoken.length - 1
      ? to
      : from + (to - from) * (totalWeight === 0 ? (index + 1) / spoken.length : consumed / totalWeight)
    cues.push({
      shot,
      text,
      startSeconds: clamp(clipStartSeconds + elapsed),
      endSeconds: clamp(clipStartSeconds + next),
      timingSource: 'estimated_within_run',
    })
    elapsed = next
  }
  return {
    shot,
    cues,
    regions: regions.length,
    estimated: cues.length,
    defect: '',
    warnings: [`镜头 ${String(shot)} 只检出 ${String(regions.length)} 段发声却要装 ${String(spoken.length)} 条台词：`
      + '镜内切分按有效字数估算（timing_source=estimated_within_run），请试听后校正。'],
  }
}

/**
 * Read one episode's line plan.
 * @param document - The parsed JSON value.
 * @param path - The plan path, for diagnostics.
 * @returns One entry per shot, ordered by shot number.
 * @throws {Error} When the plan is not `{"shots":[{"shot":N,"lines":["..."]}]}` or repeats a shot number.
 */
export function parseLinePlan(document: unknown, path: string): LinePlanShot[] {
  if (typeof document !== 'object' || document === null
    || !Array.isArray((document as { shots?: unknown }).shots)) {
    throw new Error(`${path}: 台词计划必须是 {"shots":[{"shot":1,"lines":["第一句","第二句"]}]}。`
      + '请把每镜已切好的台词写进 shots 数组后重试。')
  }
  const rows = (document as { shots: readonly unknown[] }).shots.map((entry, index) => {
    if (typeof entry !== 'object' || entry === null) {
      throw new Error(`${path}：第 ${String(index + 1)} 行不是对象。`
        + '请提供 {"shot":N,"lines":["..."]} 形式的行。')
    }
    const row = entry as { shot?: unknown; lines?: unknown }
    if (!Number.isInteger(row.shot) || (row.shot as number) < 1) {
      throw new Error(`${path}：第 ${String(index + 1)} 行的 shot 必须是正整数镜头号。`)
    }
    if (!Array.isArray(row.lines) || row.lines.some(line => typeof line !== 'string')) {
      throw new Error(`${path}：镜头 ${String(row.shot)} 的 lines 必须是字符串数组，每项一条字幕。`)
    }
    return { shot: row.shot as number, lines: row.lines as readonly string[] }
  })
  const shots = rows.map(row => row.shot)
  if (new Set(shots).size !== shots.length) {
    throw new Error(`${path}：镜头号重复。请让每个镜头在计划里只出现一次。`)
  }
  return [...rows].sort((left, right) => left.shot - right.shot)
}
