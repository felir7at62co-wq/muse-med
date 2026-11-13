/** Local OCR over bounded, timestamped video frame batches. */
import { createHash, randomUUID } from 'node:crypto'
import { platform } from 'node:os'
import { fileURLToPath } from 'node:url'
import { inspect } from 'node:util'
import type { Context } from '@deepseek-ai/cordis'
import type { FsVersion } from '@deepseek-ai/dsh-fs'
import { defineTool, type ToolExecution } from '@deepseek-ai/dsh-tools'
import type { Config } from './index.ts'
import * as Media from './media.ts'

/** Shared ownership used by all video inspection operations. */
export interface OcrRuntime {
  run<T>(exec: ToolExecution, operation: (signal: AbortSignal) => Promise<T>): Promise<T>
}

type OcrLanguage = 'auto' | 'zh-Hans-CN' | 'zh-Hant-TW' | 'en-US'
type ScanStatus = 'complete' | 'partial' | 'failed'
type TextStatus = 'candidate_text_detected' | 'no_text_detected' | 'indeterminate'
type TextClassification = 'content_candidate' | 'persistent_text_candidate'

interface Box {
  x: number
  y: number
  width: number
  height: number
}

interface OcrWord {
  text: string
  bounding_box: Box
}

/** One unmodified OCR line from the selected local bridge. */
export interface RawOcrLine {
  text: string
  bounding_box: Box
  words: OcrWord[]
  classification?: TextClassification
}

/** OCR evidence for one decoded source frame. */
export interface RawOcrFrame {
  id: string
  requested_seconds: number
  timestamp_seconds: number
  image_width: number
  image_height: number
  lines: RawOcrLine[]
}

/** A conservative merge of identical OCR lines across adjacent sampled frames. */
export interface OcrSegment {
  start_seconds: number
  end_seconds: number
  text: string
  classification: TextClassification
  evidence_frame_ids: string[]
}

interface BridgeFrame {
  id: string
  timestamp_seconds: number
  image_width: number
  image_height: number
  lines: RawOcrLine[]
}

interface BridgeSuccess {
  ok: true
  language_used: string
  frames: BridgeFrame[]
}

interface BridgeFailure {
  ok: false
  code: 'language_unavailable' | 'ocr_engine_unavailable' | 'invalid_input' | 'frame_decode_failed'
}

type BridgeResult = BridgeSuccess | BridgeFailure

interface ExtractedFrame {
  id: string
  requested_seconds: number
  timestamp_seconds: number
  bytes: Uint8Array
}

interface OcrEvidence {
  schema_version: 1
  evidence_algorithm: 'decoded-pts-spatial-v2'
  path: string
  source_version: FsVersion
  duration_seconds: number
  text_source: 'ocr'
  language_requested: OcrLanguage
  language_used?: string
  interval: { start_seconds: number; end_seconds: number }
  scan_status: ScanStatus
  text_status: TextStatus
  coverage: {
    planned_frame_count: number
    processed_frame_count: number
    failed_frame_count: number
    frame_interval_seconds: number
    scanned_ranges: { start_seconds: number; end_seconds: number }[]
    unscanned_ranges: { start_seconds: number; end_seconds: number; reason: 'deployment_limit' }[]
    failed_timestamps_seconds: number[]
  }
  frames: RawOcrFrame[]
  segments: OcrSegment[]
  failure_code?: 'windows_only' | 'ocr_runtime_unavailable' | 'language_unavailable' | 'ocr_engine_unavailable'
}

/** Compact model-facing OCR result; complete evidence remains in raw_json_path. */
export interface VideoOcrResult {
  path: string
  source_version: FsVersion
  duration_seconds: number
  text_source: 'ocr'
  interval: { start_seconds: number; end_seconds: number }
  scan_status: ScanStatus
  text_status: TextStatus
  coverage: OcrEvidence['coverage']
  segment_count: number
  persistent_text_count: number
  preview_segments: (Omit<OcrSegment, 'evidence_frame_ids'> & { evidence_frame_count: number })[]
  raw_json_path: string
  /** SHA-256 of the exact complete evidence bytes written and read back by this tool. */
  raw_json_sha256: string
  merged_text_path: string
  language_requested: OcrLanguage
  language_used?: string
  failure_code?: OcrEvidence['failure_code']
  next_start_seconds?: number
}

const rangeSchema = { type: 'object', additionalProperties: false, properties: {
  start_seconds: { type: 'number', required: true }, end_seconds: { type: 'number', required: true },
} } as const

const segmentSchema = { type: 'object', additionalProperties: false, properties: {
  start_seconds: { type: 'number', required: true }, end_seconds: { type: 'number', required: true },
  text: { type: 'string', required: true },
  classification: { type: 'string', enum: ['content_candidate', 'persistent_text_candidate'], required: true },
  evidence_frame_count: { type: 'integer', required: true },
} } as const

