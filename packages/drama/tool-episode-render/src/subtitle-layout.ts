/** Advisory glyph measurements through the delivery's real libass burn chain. */
import { createHash } from 'node:crypto'
import { access, mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { subtitleBurnFilter, subtitleRenderStyle } from './delivery.ts'
import { buildAssDocument } from './subtitles.ts'
import type { MediaToolkit, RenderSettings, SubtitleCue, TimelineDelivery } from './types.ts'

/** White glyph pixels measured after supersampling and a luminance threshold of 32. */
export interface SubtitleInkBounds {
  /** Inclusive leftmost probe pixel. */
  readonly left: number
  /** Inclusive rightmost probe pixel. */
  readonly right: number
  /** Inclusive upper probe pixel. */
  readonly top: number
  /** Inclusive lower probe pixel. */
  readonly bottom: number
  /** Measured horizontal ink extent. */
  readonly width: number
  /** Measured vertical ink extent. */
  readonly height: number
}

/** One distinct text's real render and its original, unmodified cue times. */
export interface SubtitleLayoutEntry {
  /** Exact authored text; repeated text shares this probe. */
  readonly text: string
  /** Original cue references; probe time never replaces delivery time. */
  readonly cues: readonly { readonly index: number; readonly start_seconds: number; readonly end_seconds: number }[]
  /** Measured, edge-clipped, or unavailable glyph evidence. */
  readonly status: 'measured' | 'clipped' | 'not_measured'
  /** White ink only; black outlines cannot be measured against black. */
  readonly ink_bounds: SubtitleInkBounds | null
  /** Conservative geometric allowance, not a measured outline or font metric. */
  readonly outline_allowance_px: number
  /** White ink width plus twice the nominal outline width; null without a bound. */
  readonly width_with_outline_estimate_px: number | null
  /** Project maximum width in the actual delivery picture, not the wider probe. */
  readonly available_width_px: number
  /** Unknown when clipped or unmeasured; never a rendering prerequisite. */
  readonly fits_available_width: boolean | null
  /** Exact libass fontselect messages; names are not inferred from requested fonts. */
  readonly fontselect_trace: readonly string[]
  /** Wide measurement evidence and separate actual-delivery ASS/PNG, with shared process logs. */
  readonly files: {
    readonly ass: string
    readonly preview: string
    readonly mask: string
    readonly delivery_ass: string
    readonly delivery_preview: string
    readonly command: string
    readonly stdout: string
    readonly stderr: string
  }
  /** Probe or fit observations; authored text and timing remain unchanged. */
  readonly warnings: readonly string[]
}

/** Saved visual evidence is advisory and does not attest editor or human acceptance. */
export interface SubtitleLayoutReport {
  /** Report format version. */
  readonly schema_version: 1
  /** No explicit visual profile means no measurement or filesystem effect. */
  readonly status: 'not_requested' | 'measured' | 'partial' | 'not_measured'
  /** Actual delivered geometry. */
  readonly delivery_size: { readonly width: number; readonly height: number }
  /** Three-times-wide canvas prevents ordinary width clipping; height is unchanged. */
  readonly probe_size: { readonly width: number; readonly height: number }
  /** Requested font is not evidence of selected or installed font resources. */
  readonly requested_font: string
  /** Exact measurements and their original cue references. */
  readonly entries: readonly SubtitleLayoutEntry[]
  /** Persisted report path; null when nothing was saved. */
  readonly report_path: string | null
}

/** Operation result; technical measurement failure remains an explicit warning. */
export interface SubtitleLayoutResult {
  /** Measured facts, never a quality approval. */
  readonly report: SubtitleLayoutReport
  /** Suggestions and technical failures; they do not block production. */
  readonly warnings: readonly string[]
  /** Files actually saved, excluding promised images that a failed process never wrote. */
  readonly written: readonly string[]
}

/** Read FFmpeg bbox output, refusing empty or invalid white-pixel extents. */
function inkBounds(stderr: string): SubtitleInkBounds | null {
  const match = /\bx1:\s*(\d+)\s+x2:\s*(\d+)\s+y1:\s*(\d+)\s+y2:\s*(\d+)\s+w:\s*(\d+)\s+h:\s*(\d+)/u.exec(stderr)
  if (!match) return null
  const [left, right, top, bottom, width, height] = match.slice(1).map(Number)
  if (left === undefined || right === undefined || top === undefined || bottom === undefined
    || width === undefined || height === undefined || width <= 0 || height <= 0 || right < left || bottom < top) return null
  return { left, right, top, bottom, width, height }
}

/** Save a caller-owned evidence file without replacing a prior run. */
async function save(path: string, content: string, written: string[]): Promise<void> {
  await writeFile(path, content, { flag: 'wx' })
  written.push(path)
}

/**
 * Measure distinct subtitle texts with the same font, ASS builder and 2x burn chain as delivery.
 * @param input - Validated explicit visual settings, original cues and an isolated evidence directory.
 * @param input.toolkit - Existing process channel and FFmpeg runtime.
 * @param input.settings - Deployment font directory and font settings.
 * @param input.delivery - Validated project delivery snapshot; omitted subtitle_visual is a no-op.
 * @param input.cues - Exact authored subtitle rows; no splitting, retiming or replacement occurs.
 * @param input.directory - Parent of the unique evidence directory allocated by this operation.
 * @returns Advisory report, complete output logs and actual written paths; failures are warnings.
 */
export async function measureSubtitleLayout(input: {
  readonly toolkit: MediaToolkit
  readonly settings: RenderSettings
  readonly delivery: TimelineDelivery
  readonly cues: readonly SubtitleCue[]
  readonly directory: string
}): Promise<SubtitleLayoutResult> {
  const { delivery, settings, toolkit } = input
  const visual = delivery.subtitle_visual?.schema_version === 1 ? delivery.subtitle_visual : undefined
  const probe = { ...delivery, width: delivery.width * 3 }
  const base: SubtitleLayoutReport = { schema_version: 1, status: 'not_requested',
    delivery_size: { width: delivery.width, height: delivery.height },
    probe_size: { width: probe.width, height: probe.height },
    requested_font: visual?.font_family ?? settings.subtitleFontFamily, entries: [], report_path: null }
  if (visual === undefined) return { report: base, warnings: [], written: [] }
  const warnings: string[] = [], written: string[] = [], entries: SubtitleLayoutEntry[] = []
  const style = subtitleRenderStyle(delivery)
  const available = delivery.width * visual.max_width_ratio
  const outline = 2 * style.outline_output_px
  let folder: string | undefined
  try {
    await mkdir(input.directory, { recursive: true })
    folder = await mkdtemp(join(input.directory, 'subtitle-layout-'))
    const distinct = new Map<string, SubtitleCue[]>()
    for (const cue of input.cues) {
      const grouped = distinct.get(cue.text) ?? []
      grouped.push(cue)
      distinct.set(cue.text, grouped)
    }
    for (const [text, cues] of distinct) {
      const stem = join(folder, `text-${createHash('sha256').update(text).digest('hex').slice(0, 16)}`)
      const files = { ass: `${stem}.ass`, preview: `${stem}.png`, mask: `${stem}.mask.png`,
        delivery_ass: `${stem}.delivery.ass`, delivery_preview: `${stem}.delivery.png`,
        command: `${stem}.command.json`, stdout: `${stem}.stdout.log`, stderr: `${stem}.stderr.log` }
      const local: string[] = []
      const document = buildAssDocument([{ index: 1, startSeconds: 0, endSeconds: 1, text }], settings,
        { delivery: probe, addWatermark: false, endingSeconds: 0, warnings: [] })
      await save(files.ass, document, written)
      await save(files.delivery_ass, buildAssDocument([{ index: 1, startSeconds: 0, endSeconds: 1, text }], settings,
        { delivery, addWatermark: false, endingSeconds: 0, warnings: [] }), written)
      const chain = `[0:v]${subtitleBurnFilter(files.ass, settings.fontsDir, probe)},split[p][m];`
        + '[m]format=gray,lut=y=\'if(gte(val,32),255,0)\',bbox=min_val=1[mask];'
        + `[1:v]${subtitleBurnFilter(files.delivery_ass, settings.fontsDir, delivery)}[delivery]`
      const args = ['-nostdin', '-hide_banner', '-loglevel', 'verbose', '-n', '-filter_complex_threads', '1',
        '-f', 'lavfi', '-i', `color=c=black:s=${String(probe.width)}x${String(probe.height)}:r=1:d=1`,
        '-f', 'lavfi', '-i', `color=c=black:s=${String(delivery.width)}x${String(delivery.height)}:r=1:d=1`,
        '-filter_complex', chain, '-map', '[p]', '-frames:v', '1', '-update', '1', files.preview,
        '-map', '[mask]', '-frames:v', '1', '-update', '1', files.mask,
        '-map', '[delivery]', '-frames:v', '1', '-update', '1', files.delivery_preview]
      await save(files.command, `${JSON.stringify({ command: toolkit.ffmpeg, args }, null, 2)}\n`, written)
      let stdout = '', stderr = '', code: number | null = null
      try {
        const outcome = await toolkit.channel.run(toolkit.ffmpeg, args)
        stdout = outcome.stdout; stderr = outcome.stderr; code = outcome.code
      } catch (error) {
        stderr = error instanceof Error ? error.stack ?? error.message : String(error)
      }
      await save(files.stdout, stdout, written)
      await save(files.stderr, stderr, written)
      await save(`${stem}.exit.json`, `${JSON.stringify({ exit_code: code })}\n`, written)
      const traces = stderr.split(/\r?\n/u).filter(line => line.includes('fontselect:'))
      const bounds = code === 0 ? inkBounds(stderr) : null
      if (code !== 0) local.push(`字幕字形探针失败（退出码 ${String(code)}），保留完整日志 ${files.stderr}；当前字幕不改写。`)
      else if (bounds === null) local.push(`字幕字形探针未取得白字边界：${files.stderr}；宽度尚未验证。`)
      for (const image of [files.preview, files.mask, files.delivery_preview]) {
        try { await access(image); written.push(image) } catch (error) {
          if (!(error !== null && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')) throw error
        }
      }
      const clipped = bounds !== null && (bounds.left - outline / 2 <= 0 || bounds.right + outline / 2 >= probe.width - 1
        || bounds.top - outline / 2 <= 0 || bounds.bottom + outline / 2 >= probe.height - 1)
      const estimated = bounds === null ? null : bounds.width + outline
      const fits = bounds === null || clipped ? null : estimated !== null && estimated <= available
      if (clipped) local.push(`字幕触及三倍宽字形探针边缘或描边余量，完整宽度尚未确认：${files.preview}。`)
      if (fits === false) local.push(`字幕“${text}”白字实测宽 ${String(bounds?.width)}px，加描边估计 ${String(estimated)}px，`
        + `超过项目可用宽 ${String(available)}px；请按实际字词时间选择语义切点，保留当前文本与时间。`)
      if (traces.length === 0) local.push(`libass 未报告字体选择记录，实际字体尚未确认：${files.stderr}。`)
      if (/[\r\n]/u.test(text)) local.push('字幕原文包含换行；该探针不自动合并或切分字幕。')
      entries.push({ text, cues: cues.map(cue => ({ index: cue.index, start_seconds: cue.startSeconds, end_seconds: cue.endSeconds })),
        status: bounds === null ? 'not_measured' : clipped ? 'clipped' : 'measured',
        ink_bounds: bounds, outline_allowance_px: outline, width_with_outline_estimate_px: estimated,
        available_width_px: available, fits_available_width: fits, fontselect_trace: traces, files, warnings: local })
      warnings.push(...local)
    }
    const reportPath = join(folder, 'report.json')
    const report: SubtitleLayoutReport = { ...base, status: entries.every(entry => entry.status === 'measured') ? 'measured' : 'partial',
      entries, report_path: reportPath }
    await save(reportPath, `${JSON.stringify(report, null, 2)}\n`, written)
    return { report, warnings, written }
  } catch (error) {
    warnings.push(`字幕字形测量未完成：${error instanceof Error ? error.message : String(error)}；保留已写证据，不阻断制作。`)
    return { report: { ...base, status: 'not_measured', entries, report_path: null }, warnings, written }
  }
}
