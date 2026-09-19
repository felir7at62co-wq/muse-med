/**
 * Subtitle input: reading the SRT the pipeline produced and composing the ASS
 * script the delivery style burns in.
 *
 * The burned-in subtitle is part of the delivered picture, so its style is the
 * delivery specification rather than a parameter: SimHei at 68 with -2 spacing
 * and a 7px black outline, bottom-centred on a 1080x1920 canvas, plus the single
 * bottom-right `内容由AI生成` mark.
 *
 * @module @deepseek-ai/dsh-tool-episode-render/subtitles
 */

import { readFile } from 'node:fs/promises'
import { ASS_DOCUMENT_HEADER, escapeAssText, formatAssTime, WATERMARK_POSITION, WATERMARK_TEXT } from './delivery.ts'
import type { SubtitleCue } from './types.ts'

/** The watermark event runs the whole programme; ASS has no "until the end" timestamp. */
const WATERMARK_END = '9:59:59.00'

/**
 * Parse one SRT timestamp.
 * @param value - A timestamp such as `00:01:02,500` or `00:01:02.500`.
 * @param path - The subtitle path, for diagnostics.
 * @returns Seconds from the episode start.
 * @throws {Error} When the timestamp is not `HH:MM:SS,mmm`.
 */
export function parseSrtTime(value: string, path: string): number {
  const parts = value.trim().replace(',', '.').split(':')
  const [hours, minutes, seconds] = parts
  if (parts.length !== 3 || hours === undefined || minutes === undefined || seconds === undefined) {
    throw new Error(`${path}: 字幕时间码 "${value}" 不是 HH:MM:SS,mmm 形式。`
      + '请修正该条字幕的时间行（形如 00:01:02,500 --> 00:01:04,000）后重试。')
  }
  const total = Number(hours) * 3600 + Number(minutes) * 60 + Number(seconds)
  if (!Number.isFinite(total)) {
    throw new Error(`${path}: 字幕时间码 "${value}" 含有非数字字段。`
      + '请修正该条字幕的时间行后重试。')
  }
  return total
}

/**
 * Parse one SRT document.
 *
 * Blocks without a timing line are skipped rather than rejected: an SRT that
 * carries a stray title block is common and harmless. A block whose timing line
 * exists but does not parse is a real defect and throws, because a cue with a
 * wrong time is burned into the delivery.
 * @param text - The whole SRT document.
 * @param path - The subtitle path, for diagnostics.
 * @returns Every cue, in file order, numbered from 1.
 * @throws {Error} When a cue's timing line is malformed.
 */
export function parseSrtDocument(text: string, path: string): SubtitleCue[] {
  const normalized = text.replace(/^\ufeff/, '').replace(/\r\n/g, '\n')
  const cues: SubtitleCue[] = []
  for (const block of normalized.trim().split(/\n\s*\n/)) {
    const lines = block.split('\n')
    const timing = lines[1] ?? ''
    if (lines.length < 3 || !timing.includes('-->')) continue
    const [start = '', end = ''] = timing.split('-->')
    cues.push({
      index: cues.length + 1,
      startSeconds: parseSrtTime(start, path),
      endSeconds: parseSrtTime(end, path),
      text: lines.slice(2).join(''),
    })
  }
  return cues
}

/**
 * Read and parse one subtitle file.
 * @param path - Absolute path of the SRT.
 * @returns Every cue, in file order.
 * @throws {Error} When the file cannot be read or a cue's timing line is malformed.
 */
export async function readSubtitleCues(path: string): Promise<SubtitleCue[]> {
  return parseSrtDocument(await readFile(path, 'utf8'), path)
}

/**
 * Compose the ASS script for one episode.
 *
 * Every cue becomes a `Default` dialogue line and the delivery spec's AI-content
 * mark becomes the single `Watermark` line, so the burn-in carries both the
 * operator's subtitle style and the platform's declaration in one file.
 * @param cues - The cues to burn, in file order.
 * @returns The complete ASS document.
 */
export function buildAssDocument(cues: readonly SubtitleCue[]): string {
  const events = cues.map(cue => 'Dialogue: 0,'
    + `${formatAssTime(cue.startSeconds)},${formatAssTime(cue.endSeconds)},Default,,0,0,0,,`
    + escapeAssText(cue.text))
  events.push(`Dialogue: 1,0:00:00.00,${WATERMARK_END},Watermark,,0,0,0,,`
    + `${WATERMARK_POSITION}${WATERMARK_TEXT}`)
  return `${ASS_DOCUMENT_HEADER}${events.join('\n')}\n`
}
