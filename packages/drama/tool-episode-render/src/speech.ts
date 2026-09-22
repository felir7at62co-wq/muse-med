/**
 * Subtitle timing measured from each shot's own audio.
 *
 * The lines are already known — the shot script declares them — so nothing here
 * recognizes speech. Each shot's audio is analysed by {@link detectSpeechRegions},
 * which derives its level from that clip's own noise floor instead of a fixed
 * one, and the declared lines are placed inside the stretches it finds.
 *
 * A line placed on its own stretch is measured (`audio_vad`). When one stretch
 * has to carry several lines, the split inside it is a character count
 * (`estimated_within_run`), and the caller reports those counts instead of
 * letting them pass as measurement. A shot that declares lines while its audio
 * has no detected speech is a defect, not an empty placement: nobody says that
 * line, so the delivery would carry a subtitle for silence.
 *
 * When recognition has already been run over the same clips, an alignment
 * document can supply the times (`asr_aligned`). Its text is only matched
 * against the script's lines to prove the two describe the same take; the cue
 * text is always the script's, never the recognizer's.
 *
 * @module @deepseek-ai/dsh-tool-episode-render/speech
 */

import { detectSpeechRegions } from './vad.ts'
import type { SpeechDetection, SpeechRegion } from './vad.ts'

export { detectSpeechRegions }
export type { SpeechDetection, SpeechRegion }

/** Shortest cue written to the delivery. */
export const MIN_CUE_SECONDS = 0.8

/** Longest cue written to the delivery, however long the line's stretch runs. */
export const MAX_CUE_SECONDS = 9

/** Seconds per spoken character the estimator assumes when a stretch carries several lines. */
export const SECONDS_PER_CHARACTER = 1 / 6

/** Characters per second past which a cue cannot be read at all. */
export const IMPOSSIBLE_CHARACTER_RATE = 20

/** Characters per second past which a cue is worth re-reading. */
export const FAST_CHARACTER_RATE = 12

/** One shot's declared subtitle lines, in the order they are spoken. */
export interface LinePlanShot {
  /** Shot number. */
  readonly shot: number
  /** One already-split line per cue; the caller owns the split. */
  readonly lines: readonly string[]
}

/** One recognized stretch of one shot, as a recognizer timed it. */
export interface AlignedCue {
  /** The recognizer's own text for this stretch; matched against the script, never written. */
  readonly text: string
  /** Stretch start, seconds from the clip start. */
  readonly startSeconds: number
  /** Stretch end, seconds from the clip start. */
  readonly endSeconds: number
}

/** One shot's recognized stretches, in the order the recognizer reported them. */
export interface AlignedShot {
  /** Shot number. */
  readonly shot: number
  /** Recognized stretches, in time order. */
  readonly cues: readonly AlignedCue[]
}

/** How one cue's times were obtained. */
export type CueTimingSource =
  /** Measured: the line occupies its own stretch of detected speech. */
  | 'audio_vad'
  /** Measured: the line's times come from an alignment document. */
  | 'asr_aligned'
  /** Estimated: the line shares a stretch of detected speech with its neighbours. */
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
  /** Cues whose times came from an alignment document. */
  readonly aligned: number
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
 * The seconds one line needs to be read at a natural pace.
 * @param text - The line to weigh.
 * @returns Seconds between {@link MIN_CUE_SECONDS} and {@link MAX_CUE_SECONDS}.
 */
export function requiredSeconds(text: string): number {
  const spoken = effectiveCharacterCount(text)
  return Math.min(MAX_CUE_SECONDS, Math.max(MIN_CUE_SECONDS, spoken * SECONDS_PER_CHARACTER + 0.5))
}

/** Remove the whitespace a recognizer and a script disagree about. */
function withoutSpace(text: string): string {
  return text.replace(/\s+/gu, '')
}

/** The millisecond the SRT writer keeps, so a placed time carries no floating-point noise. */
function toMilliseconds(seconds: number): number {
  return Math.round(seconds * 1000) / 1000
}

