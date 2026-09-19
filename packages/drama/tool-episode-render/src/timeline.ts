/**
 * The episode timeline: reading the JSON the renderer lays out, selecting the
 * body clips one render covers, and deriving the two boundaries every later step
 * cuts at.
 *
 * The timeline is the single clock. Picture and sound both follow it, and the
 * ending starts where its last body clip ends, so a timeline whose clips overlap
 * or whose `body_end` disagrees with the clips is rejected here rather than
 * discovered as an audible drift in the delivered file.
 *
 * @module @deepseek-ai/dsh-tool-episode-render/timeline
 */

import { readFile } from 'node:fs/promises'
import type { Timeline, TimelineClip } from './types.ts'

/** Microseconds in one second. */
const MICROSECONDS_PER_SECOND = 1_000_000

/** Decimal places `body_end` is written with, matching the timeline format. */
const BODY_END_DECIMALS = 6

/** Read one numeric field of a clip, rejecting anything that is not a finite number. */
function readInteger(source: Record<string, unknown>, field: string, path: string, index: number): number {
  const value = source[field]
  if (typeof value !== 'number' || !Number.isFinite(value) || !Number.isInteger(value) || value < 0) {
    throw new Error(`${path}：第 ${String(index + 1)} 个 clip 的 ${field} 必须是非负整数微秒，收到 ${JSON.stringify(value)}。`
      + '请重新生成时间线（prepare 会按真实视频时长写出 start_us 与 duration_us）。')
  }
  return value
}

/**
 * Read one timeline document.
 * @param document - The parsed JSON value.
 * @param path - The path the document came from, for diagnostics.
 * @returns The clips in file order plus the body end they imply.
 * @throws {Error} When `clips` is missing or a clip is not a well-formed non-negative integer row.
 */
export function parseTimelineDocument(document: unknown, path: string): Timeline {
  if (typeof document !== 'object' || document === null || !Array.isArray((document as { clips?: unknown }).clips)) {
    throw new Error(`${path}: 时间线必须是 {"clips":[{"shot":1,"start_us":0,"duration_us":5050000}]}。`
      + '请重新生成时间线，或把 prepare 的输出路径填给 timeline。')
  }
  const clips = (document as { clips: readonly unknown[] }).clips.map((entry, index): TimelineClip => {
    if (typeof entry !== 'object' || entry === null) {
      throw new Error(`${path}：第 ${String(index + 1)} 个 clip 不是对象。`
        + '请提供 {"shot":N,"start_us":整数,"duration_us":整数} 形式的行。')
    }
    const row = entry as Record<string, unknown>
    const shot = readInteger(row, 'shot', path, index)
    if (shot < 1) {
      throw new Error(`${path}：第 ${String(index + 1)} 个 clip 的 shot 必须从 1 开始，收到 ${String(shot)}。`
        + '请按镜头号从 1 连续编号。')
    }
    return {
      shot,
      startUs: readInteger(row, 'start_us', path, index),
      durationUs: readInteger(row, 'duration_us', path, index),
    }
  })
  if (clips.length === 0) {
    throw new Error(`${path}: 时间线没有任何 clip，无法渲染。`
      + '请先用 prepare 由成片清单构建时间线。')
  }
  for (const clip of clips) {
    if (clip.durationUs === 0) {
      throw new Error(`${path}: 镜头 ${String(clip.shot)} 的 duration_us 是 0，无法编码零长片段。`
        + '请确认该镜的成片文件没有被截断成空；必要时重新导出该镜。')
    }
  }
  return { clips, bodyEndSeconds: bodyEndSecondsOf(clips) }
}

/**
 * Derive the body end from a clip list.
 *
 * The body ends at the furthest clip end, not at the last row's end: a timeline
 * whose rows are out of order still renders the whole programme.
 * @param clips - The clips to measure.
 * @returns Seconds from the episode start to the last body frame, rounded to six decimals.
 */
export function bodyEndSecondsOf(clips: readonly TimelineClip[]): number {
  const farthestUs = clips.reduce((end, clip) => Math.max(end, clip.startUs + clip.durationUs), 0)
  return Number((farthestUs / MICROSECONDS_PER_SECOND).toFixed(BODY_END_DECIMALS))
}

/**
 * Read and parse one timeline file.
 * @param path - Absolute path of the timeline JSON.
 * @returns The parsed timeline.
 * @throws {Error} When the file cannot be read, is not JSON, or is not a timeline document.
 */
export async function readTimeline(path: string): Promise<Timeline> {
  const text = await readTimelineText(path)
  let document: unknown
  try {
    document = JSON.parse(text)
  } catch (error) {
    throw new Error(`${path}: 时间线不是合法 JSON。`
      + '请确认它是 UTF-8 的 {"clips":[...]} 文件，或用 prepare 重新生成。', { cause: error })
  }
  return parseTimelineDocument(document, path)
}

/** Read one file as UTF-8 text without a byte-order mark. */
async function readTimelineText(path: string): Promise<string> {
  const text = await readFile(path, 'utf8')
  return text.startsWith('\ufeff') ? text.slice(1) : text
}

/**
 * Keep only the clips one render covers.
 * @param timeline - The whole episode timeline.
 * @param lastShot - The last body shot this render delivers.
 * @returns The selected clips, in file order.
 * @throws {Error} When the timeline does not hold exactly `lastShot` body clips.
 */
export function selectBodyClips(timeline: Timeline, lastShot: number): TimelineClip[] {
  const clips = timeline.clips.filter(clip => clip.shot <= lastShot)
  if (clips.length !== lastShot) {
    throw new Error(`时间线里 shot <= ${String(lastShot)} 的镜头有 ${String(clips.length)} 个，应为 ${String(lastShot)} 个。`
      + `请把 lastShot 改成时间线的最后一个镜头号（${String(timeline.clips.length)}），或先用 prepare 补齐缺失的镜头。`)
  }
  return clips
}

/**
 * Lay clips out on one continuous clock from their own durations.
 * @param durations - One duration in microseconds per shot, in shot order.
 * @returns The timeline with `start_us` accumulated from zero.
 */
export function appendClips(durations: readonly number[]): Timeline {
  const clips: TimelineClip[] = []
  let cursor = 0
  for (const [index, durationUs] of durations.entries()) {
    clips.push({ shot: index + 1, startUs: cursor, durationUs })
    cursor += durationUs
  }
  return { clips, bodyEndSeconds: bodyEndSecondsOf(clips) }
}

/**
 * Render one timeline as the JSON text `prepare` writes.
 * @param timeline - The timeline to serialize.
 * @returns Pretty-printed JSON with a trailing newline.
 */
export function formatTimelineDocument(timeline: Timeline): string {
  return `${JSON.stringify({
    clips: timeline.clips.map(clip => ({ shot: clip.shot, start_us: clip.startUs, duration_us: clip.durationUs })),
    body_end: timeline.bodyEndSeconds,
  }, null, 2)}\n`
}