const outputSchema = { type: 'object', additionalProperties: false, properties: {
  path: { type: 'string', required: true }, source_version: { type: 'string', required: true },
  duration_seconds: { type: 'number', required: true }, text_source: { type: 'string', const: 'ocr', required: true },
  interval: { ...rangeSchema, required: true },
  scan_status: { type: 'string', enum: ['complete', 'partial', 'failed'], required: true },
  text_status: { type: 'string', enum: ['candidate_text_detected', 'no_text_detected', 'indeterminate'], required: true },
  coverage: { type: 'object', additionalProperties: false, required: true, properties: {
    planned_frame_count: { type: 'integer', required: true }, processed_frame_count: { type: 'integer', required: true },
    failed_frame_count: { type: 'integer', required: true }, frame_interval_seconds: { type: 'number', required: true },
    scanned_ranges: { type: 'array', items: rangeSchema, required: true },
    unscanned_ranges: { type: 'array', items: { type: 'object', additionalProperties: false, properties: {
      start_seconds: { type: 'number', required: true }, end_seconds: { type: 'number', required: true },
      reason: { type: 'string', const: 'deployment_limit', required: true },
    } }, required: true },
    failed_timestamps_seconds: { type: 'array', items: { type: 'number' }, required: true },
  } },
  segment_count: { type: 'integer', required: true }, persistent_text_count: { type: 'integer', required: true },
  preview_segments: { type: 'array', items: segmentSchema, required: true },
  raw_json_path: { type: 'string', required: true }, raw_json_sha256: { type: 'string', required: true },
  merged_text_path: { type: 'string', required: true },
  language_requested: { type: 'string', enum: ['auto', 'zh-Hans-CN', 'zh-Hant-TW', 'en-US'], required: true },
  language_used: { type: 'string' },
  failure_code: { type: 'string', enum: ['windows_only', 'ocr_runtime_unavailable', 'language_unavailable', 'ocr_engine_unavailable'] },
  next_start_seconds: { type: 'number' },
} } as const

function finite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function box(value: unknown): Box | undefined {
  if (!value || typeof value !== 'object') return undefined
  const source = value as Record<string, unknown>
  if (![source.x, source.y, source.width, source.height].every(finite)) return undefined
  if (Number(source.width) < 0 || Number(source.height) < 0) return undefined
  return { x: Number(source.x), y: Number(source.y), width: Number(source.width), height: Number(source.height) }
}

function line(value: unknown): RawOcrLine | undefined {
  if (!value || typeof value !== 'object') return undefined
  const source = value as Record<string, unknown>, bounding = box(source.bounding_box)
  if (typeof source.text !== 'string' || !bounding || !Array.isArray(source.words)) return undefined
  const words: OcrWord[] = []
  for (const candidate of source.words) {
    if (!candidate || typeof candidate !== 'object') return undefined
    const word = candidate as Record<string, unknown>, wordBox = box(word.bounding_box)
    if (typeof word.text !== 'string' || !wordBox) return undefined
    words.push({ text: word.text, bounding_box: wordBox })
  }
  return { text: source.text, bounding_box: bounding, words }
}

/** Parse and validate the bounded JSON returned by the selected local OCR bridge.
 * @param bytes - UTF-8 JSON emitted by the bounded bridge process.
 * @returns Validated OCR bridge success or failure data.
 */
export function parseOcrBridgeResult(bytes: Uint8Array): BridgeResult {
  const value: unknown = JSON.parse(Buffer.from(bytes).toString('utf8'))
  if (!value || typeof value !== 'object' || !('ok' in value)) throw Error('OCR bridge returned an invalid result')
  const source = value as Record<string, unknown>
  if (source.ok === false) {
    if (!['language_unavailable', 'ocr_engine_unavailable', 'invalid_input', 'frame_decode_failed'].includes(String(source.code))) {
      throw Error('OCR bridge returned an invalid failure code')
    }
    return { ok: false, code: String(source.code) as BridgeFailure['code'] }
  }
  if (source.ok !== true || typeof source.language_used !== 'string' || !Array.isArray(source.frames)) {
    throw Error('OCR bridge returned an invalid result')
  }
  const frames: BridgeFrame[] = []
  for (const candidate of source.frames) {
    if (!candidate || typeof candidate !== 'object') throw Error('OCR bridge returned an invalid frame')
    const frame = candidate as Record<string, unknown>
    const width = Number(frame.image_width), height = Number(frame.image_height)
    if (typeof frame.id !== 'string' || !finite(frame.timestamp_seconds) || !Number.isSafeInteger(width)
      || width <= 0 || !Number.isSafeInteger(height) || height <= 0
      || !Array.isArray(frame.lines)) throw Error('OCR bridge returned an invalid frame')
    const lines: RawOcrLine[] = []
    for (const candidateLine of frame.lines) {
      const parsed = line(candidateLine)
      if (parsed === undefined) throw Error('OCR bridge returned an invalid line')
      lines.push(parsed)
    }
    frames.push({ id: frame.id, timestamp_seconds: frame.timestamp_seconds, image_width: width,
      image_height: height, lines })
  }
  return { ok: true, language_used: source.language_used, frames }
}

