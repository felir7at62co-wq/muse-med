/**
 * Subtitle input: reading the SRT the pipeline produced and composing the ASS
 * script the delivery style burns in.
 *
 * The burned-in subtitle is part of the delivered picture, so its style is the
 * delivery specification rather than a tool parameter: size 40 with -2 spacing
 * and a black outline scaled to the delivery width, bottom-centred on a 1080x1920
 * canvas by default. The policy selects the canvas and optional bottom-right AI mark. The outline's ASS
 * field is derived from that delivered width by `assOutline` — the field is in
 * canvas units and libass scales it to the rasterized frame.
 *
 * @module @deepseek-ai/dsh-tool-episode-render/subtitles
 */

import { readFile, stat } from 'node:fs/promises'
import { assCanvas, buildAssHeader, escapeAssText, formatAssTime, WATERMARK_TEXT } from './delivery.ts'
import { deliveryPolicyFor } from './delivery-policy.ts'
import type { DeliveryPolicy, RenderSettings, SubtitleCue } from './types.ts'

/** The watermark event runs the whole programme; ASS has no "until the end" timestamp. */
const WATERMARK_END = '9:59:59.00'

/** A failed or interrupted automatic alignment blocks reuse of an older SRT. */
export function subtitleBlockPath(path: string): string {
  return `${path}.blocked`
}

/** Refuse a subtitle path whose latest automatic alignment did not succeed. */
export async function assertSubtitleNotBlocked(path: string): Promise<void> {
  const blocked = subtitleBlockPath(path)
  try {
    await stat(blocked)
  } catch (error) {
    if (error !== null && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return
    throw error
  }
  throw new Error(`${path}: 最近一次字幕对齐失败或中断，旧字幕不可用于 prepare/render；请修正对齐后重跑 subtitles。`)
}

/** One readable subtitle row, without punctuation or a renderer-controlled wrap. */
function assertDisplayText(text: string, source: string): void {
  if (text.includes('\n') || text.includes('\r')) {
    throw new Error(`${source}: 字幕必须只有一行；请按语义拆成多个带各自时间码的字幕。`)
  }
  if (text === '' || text.trim() !== text || !/^[\p{L}\p{N} ]+$/u.test(text)) {
    throw new Error(`${source}: 字幕只能包含文字、数字和词间空格，不得带标点或其他符号。`
      + '请保留剧本原文，仅调整显示字幕并重新核对声文时间。')
  }
  const effective = (text.match(/[\p{L}\p{N}]| /gu) ?? [])
    .reduce((count, char) => count + (char === ' ' ? 0.5 : 1), 0)
  if (effective > 14) {
    throw new Error(`${source}: 字幕有 ${String(effective)} 个有效字，超过单行 14 字上限。`
      + '请按语义拆句，并为每条字幕重新对齐发声时间。')
  }
}

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
 * carries a stray title block is common and harmless. A timed cue with no text,
 * more than one text row, or an invalid timestamp is a delivery defect.
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
    if (!timing.includes('-->')) continue
    if (lines.length < 3) {
      throw new Error(`${path}: 第 ${String(cues.length + 1)} 条字幕只有时间码、没有显示文字。`)
    }
    const [start = '', end = ''] = timing.split('-->')
    if (lines.length !== 3) {
      throw new Error(`${path}: 第 ${String(cues.length + 1)} 条字幕有 ${String(lines.length - 2)} 行文字；`
        + '必须拆成分别校时的单行字幕。')
    }
    assertDisplayText(lines[2] as string, `${path}: 第 ${String(cues.length + 1)} 条字幕`)
    cues.push({
      index: cues.length + 1,
      startSeconds: parseSrtTime(start, path),
      endSeconds: parseSrtTime(end, path),
      text: lines[2] as string,
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
 * Format one SRT timestamp.
 * @param seconds - Seconds from the episode start.
 * @returns `HH:MM:SS,mmm`.
 */
export function formatSrtTime(seconds: number): string {
  const total = Math.max(0, Math.round(seconds * 1000))
  const milliseconds = total % 1000
  const whole = (total - milliseconds) / 1000
  const pad = (value: number, width = 2): string => String(value).padStart(width, '0')
  return `${pad(Math.floor(whole / 3600))}:${pad(Math.floor(whole / 60) % 60)}:${pad(whole % 60)},${pad(milliseconds, 3)}`
}

/**
 * Compose one SRT document from placed cues.
 *
 * The written file is the artifact `prepare` installs and `render` burns, and it
 * stays plain SRT so the operator can hand-edit a line before the delivery is
 * encoded.
 * @param cues - The cues to write, in delivery order.
 * @returns The complete SRT document, one block per cue.
 */
export function formatSrtDocument(cues: readonly SubtitleCue[]): string {
  const blocks = cues.map((cue) => {
    assertDisplayText(cue.text, `第 ${String(cue.index)} 条字幕`)
    return `${String(cue.index)}\n`
      + `${formatSrtTime(cue.startSeconds)} --> ${formatSrtTime(cue.endSeconds)}\n`
      + cue.text
  })
  return `${blocks.join('\n\n')}\n`
}

/**
 * Compose the ASS script for one episode.
 *
 * Every cue becomes a `Default` dialogue line. The optional AI-content mark
 * is omitted entirely for 3D animation, including its ASS style.
 * @param cues - The cues to burn, in file order.
 * @param settings - Font families validated by the plugin Config.
 * @param policy - Resolved geometry and medium-specific mark treatment.
 * @returns The complete ASS document.
 */
export function buildAssDocument(
  cues: readonly SubtitleCue[],
  settings: Pick<RenderSettings, 'subtitleFontFamily' | 'watermarkFontFamily'>,
  policy: DeliveryPolicy = deliveryPolicyFor(),
): string {
  const events = cues.map((cue) => {
    assertDisplayText(cue.text, `第 ${String(cue.index)} 条字幕`)
    return 'Dialogue: 0,'
      + `${formatAssTime(cue.startSeconds)},${formatAssTime(cue.endSeconds)},Default,,0,0,0,,`
      + escapeAssText(cue.text)
  })
  if (policy.addWatermark) {
    const canvas = assCanvas(policy.delivery)
    const position = `{\\an3\\pos(${String(canvas.width - 55)},${String(canvas.height - 110)})}`
    events.push(`Dialogue: 1,0:00:00.00,${WATERMARK_END},Watermark,,0,0,0,,${position}${WATERMARK_TEXT}`)
  }
  return `${buildAssHeader(settings, policy.delivery, policy.addWatermark)}${events.join('\n')}\n`
}
