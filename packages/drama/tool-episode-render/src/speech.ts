/**
 * Subtitle timing taken from a recognition alignment.
 *
 * The lines are already known — the shot script declares them — and their times
 * come from a recognizer that ran over the same clips. Nothing here recognizes
 * speech or measures energy: a level cannot say which words fall where, and an
 * estimated split inside a stretch is what puts a subtitle on the wrong line.
 * The document says when each line is spoken; this module keeps the script's
 * text, orders the cues on the episode clock, and reports what does not fit.
 *
 * A document whose text disagrees with the script describes a different take,
 * which is a defect rather than a number to trust.
 *
 * @module @deepseek-ai/dsh-tool-episode-render/speech
 */

/** Shortest cue written to the delivery. */
export const MIN_CUE_SECONDS = 0.8


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
  /**
   * How the producing script placed this shot, when it says so.
   *
   * Only `asr_aligned` is accepted: any other label means some line in this shot
   * was laid out by proportion rather than matched to speech, and a guessed time
   * is what this package refuses to turn into a subtitle.
   */
  readonly strategy?: string | undefined
}

/** The one alignment label this package accepts. */
export const ALIGNED_STRATEGY = 'asr_aligned'

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
  /** Where the times came from. */
  readonly timingSource: 'asr_aligned'
}

/** What placing one shot's lines produced. */
export interface ShotPlacement {
  /** Shot number. */
  readonly shot: number
  /** The placed cues, in line order. */
  readonly cues: readonly PlacedCue[]
  /** Cues whose times came from the alignment document. */
  readonly aligned: number
  /** The blocking defect for this shot, or an empty string. */
  readonly defect: string
}

/**
 * Count the characters that are actually spoken: CJK, Latin letters, and digits.
 * @param text - The line to weigh, punctuation and spaces excluded.
 * @returns The number of counted characters.
 */
export function effectiveCharacterCount(text: string): number {
  return (text.match(/[\u4e00-\u9fffA-Za-z0-9]/g) ?? []).length
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
 * Place one shot's lines on times an outside alignment already measured.
 *
 * The alignment proves where each line is spoken; it never supplies the words.
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
  const empty: ShotPlacement = { shot, cues: [], aligned: 0, defect: '' }
  if (spoken.length === 0) return empty
  if (aligned.length !== spoken.length) {
    return {
      ...empty,
      defect: `镜头 ${String(shot)} 的对齐文档有 ${String(aligned.length)} 段，但台词计划声明 ${String(spoken.length)} 条：`
        + '这份对齐不是为当前台词做的，请用同一版台词重新生成对齐。',
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
  return { shot, cues, aligned: cues.length, defect: '' }
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
 * The document is per shot and clip-relative, which is how a recognizer running
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
    const strategy = (row as { strategy?: unknown }).strategy
    return {
      shot: row.shot as number,
      cues,
      ...(typeof strategy === 'string' ? { strategy } : {}),
    }
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