/** Split a complete bounded MJPEG stream without accepting partial images.
 * @param bytes - Complete bounded MJPEG process output.
 * @returns Complete JPEG frames in source order.
 */
export function splitMjpeg(bytes: Uint8Array): Uint8Array[] {
  const frames: Uint8Array[] = []
  let start = -1
  for (let index = 0; index < bytes.length - 1; index += 1) {
    if (bytes[index] === 0xff && bytes[index + 1] === 0xd8) {
      if (start !== -1) throw Error('OCR frame batch contains nested JPEG data')
      start = index
    } else if (bytes[index] === 0xff && bytes[index + 1] === 0xd9 && start !== -1) {
      frames.push(bytes.slice(start, index + 2))
      start = -1
      index += 1
    }
  }
  if (start !== -1) throw Error('OCR frame batch ended with a partial JPEG image')
  return frames
}

/** Extract all FFmpeg showinfo presentation timestamps in output order.
 * @param diagnostic - Bounded FFmpeg diagnostic text.
 * @returns Finite non-negative presentation timestamps in output order.
 */
export function showinfoTimestamps(diagnostic: string): number[] {
  return Array.from(diagnostic.matchAll(/\bpts_time:([\d.e+-]+)/g), match => Number(match[1]))
    .filter(value => Number.isFinite(value) && value >= 0)
}

/** Normalize OCR grouping text without removing punctuation or changing letter case.
 * @param text - Exact recognized text or the corresponding raw-line text.
 * @returns NFKC text with whitespace removed, shared by grouping and source verification.
 */
export function normalizeOcrText(text: string): string {
  return text.normalize('NFKC').replace(/\s+/gu, '').trim()
}

function normalizedBox(line: RawOcrLine, frame: RawOcrFrame): Box {
  return { x: line.bounding_box.x / frame.image_width, y: line.bounding_box.y / frame.image_height,
    width: line.bounding_box.width / frame.image_width, height: line.bounding_box.height / frame.image_height }
}

function overlap(left: Box, right: Box): number {
  const width = Math.max(0, Math.min(left.x + left.width, right.x + right.width) - Math.max(left.x, right.x))
  const height = Math.max(0, Math.min(left.y + left.height, right.y + right.height) - Math.max(left.y, right.y))
  const intersection = width * height, union = left.width * left.height + right.width * right.height - intersection
  return union <= 0 ? 0 : intersection / union
}

/** Label visually persistent text without inferring whether it is narrative, and merge adjacent identical lines.
 * @param frames - Validated timestamped OCR frame evidence.
 * @param options - Sampling interval and visual persistence thresholds.
 * @returns Time-ordered merged OCR segments retaining evidence identifiers.
 */
export function classifyAndMerge(frames: RawOcrFrame[], options: {
  frameIntervalSeconds: number
  persistentTextMinFrames: number
  persistentTextMinSeconds: number
  overlayMinIou: number
}): OcrSegment[] {
  type Occurrence = { frame: RawOcrFrame; line: RawOcrLine }
  const occurrences = new Map<string, [Occurrence, ...Occurrence[]]>()
  for (const frame of frames) for (const candidate of frame.lines) {
    const key = normalizeOcrText(candidate.text)
    if (!key) continue
    const matching = occurrences.get(key)
    if (matching) matching.push({ frame, line: candidate })
    else occurrences.set(key, [{ frame, line: candidate }])
  }
  for (const group of occurrences.values()) {
    const first = group[0]
    const stable = group.filter(item =>
      overlap(normalizedBox(first.line, first.frame), normalizedBox(item.line, item.frame)) >= options.overlayMinIou)
    const span = (stable.at(-1)?.frame.timestamp_seconds ?? 0) - (stable[0]?.frame.timestamp_seconds ?? 0)
    if (stable.length >= options.persistentTextMinFrames && span >= options.persistentTextMinSeconds) {
      for (const item of stable) item.line.classification = 'persistent_text_candidate'
    }
  }
  const segments: OcrSegment[] = [], open = new Map<string, OcrSegment[]>()
  const positions = new Map<OcrSegment, Box>(), lastRequested = new Map<OcrSegment, number>()
  for (const frame of frames) for (const candidate of frame.lines) {
    const text = candidate.text.trim()
    if (!normalizeOcrText(text)) continue
    const classification = candidate.classification ?? 'content_candidate'
    const key = `${classification}:${normalizeOcrText(text)}`
    const matching = open.get(key) ?? []
    const prior = matching.find((item) => {
      const last = lastRequested.get(item), position = positions.get(item)
      return last !== undefined && position !== undefined && !item.evidence_frame_ids.includes(frame.id)
        && frame.requested_seconds - last <= options.frameIntervalSeconds * 1.5
        && overlap(position, normalizedBox(candidate, frame)) >= options.overlayMinIou
    })
    if (prior) {
      prior.end_seconds = frame.requested_seconds + options.frameIntervalSeconds
      prior.evidence_frame_ids.push(frame.id)
      positions.set(prior, normalizedBox(candidate, frame))
      lastRequested.set(prior, frame.requested_seconds)
    } else {
      const segment = { start_seconds: frame.timestamp_seconds,
        end_seconds: frame.requested_seconds + options.frameIntervalSeconds, text, classification,
        evidence_frame_ids: [frame.id] }
      segments.push(segment)
      positions.set(segment, normalizedBox(candidate, frame))
      lastRequested.set(segment, frame.requested_seconds)
      matching.push(segment)
      open.set(key, matching)
    }
  }
  return segments.sort((left, right) => left.start_seconds - right.start_seconds)
}