/**
 * Split an ordered line list across ordered stretches by their duration.
 *
 * Longest-remainder apportionment, so every stretch receives at least the lines
 * its share of the audio pays for and no line is dropped.
 * @param lengths - Stretch durations, in order.
 * @param count - Lines to distribute.
 * @returns One line count per stretch, in order, summing to `count`.
 */
function apportion(lengths: readonly number[], count: number): number[] {
  const total = lengths.reduce((sum, length) => sum + length, 0)
  if (total <= 0) {
    const base = Math.floor(count / Math.max(1, lengths.length))
    return lengths.map((_, index) => (index < count % Math.max(1, lengths.length) ? base + 1 : base))
  }
  const exact = lengths.map(length => (length / total) * count)
  const counts = exact.map(value => Math.floor(value))
  let remaining = count - counts.reduce((sum, value) => sum + value, 0)
  const order = exact
    .map((value, index) => ({ index, fraction: value - Math.floor(value) }))
    .sort((left, right) => right.fraction - left.fraction || left.index - right.index)
  for (const entry of order) {
    if (remaining <= 0) break
    counts[entry.index] = (counts[entry.index] ?? 0) + 1
    remaining -= 1
  }
  return counts
}

/**
 * Place one shot's declared lines on the episode clock.
 * @param shot - Shot number.
 * @param lines - The shot's lines, already split to cue length, in spoken order.
 * @param detection - What this shot's audio measured.
 * @param clipStartSeconds - Where this shot starts on the episode clock.
 * @param clipDurationSeconds - This shot's probed duration.
 * @returns The placed cues plus this shot's defect and warnings.
 */
export function placeShotCues(
  shot: number,
  lines: readonly string[],
  detection: SpeechDetection,
  clipStartSeconds: number,
  clipDurationSeconds: number,
): ShotPlacement {
  const regions = detection.regions
  const spoken = lines.map(line => line.trim()).filter(line => line !== '')
  const empty: ShotPlacement = {
    shot, cues: [], regions: regions.length, aligned: 0, estimated: 0, defect: '', warnings: [],
  }
  if (spoken.length === 0) return empty
  const clipEnd = clipStartSeconds + clipDurationSeconds
  const clamp = (value: number): number => toMilliseconds(Math.min(Math.max(value, clipStartSeconds), clipEnd))
  if (regions.length === 0) {
    return {
      ...empty,
      defect: `镜头 ${String(shot)} 声明了 ${String(spoken.length)} 条台词，但这镜的音频里没有检出发声`
        + `（噪声底 ${detection.floorDb.toFixed(1)}dB，门限 ${detection.thresholdDb.toFixed(1)}dB）。`
        + '这一镜很可能没有读出剧本台词，请先复核该镜成片，不要直接给它排字幕。',
    }
  }
  if (regions.length >= spoken.length) {
    const cues = spoken.map((text, index) => {
      const region = regions[index] as SpeechRegion
      const start = region.startSeconds
      return {
        shot,
        text,
        startSeconds: clamp(clipStartSeconds + start),
        endSeconds: clamp(clipStartSeconds + Math.min(region.endSeconds, start + requiredSeconds(text))),
        timingSource: 'audio_vad' as const,
      }
    })
    const warnings = regions.length > spoken.length
      ? [`镜头 ${String(shot)} 检出 ${String(regions.length)} 段发声但只声明 ${String(spoken.length)} 条台词：`
        + '多出的发声可能是叹词、气声或剧本漏写的台词，请复核该镜。']
      : []
    return { shot, cues, regions: regions.length, aligned: 0, estimated: 0, defect: '', warnings }
  }
  const lengths = regions.map(region => region.endSeconds - region.startSeconds)
  const counts = apportion(lengths, spoken.length)
  const cues: PlacedCue[] = []
  let line = 0
  for (const [index, region] of regions.entries()) {
    const assigned = spoken.slice(line, line + (counts[index] ?? 0))
    line += assigned.length
    if (assigned.length === 0) continue
    const weights = assigned.map(effectiveCharacterCount)
    const totalWeight = weights.reduce((sum, weight) => sum + weight, 0)
    const span = region.endSeconds - region.startSeconds
    let consumed = 0
    let elapsed = region.startSeconds
    for (const [position, text] of assigned.entries()) {
      const weight = weights[position] ?? 0
      consumed += weight
      const next = position === assigned.length - 1
        ? region.endSeconds
        : region.startSeconds + (totalWeight === 0 ? (position + 1) / assigned.length : consumed / totalWeight) * span
      cues.push({
        shot,
        text,
        startSeconds: clamp(clipStartSeconds + elapsed),
        endSeconds: clamp(clipStartSeconds + next),
        timingSource: 'estimated_within_run',
      })
      elapsed = next
    }
  }
  return {
    shot,
    cues,
    regions: regions.length,
    aligned: 0,
    estimated: cues.length,
    defect: '',
    warnings: [`镜头 ${String(shot)} 只检出 ${String(regions.length)} 段发声却要装 ${String(spoken.length)} 条台词：`
      + '镜内切分按有效字数估算（timing_source=estimated_within_run），请试听后校正。'],
  }
}

