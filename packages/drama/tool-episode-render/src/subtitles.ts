/**
 * Subtitle input: reading the SRT the pipeline produced and composing the ASS
 * script the delivery style burns in.
 *
 * The burned-in subtitle is part of the delivered picture. Without an explicit
 * project subtitle section it retains design size 40 with -2 spacing
 * and a black outline scaled to the delivery width, bottom-centred on a 1080x1920
 * canvas by default. The policy selects the canvas and optional bottom-right AI mark. The outline's ASS
 * Explicit project font/size/margin override those defaults, not the watermark.
 * The outline's field is derived from that delivered width by `assOutline` — the field is in
 * canvas units and libass scales it to the rasterized frame.
 *
 * @module @deepseek-ai/dsh-tool-episode-render/subtitles
 */

import { readFile } from 'node:fs/promises'
import { assCanvas, buildAssHeader, escapeAssText, formatAssTime, WATERMARK_TEXT } from './delivery.ts'
import { deliveryPolicyFor } from './delivery-policy.ts'
import { activeSubtitleVisual } from './subtitle-visual.ts'
import type { DeliveryPolicy, RenderSettings, SubtitleCue } from './types.ts'

/** The watermark event runs the whole programme; ASS has no "until the end" timestamp. */
const WATERMARK_END = '9:59:59.00'

/** Legacy alignment marker retained only for advisory readback.
 * @param path - Subtitle file.
 * @returns The historical marker path; its presence never rejects rendering.
 */
export function subtitleBlockPath(path: string): string { return `${path}.blocked` }

/** Read alignment observations without requiring approval or rejecting the selected SRT.
 * @param path - Selected subtitle file.
 * @returns Current review text and legacy-marker warnings; missing notes add nothing.
 */
export async function subtitleReviewWarnings(path: string): Promise<string[]> {
  const warnings: string[] = []
  for (const note of [`${path}.review.txt`, subtitleBlockPath(path)]) {
    try {
      const text = await readFile(note, 'utf8')
      if (text.trim()) warnings.push(`${path}: 字幕对齐待核：${text.trim()}；由 Muse 核听并决定是否调整，当前操作继续。`)
    } catch (error) {
      if (!(error !== null && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')) throw error
    }
  }
  return warnings
}

/** Report readability observations while preserving authored text.
 * @param cues - Parsed subtitle rows.
 * @returns Per-cue suggestions; no text is rewritten or rejected.
 */
export function subtitleTextWarnings(cues: readonly SubtitleCue[]): string[] {
  return cues.flatMap((cue) => {
    const issues: string[] = []
    if (/[\r\n]/u.test(cue.text)) issues.push('包含多行文字')
    if (!cue.text.trim()) issues.push('没有显示文字')
    else if (!/^[\p{L}\p{N} ]+$/u.test(cue.text)) issues.push('包含标点或其他符号')
    const effective = Array.from(cue.text).reduce((count, char) => count + (char === ' ' ? 0.5 : 1), 0)
    if (effective > 14) issues.push(`${String(effective)} 个有效字，超过建议单行 14 字`)
    return issues.length ? [`第 ${String(cue.index)} 条字幕${issues.join('、')}；建议核对原文并按语义切分，保留当前文本。`] : []
  })
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
 * more than one text row or punctuation remains readable; style is advisory. Invalid timestamps still fail.
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
    const [start = '', end = ''] = timing.split('-->')
    cues.push({
      index: cues.length + 1,
      startSeconds: parseSrtTime(start, path),
      endSeconds: parseSrtTime(end, path),
      text: lines.slice(2).join('\n'),
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
  const visual = activeSubtitleVisual(policy.delivery)
  const canvas = assCanvas(policy.delivery)
  const position = visual === undefined ? ''
    : `{\\an5\\pos(${String(canvas.width / 2)},${String(Number((canvas.height * visual.center_y_ratio).toFixed(3)))})\\q2}`
  const events = cues.map((cue) => {
    return 'Dialogue: 0,'
      + `${formatAssTime(cue.startSeconds)},${formatAssTime(cue.endSeconds)},Default,,0,0,0,,`
      + position + escapeAssText(cue.text)
  })
  if (policy.addWatermark) {
    const canvas = assCanvas(policy.delivery)
    const position = `{\\an3\\pos(${String(canvas.width - 55)},${String(canvas.height - 110)})}`
    events.push(`Dialogue: 1,0:00:00.00,${WATERMARK_END},Watermark,,0,0,0,,${position}${WATERMARK_TEXT}`)
  }
  return `${buildAssHeader(settings, policy.delivery, policy.addWatermark)}${events.join('\n')}\n`
}