function scannedRanges(frames: RawOcrFrame[], interval: number, end: number): { start_seconds: number; end_seconds: number }[] {
  const ordered = [...frames].sort((left, right) => left.requested_seconds - right.requested_seconds)
  const ranges: { start_seconds: number; end_seconds: number }[] = []
  for (const frame of ordered) {
    const start = frame.requested_seconds, frameEnd = Math.min(end, start + interval), prior = ranges.at(-1)
    if (prior && start <= prior.end_seconds + interval * 0.25) prior.end_seconds = Math.max(prior.end_seconds, frameEnd)
    else ranges.push({ start_seconds: start, end_seconds: frameEnd })
  }
  return ranges
}

function timecode(seconds: number): string {
  const milliseconds = Math.max(0, Math.round(seconds * 1000))
  const ms = milliseconds % 1000, totalSeconds = Math.floor(milliseconds / 1000)
  const sec = totalSeconds % 60, totalMinutes = Math.floor(totalSeconds / 60)
  const min = totalMinutes % 60, hours = Math.floor(totalMinutes / 60)
  return `${String(hours).padStart(2, '0')}:${String(min).padStart(2, '0')}:${String(sec).padStart(2, '0')}.${String(ms).padStart(3, '0')}`
}

function mergedText(evidence: OcrEvidence): string {
  const header = [`OCR source: ${evidence.path}`, `Text source: ${evidence.text_source}`,
    `Scan status: ${evidence.scan_status}`, `Text status: ${evidence.text_status}`,
    `Scanned interval: ${timecode(evidence.interval.start_seconds)} - ${timecode(evidence.interval.end_seconds)}`,
    `Language: ${evidence.language_used ?? evidence.language_requested}`, '']
  return [...header, ...evidence.segments.map(segment => `[${timecode(segment.start_seconds)} - ${timecode(segment.end_seconds)}] [${segment.classification}] ${segment.text}`), ''].join('\n')
}

/** Resolve an executable package asset outside Electron ASAR while retaining source-tree paths in development.
 * @param moduleUrl - URL of the source or packaged OCR module.
 * @param engine - Selected bridge, defaulting to the existing Windows engine.
 * @returns Host path to the directly executable local bridge.
 */
export function ocrBridgeHostPath(moduleUrl = import.meta.url, engine: Config['ocrEngine'] = 'windows-native'): string {
  return fileURLToPath(new URL(engine === 'rapidocr' ? '../scripts/ocr_bridge.py' : '../scripts/ocr_bridge.ps1', moduleUrl))
    .replace(/([\\/])app\.asar([\\/])/u, '$1app.asar.unpacked$2')
}

class OcrTimestampOriginError extends Error {}

interface SourceFrame { pts: number; time: number; duration?: number }

/** Find the source frame displayed at one requested microsecond, including its final-frame duration. */
function displayedFrame(frames: readonly SourceFrame[], requestedUs: number): SourceFrame | undefined {
  const position = frames.findLastIndex(frame => Math.round(frame.time * 1_000_000) <= requestedUs)
  const frame = frames[position], next = frames[position + 1]
  const displayEnd = next?.time ?? (frame?.duration === undefined ? undefined : frame.time + frame.duration)
  return frame && displayEnd !== undefined && Math.round(displayEnd * 1_000_000) > requestedUs ? frame : undefined
}