/**
 * Place one shot's lines on times an external alignment already measured.
 *
 * The alignment proves where each line is spoken; it never supplies the words.
 * A cue whose text disagrees with the script means the document describes a
 * different take, which is a defect rather than a number to trust.
 * @param shot - Shot number.
 * @param lines - The shot's lines, in spoken order.
 * @param aligned - The recognized stretches for this shot, in time order.
 * @param clipStartSeconds - Where this shot starts on the episode clock.
 * @param clipDurationSeconds - This shot's probed duration.
 * @returns The placed cues, or the defect that makes the alignment unusable.
 */
export function placeAlignedCues(
  shot: number,
  lines: readonly string[],
  aligned: readonly AlignedCue[],
  clipStartSeconds: number,
  clipDurationSeconds: number,
): ShotPlacement {
  const spoken = lines.map(line => line.trim()).filter(line => line !== '')
  const empty: ShotPlacement = {
    shot, cues: [], regions: 0, aligned: 0, estimated: 0, defect: '', warnings: [],
  }
  if (spoken.length === 0) return empty
  if (aligned.length !== spoken.length) {
    return {
      ...empty,
      defect: `镜头 ${String(shot)} 的对齐文档有 ${String(aligned.length)} 段，但台词计划声明 ${String(spoken.length)} 条：`
        + '这份对齐不是为当前台词做的，请用同一版台词重新生成对齐，或去掉 alignment 让工具用发声检测。',
    }
  }
  const clipEnd = clipStartSeconds + clipDurationSeconds
  const clamp = (value: number): number => toMilliseconds(Math.min(Math.max(value, clipStartSeconds), clipEnd))
  const cues: PlacedCue[] = []
  let clock = clipStartSeconds
  for (const [index, text] of spoken.entries()) {
    const stretch = aligned[index] as AlignedCue
    if (withoutSpace(stretch.text) !== withoutSpace(text)) {
      return {
        ...empty,
        defect: `镜头 ${String(shot)} 第 ${String(index + 1)} 条对齐文本“${stretch.text}”与台词的“${text}”不一致：`
          + '对齐文档对应的不是这一版台词。字幕文字只取剧本原文，请重新生成对齐后再提交。',
      }
    }
    if (!Number.isFinite(stretch.startSeconds) || !Number.isFinite(stretch.endSeconds)
      || stretch.endSeconds <= stretch.startSeconds) {
      return {
        ...empty,
        defect: `镜头 ${String(shot)} 第 ${String(index + 1)} 条对齐时间无效（${String(stretch.startSeconds)}–`
          + `${String(stretch.endSeconds)}）：请检查生成对齐的脚本输出。`,
      }
    }
    const start = clamp(Math.max(clipStartSeconds + stretch.startSeconds, clock))
    const end = clamp(Math.max(clipStartSeconds + stretch.endSeconds, start + MIN_CUE_SECONDS))
    cues.push({ shot, text, startSeconds: start, endSeconds: end, timingSource: 'asr_aligned' })
    clock = end
  }
  return { shot, cues, regions: 0, aligned: cues.length, estimated: 0, defect: '', warnings: [] }
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

/**
 * Read one episode's alignment document.
 *
 * The document is per-shot and clip-relative, which is how a recognizer running
 * over one shot's own clip reports it: `{"shots":[{"shot":1,"cues":[{"text":
 * "陆沉舟","start":0.0,"end":0.85}]}]}`. Its text is matched against the script
 * and never written to a subtitle.
 * @param document - The parsed JSON value.
 * @param path - The document path, for diagnostics.
 * @returns One entry per shot, ordered by shot number.
 * @throws {Error} When the document does not carry a `shots` array of timed cues.
 */
export function parseAlignment(document: unknown, path: string): AlignedShot[] {
  if (typeof document !== 'object' || document === null
    || !Array.isArray((document as { shots?: unknown }).shots)) {
    throw new Error(`${path}: 对齐文档必须是 {"shots":[{"shot":1,"cues":[{"text":"…","start":0.0,"end":0.8}]}]}。`)
  }
  const rows = (document as { shots: readonly unknown[] }).shots.map((entry, index) => {
    if (typeof entry !== 'object' || entry === null) {
      throw new Error(`${path}：第 ${String(index + 1)} 行不是对象。`)
    }
    const row = entry as { shot?: unknown; cues?: unknown }
    if (!Number.isInteger(row.shot) || (row.shot as number) < 1) {
      throw new Error(`${path}：第 ${String(index + 1)} 行的 shot 必须是正整数镜头号。`)
    }
    if (!Array.isArray(row.cues)) {
      throw new Error(`${path}：镜头 ${String(row.shot)} 的 cues 必须是数组。`)
    }
    const cues = row.cues.map((raw, position) => {
      const cue = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>
      const start = Number(cue.start)
      const end = Number(cue.end)
      if (typeof cue.text !== 'string' || !Number.isFinite(start) || !Number.isFinite(end)) {
        throw new Error(`${path}：镜头 ${String(row.shot)} 第 ${String(position + 1)} 条 cue 必须含 text、start、end。`)
      }
      return { text: cue.text, startSeconds: start, endSeconds: end }
    })
    return { shot: row.shot as number, cues }
  })
  const shots = rows.map(row => row.shot)
  if (new Set(shots).size !== shots.length) {
    throw new Error(`${path}：镜头号重复。请让每个镜头在对齐文档里只出现一次。`)
  }
  return [...rows].sort((left, right) => left.shot - right.shot)
}

/** One cue whose reading speed is worth reporting. */
export interface CueRateFinding {
  /** The cue's shot number. */
  readonly shot: number
  /** The cue's text. */
  readonly text: string
  /** Spoken characters per second the cue asks the viewer to read. */
  readonly charactersPerSecond: number
  /** Whether the speed makes the cue unreadable rather than merely fast. */
  readonly impossible: boolean
}

/**
 * Report every cue whose reading speed is too high.
 * @param cues - Placed cues on the episode clock.
 * @param clipStarts - Where each shot starts on the episode clock, keyed by shot number.
 * @returns One finding per cue past {@link FAST_CHARACTER_RATE}, worst first.
 */
export function cueRateFindings(
  cues: readonly PlacedCue[],
  clipStarts: ReadonlyMap<number, number>,
): CueRateFinding[] {
  const findings: CueRateFinding[] = []
  for (const cue of cues) {
    const clipEnd = clipStarts.get(cue.shot)
    const seconds = cue.endSeconds - cue.startSeconds
    if (clipEnd === undefined || seconds <= 0) continue
    const rate = effectiveCharacterCount(cue.text) / seconds
    if (rate > FAST_CHARACTER_RATE) {
      findings.push({ shot: cue.shot, text: cue.text, charactersPerSecond: rate,
        impossible: rate > IMPOSSIBLE_CHARACTER_RATE })
    }
  }
  return findings.sort((left, right) => right.charactersPerSecond - left.charactersPerSecond)
}