async function extractBatch(ctx: Context, config: Config, source: string, ffmpeg: string,
  policy: ReturnType<Context['sandboxPolicy']['resolve']>, signal: AbortSignal, start: number, count: number,
  interval: number, sourceDuration: number): Promise<ExtractedFrame[]> {
  // Probe the frames surrounding the sampling windows before selecting visible frames.
  const startUs = Math.round(start * 1_000_000), endUs = Math.round((start + count * interval) * 1_000_000)
  const ffprobe = await ctx.subprocess.resolveExecutable(config.ffprobePath, undefined, signal)
  let probeEnd = Math.min(sourceDuration, start + count * interval * 2)
  let probeStart = startUs / 1_000_000
  let sourceFrames: SourceFrame[] = []
  for (;;) {
    // A complete zero-origin scan omits the empty '%' interval, which can return no frames.
    const intervalArgs = probeStart === 0 && probeEnd >= sourceDuration ? []
      : ['-read_intervals', `${probeStart === 0 ? '' : probeStart}%${probeEnd >= sourceDuration ? '' : probeEnd}`]
    const probe = await Media.runMedia(ctx, [ffprobe, '-v', 'error', '-protocol_whitelist', 'file,pipe',
      '-select_streams', 'v:0', ...intervalArgs,
      '-show_entries', 'format=start_time:stream=start_time:frame=best_effort_timestamp,best_effort_timestamp_time,duration_time,pkt_duration_time', '-of', 'json', source],
    policy, signal, { timeoutMs: config.ocrCommandTimeoutMs, graceMs: config.graceMs, maxBytes: config.maxOcrBatchImageBytes })
    const parsed: unknown = JSON.parse(Buffer.from(probe.bytes).toString('utf8'))
    if (!parsed || typeof parsed !== 'object' || !('frames' in parsed) || !Array.isArray(parsed.frames)
      || !('streams' in parsed) || !Array.isArray(parsed.streams) || parsed.streams.length !== 1) {
      throw Error('OCR frame probe did not return source timestamps')
    }
    const stream: unknown = parsed.streams[0]
    const format: unknown = 'format' in parsed ? parsed.format : undefined
    if (!stream || typeof stream !== 'object' || !('start_time' in stream) || Number(stream.start_time) !== 0
      || !format || typeof format !== 'object' || !('start_time' in format) || Number(format.start_time) !== 0) {
      throw new OcrTimestampOriginError('OCR暂不支持非零或未知起点的视频时间轴；请保留原片并使用零起点副本重新审看。')
    }
    sourceFrames = []
    const seenPts = new Set<number>(), rawFrames: readonly unknown[] = parsed.frames
    for (const row of rawFrames) {
      if (!row || typeof row !== 'object' || !('best_effort_timestamp' in row) || !('best_effort_timestamp_time' in row)) {
        throw Error('OCR frame probe omitted a source timestamp')
      }
      const pts = Number(row.best_effort_timestamp), time = Number(row.best_effort_timestamp_time)
      const previous = sourceFrames.at(-1)
      if (!Number.isSafeInteger(pts) || seenPts.has(pts) || !Number.isFinite(time) || time < 0
        || (previous !== undefined && time <= previous.time)) {
        throw Error('OCR source timestamps are invalid or unordered')
      }
      const rawDuration = 'duration_time' in row ? row.duration_time : 'pkt_duration_time' in row ? row.pkt_duration_time : undefined
      const duration = Number(rawDuration)
      sourceFrames.push({ pts, time, ...(Number.isFinite(duration) && duration > 0 ? { duration } : {}) })
      seenPts.add(pts)
    }
    // Indexed seeking may skip the requested frame; an omitted interval start reads without seeking.
    const lastRequest = start + (count - 1) * interval
    if (probeStart !== 0 && [startUs, Math.round(lastRequest * 1_000_000)].some(time => displayedFrame(sourceFrames, time) === undefined)) {
      probeStart = 0
      continue
    }
    if ((sourceFrames.at(-1)?.time ?? -1) > lastRequest || probeEnd >= sourceDuration) break
    probeEnd = Math.min(sourceDuration, start + (probeEnd - start) * 2)
  }
  const selected = Array.from({ length: count }, (_, index) => {
    const requestedUs = Math.round((start + index * interval) * 1_000_000)
    const frame = displayedFrame(sourceFrames, requestedUs)
    if (frame === undefined) {
      throw Error('OCR source has no frame covering a requested sample')
    }
    return { frame, requested: start + index * interval }
  })
  const unique = [...new Map(selected.map(item => [item.frame.pts, item.frame])).values()]
  const selection = unique.map(frame => `eq(pts\\,${frame.pts})`).join('+')
  // Progress output can interrupt showinfo fields on stderr; these fields identify decoded evidence.
  const output = await Media.runMedia(ctx, [ffmpeg, '-nostdin', '-nostats', '-hide_banner', '-loglevel', 'info',
    '-protocol_whitelist', 'file,pipe', '-ss', String(startUs / 1_000_000), '-noaccurate_seek', '-copyts', '-i', source,
    '-to', String(endUs / 1_000_000), '-map', '0:v:0', '-an', '-sn', '-dn',
    '-vf', `select=${selection},trim=end_frame=${unique.length},scale=w='min(${config.ocrFrameMaxDimension},iw)':h='min(${config.ocrFrameMaxDimension},ih)':force_original_aspect_ratio=decrease,showinfo`,
    '-fps_mode', 'passthrough', '-frames:v', String(unique.length), '-c:v', 'mjpeg', '-q:v', String(config.ocrFrameJpegQuality),
    '-f', 'image2pipe', 'pipe:1'], policy, signal, { timeoutMs: config.ocrCommandTimeoutMs,
    graceMs: config.graceMs, maxBytes: config.maxOcrBatchImageBytes, maxDiagnosticBytes: config.maxOcrDiagnosticBytes })
  const images = splitMjpeg(output.bytes), timestamps = showinfoTimestamps(output.diagnostic)
  const pts = Array.from(output.diagnostic.matchAll(/\bpts:\s*(-?\d+)\s+pts_time:/gu), match => Number(match[1]))
  // FFmpeg 6 prints six significant time digits; integer PTS still identifies the exact selected frame.
  if (images.length > unique.length || timestamps.length !== images.length || pts.length !== images.length
    || unique.slice(0, images.length).some((frame, index) => pts[index] !== frame.pts
      || Math.round(Number(timestamps[index]) * 1_000_000) !== Math.round(frame.time * 1_000_000)
        && timestamps[index] !== Number(frame.time.toPrecision(6)))) {
    throw Error('OCR frame batch did not return the selected source frames')
  }
  const byPts = new Map(unique.map((frame, index) => [frame.pts, images[index]]))
  const extracted: ExtractedFrame[] = []
  for (const item of selected) {
    const bytes = byPts.get(item.frame.pts)
    if (bytes === undefined) break
    extracted.push({ id: `frame-${randomUUID()}`, requested_seconds: item.requested, timestamp_seconds: item.frame.time, bytes })
  }
  return extracted
}

async function runBridge(ctx: Context, config: Config, policy: ReturnType<Context['sandboxPolicy']['resolve']>, signal: AbortSignal,
  executable: string, script: string, language: OcrLanguage, frames: ExtractedFrame[]): Promise<BridgeResult> {
  const stdin = JSON.stringify({ language, ...(config.ocrEngine === 'rapidocr' ? { cpu_threads: config.ocrCpuThreads } : {}), frames: frames.map(frame => ({ id: frame.id,
    timestamp_seconds: frame.timestamp_seconds, image_base64: Buffer.from(frame.bytes).toString('base64') })) })
  if (Buffer.byteLength(stdin, 'utf8') > config.maxOcrBridgeInputBytes) throw Error('OCR bridge input exceeds its byte limit')
  const command = config.ocrEngine === 'rapidocr' ? [executable, '-I', '-B', '-X', 'utf8', script]
    : [executable, '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script]
  const output = await Media.runMedia(ctx, command,
    policy, signal, { timeoutMs: config.ocrCommandTimeoutMs, graceMs: config.graceMs,
      maxBytes: config.maxOcrOutputBytes, maxDiagnosticBytes: config.maxOcrDiagnosticBytes, stdin })
  return parseOcrBridgeResult(output.bytes)
}

function textStatus(scanStatus: ScanStatus, frames: RawOcrFrame[], segments: OcrSegment[]): TextStatus {
  if (segments.length) return 'candidate_text_detected'
  if (scanStatus !== 'complete') return 'indeterminate'
  return frames.every(frame => frame.lines.length === 0) ? 'no_text_detected' : 'indeterminate'
}

/** Register local OCR without adding any cloud or ASR fallback path.
 * @param ctx - Host context owning tool, filesystem, subprocess and sandbox services.
 * @param config - Validated video inspection and OCR deployment limits.
 * @param runtime - Shared operation lifecycle and concurrency owner.
 */
export function applyVideoOcr(ctx: Context, config: Config, runtime: OcrRuntime): void {
  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'video_ocr',
    description: 'Recognize visible text from bounded, timestamped samples of a local video with the configured offline OCR engine. '
      + 'Returns raw evidence JSON, merged text, source timestamps and explicit scan coverage. '
      + 'A partial or failed scan is indeterminate, never proof that the video has no subtitles. '
      + 'Persistent text remains a content candidate; visual persistence does not identify watermarks or non-narrative text. This tool never invokes audio transcription.',
    parameters: {
      file_path: { type: 'string', required: true, description: 'Local video path in the current Session filesystem.' },
      start_seconds: { type: 'number', description: 'Inclusive source range start; default 0.' },
      end_seconds: { type: 'number', description: `Exclusive source range end; default video end. One call scans at most ${config.ocrMaxRangeSeconds}s and ${config.ocrMaxFrames} frames; continue from next_start_seconds.` },
      frame_interval_seconds: { type: 'number', description: `OCR sample spacing; default ${config.ocrFrameIntervalSeconds}s.` },
      language: { type: 'string', enum: ['auto', 'zh-Hans-CN', 'zh-Hant-TW', 'en-US'], description: `OCR language; default ${config.ocrLanguage}. Missing requested language returns an explicit failure and never falls back to ASR.` },
      raw_json_path: { type: 'string', description: 'Optional new raw evidence JSON path inside the workspace. Existing files are never replaced.' },
      merged_text_path: { type: 'string', description: 'Optional new timestamped text path inside the workspace. Existing files are never replaced.' },
    },
    output: {
      schema: outputSchema,
      preserveBodyMeta: true,
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
      presentationMeta: (_args, value) => ({ path: value.path, rawJsonPath: value.raw_json_path,
        rawJsonSha256: value.raw_json_sha256, sourceVersion: value.source_version,
        mergedTextPath: value.merged_text_path, scanStatus: value.scan_status, textStatus: value.text_status }),
    },
    presentCall: args => ({ card: 'generic', title: 'video_ocr', kind: 'read', locations: [{ path: args.file_path }] }),
    isConcurrencySafe: () => true,
    execute: (args, exec) => runtime.run(exec, async (signal) => {
      const policy = ctx.sandboxPolicy.resolve(exec.agent ? { session: exec.agent.session } : {})
      const target = await ctx.fs.resolve(args.file_path, { cwd: policy.workspaceRoot, signal })
      const info = await ctx.fs.stat(target, signal)
      if (info?.type !== 'file' || info.size === undefined || info.size > config.maxSourceBytes) {
        throw Error('Video source must be an existing regular file within maxSourceBytes')
      }
      await ctx.fs.readByteRange(target, { offset: 0, length: 1 }, signal)
      const source = ctx.fs.processPath(target)
      const metadata = await Media.probeVideo(ctx, config.ffprobePath, source, policy, signal,
        { timeoutMs: config.commandTimeoutMs, graceMs: config.graceMs }, 'video')
      if (metadata.duration_seconds > config.maxDurationSeconds || metadata.width * metadata.height > config.maxSourcePixels) {
        throw Error('Video duration or encoded image area exceeds deployment limits')
      }
      const start = args.start_seconds ?? 0, requestedEnd = args.end_seconds ?? metadata.duration_seconds
      const interval = args.frame_interval_seconds ?? config.ocrFrameIntervalSeconds
      if (!Number.isFinite(start) || start < 0 || start >= metadata.duration_seconds || !Number.isFinite(requestedEnd)
        || requestedEnd <= start || requestedEnd > metadata.duration_seconds || !Number.isFinite(interval)
        || interval < config.ocrMinFrameIntervalSeconds || interval > config.ocrMaxFrameIntervalSeconds) {
        throw Error('OCR range and frame interval are outside deployment bounds')
      }
      const boundedEnd = Math.min(requestedEnd, start + config.ocrMaxRangeSeconds, start + config.ocrMaxFrames * interval)
      const planned = Array.from({ length: Math.min(config.ocrMaxFrames, Math.ceil((boundedEnd - start) / interval)) },
        (_, index) => start + index * interval).filter(timestamp => timestamp < boundedEnd)
      const rawTarget = await ctx.fs.resolve(args.raw_json_path ?? `.muse/video-ocr/${randomUUID()}.json`, { cwd: policy.workspaceRoot, signal })
      const textTarget = await ctx.fs.resolve(args.merged_text_path ?? `.muse/video-ocr/${randomUUID()}.txt`, { cwd: policy.workspaceRoot, signal })
      const root = await ctx.fs.resolve(policy.workspaceRoot, { signal })
      if (!ctx.fs.contains(root, rawTarget) || !ctx.fs.contains(root, textTarget) || rawTarget.displayPath === textTarget.displayPath) {
        throw Error('OCR outputs must be distinct paths inside the current workspace')
      }
      if (await ctx.fs.stat(rawTarget, signal) !== undefined || await ctx.fs.stat(textTarget, signal) !== undefined) {
        throw Error('OCR output paths must not already exist')
      }
      const frames: RawOcrFrame[] = [], failed: number[] = []
      let languageUsed: string | undefined, failureCode: OcrEvidence['failure_code']
      if (config.ocrEngine === 'windows-native' && platform() !== 'win32') {
        failed.push(...planned)
        failureCode = 'windows_only'
      } else {
        const scriptHostPath = ocrBridgeHostPath(import.meta.url, config.ocrEngine)
        const script = ctx.fs.processPathFromHostPath(scriptHostPath)
        if (script === undefined) {
          failed.push(...planned)
          failureCode = 'ocr_runtime_unavailable'
        } else {
          let ffmpeg: string | undefined, executable: string | undefined
          try {
            ffmpeg = await ctx.subprocess.resolveExecutable(config.ffmpegPath, undefined, signal)
            executable = await ctx.subprocess.resolveExecutable(config.ocrEngine === 'rapidocr' ? config.ocrPythonPath : config.powershellPath, undefined, signal)
          } catch {
            signal.throwIfAborted()
            failureCode = 'ocr_runtime_unavailable'
          }
          if (!ffmpeg || !executable) failed.push(...planned)
          else for (let offset = 0; offset < planned.length; offset += config.ocrBatchFrames) {
            const batchPlan = planned.slice(offset, offset + config.ocrBatchFrames)
            let extracted: ExtractedFrame[]
            try {
              extracted = await extractBatch(ctx, config, source, ffmpeg, policy, signal,
                start + offset * interval, batchPlan.length, interval, metadata.duration_seconds)
            }
            catch (error) {
              process.stderr.write('OCR_NATIVE_EXTRACT_FAILURE ' + inspect({ source, start, offset, batchPlan, error }) + '\n')
              signal.throwIfAborted()
              if (error instanceof OcrTimestampOriginError) throw error
              failed.push(...batchPlan)
              continue
            }
            const missing = batchPlan.slice(extracted.length)
            failed.push(...missing)
            let result: BridgeResult
            try {
              result = await runBridge(ctx, config, policy, signal, executable, script,
                args.language ?? config.ocrLanguage, extracted)
            }
            catch {
              signal.throwIfAborted()
              failed.push(...extracted.map(frame => frame.requested_seconds))
              failureCode = 'ocr_runtime_unavailable'
              failed.push(...planned.slice(offset + batchPlan.length))
              break
            }
            if (!result.ok) {
              failed.push(...extracted.map(frame => frame.requested_seconds))
              if (result.code === 'language_unavailable' || result.code === 'ocr_engine_unavailable') {
                failureCode = result.code
                failed.push(...planned.slice(offset + batchPlan.length))
                break
              } else failureCode = 'ocr_runtime_unavailable'
              continue
            }
            languageUsed = result.language_used
            const byId = new Map(extracted.map(frame => [frame.id, frame]))
            for (const frame of result.frames) {
              const extractedFrame = byId.get(frame.id)
              if (!extractedFrame || Math.abs(extractedFrame.timestamp_seconds - frame.timestamp_seconds) > 0.001) continue
              frames.push({ id: frame.id, requested_seconds: extractedFrame.requested_seconds,
                timestamp_seconds: frame.timestamp_seconds, image_width: frame.image_width, image_height: frame.image_height,
                lines: frame.lines })
              byId.delete(frame.id)
            }
            failed.push(...Array.from(byId.values(), frame => frame.requested_seconds))
          }
        }
      }
      frames.sort((left, right) => left.requested_seconds - right.requested_seconds)
      const truncated = boundedEnd < requestedEnd
      const scanStatus: ScanStatus = frames.length === 0 ? 'failed' : failed.length || truncated ? 'partial' : 'complete'
      const segments = classifyAndMerge(frames, { frameIntervalSeconds: interval,
        persistentTextMinFrames: config.ocrPersistentTextMinFrames,
        persistentTextMinSeconds: config.ocrPersistentTextMinSeconds, overlayMinIou: config.ocrOverlayMinIou })
      const status = textStatus(scanStatus, frames, segments)
      const coverage: OcrEvidence['coverage'] = { planned_frame_count: planned.length,
        processed_frame_count: frames.length, failed_frame_count: failed.length, frame_interval_seconds: interval,
        scanned_ranges: scannedRanges(frames, interval, boundedEnd),
        unscanned_ranges: truncated ? [{ start_seconds: boundedEnd, end_seconds: requestedEnd, reason: 'deployment_limit' }] : [],
        failed_timestamps_seconds: failed.sort((left, right) => left - right) }
      const evidence: OcrEvidence = { schema_version: 1, evidence_algorithm: 'decoded-pts-spatial-v2', path: target.displayPath, source_version: info.version,
        duration_seconds: metadata.duration_seconds, text_source: 'ocr', language_requested: args.language ?? config.ocrLanguage,
        ...languageUsed === undefined ? {} : { language_used: languageUsed }, interval: { start_seconds: start, end_seconds: boundedEnd },
        scan_status: scanStatus, text_status: status, coverage, frames, segments,
        ...failureCode === undefined ? {} : { failure_code: failureCode } }
      if ((await ctx.fs.stat(target, signal))?.version !== info.version) throw Error('Video changed during OCR; scan the current source again')
      const raw = JSON.stringify(evidence, null, 2) + '\n', text = mergedText(evidence)
      await ctx.fs.writeText(rawTarget, raw, { kind: 'createIfAbsent' }, signal, policy)
      await ctx.fs.writeText(textTarget, text, { kind: 'createIfAbsent' }, signal, policy)
      if (await ctx.fs.readText(rawTarget, signal) !== raw || await ctx.fs.readText(textTarget, signal) !== text) {
        throw Error('OCR output readback did not match')
      }
      signal.throwIfAborted()
      ctx.emit('fs/observed', target, { kind: 'present', version: info.version }, exec)
      return { path: target.displayPath, source_version: info.version, duration_seconds: metadata.duration_seconds,
        text_source: 'ocr', interval: evidence.interval, scan_status: scanStatus, text_status: status, coverage,
        segment_count: segments.length,
        persistent_text_count: segments.filter(segment => segment.classification === 'persistent_text_candidate').length,
        preview_segments: segments.slice(0, config.ocrPreviewSegments).map(({ evidence_frame_ids, ...segment }) => ({
          ...segment, evidence_frame_count: evidence_frame_ids.length,
        })), raw_json_path: rawTarget.displayPath, raw_json_sha256: createHash('sha256').update(raw).digest('hex'),
        merged_text_path: textTarget.displayPath, language_requested: evidence.language_requested,
        ...languageUsed === undefined ? {} : { language_used: languageUsed },
        ...failureCode === undefined ? {} : { failure_code: failureCode },
        ...boundedEnd < requestedEnd ? { next_start_seconds: boundedEnd } : {} }
    }),
  })), 'video-inspect: local OCR')
}
