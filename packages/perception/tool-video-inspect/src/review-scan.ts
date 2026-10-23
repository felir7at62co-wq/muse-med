/** Whole-video cuts and cumulative image-change candidates; no inferred character identities. */
import type { Context } from '@deepseek-ai/cordis'
import type { SandboxExecutionPolicy } from '@deepseek-ai/dsh-sandbox'
import { runMedia } from './media.ts'
import type { ReviewFrame } from './review-state.ts'

/** Product-owned scan sensitivity and resource budgets, never model-selected. */
export interface ReviewScanConfig {
  reviewAnalysisFps: number
  reviewChangeThreshold: number
  reviewCheckpointSeconds: number
  reviewChunkSeconds: number
  reviewMaxFrames: number
  reviewMaxScanBytes: number
  sceneThreshold: number
  scenePaddingSeconds: number
  commandTimeoutMs: number
  graceMs: number
}

/**
 * Find cumulative appearance changes against the last retained observation.
 * @param bytes - Complete 48 by 32 RGB thumbnail frames.
 * @param config - Product sensitivity and checkpoint frequency.
 * @param start - Source time of the first thumbnail.
 * @param end - Exclusive source interval end.
 * @returns Chronological appearance or continuity candidates.
 */
export function appearanceCandidates(bytes: Uint8Array, config: ReviewScanConfig, start: number, end: number): number[] {
  const size = 48 * 32 * 3
  if (!bytes.length || bytes.length % size !== 0) throw Error('VIDEO_SCAN_INCOMPLETE: thumbnail stream is incomplete')
  const expected = Math.ceil((end - start) * config.reviewAnalysisFps)
  if (Math.abs(bytes.length / size - expected) > 1) throw Error('VIDEO_SCAN_INCOMPLETE: thumbnail coverage does not match the requested interval')
  const times: number[] = [start]
  let anchor = bytes.subarray(0, size), anchorTime = start
  for (let offset = size; offset < bytes.length; offset += size) {
    const time = start + offset / size / config.reviewAnalysisFps
    if (time >= end) break
    const frame = bytes.subarray(offset, offset + size)
    let difference = 0
    const reference = new DataView(anchor.buffer, anchor.byteOffset, anchor.byteLength)
    let pixel = 0
    for (const value of frame) difference += Math.abs(value - reference.getUint8(pixel++))
    if (difference / (size * 255) >= config.reviewChangeThreshold || time - anchorTime >= config.reviewCheckpointSeconds) {
      times.push(time); anchor = frame; anchorTime = time
    }
  }
  return times
}

/**
 * Scan the entire source using every decoded frame for cuts and a separate cumulative appearance pass.
 * @param ctx - Same-world subprocess runtime.
 * @param source - Verified process-local video path.
 * @param duration - Full probed video duration.
 * @param ffmpeg - Resolved media executable.
 * @param config - Product-owned scan parameters.
 * @param policy - Initiator-owned filesystem policy.
 * @param signal - Cancels scanning and awaits process exit.
 * @param progress - Commits each completed interval; no candidate is silently dropped.
 * @returns Every detected candidate plus opening and closing observations.
 */
export async function scanReviewFrames(ctx: Context, source: string, duration: number, ffmpeg: string,
  config: ReviewScanConfig, policy: SandboxExecutionPolicy, signal: AbortSignal,
  progress: (end: number, frames: ReviewFrame[]) => void): Promise<ReviewFrame[]> {
  const candidates = new Map<number, { reasons: Set<string>; decode?: { start_seconds: number; frame_index: number } }>()
  const add = (time: number, reason: string, decode?: { start_seconds: number; frame_index: number }) => {
    const key = Math.round(Math.max(0, Math.min(duration - 0.001, time)) * 1_000_000) / 1_000_000
    const entry = candidates.get(key) ?? { reasons: new Set<string>() }; entry.reasons.add(reason)
    candidates.set(key, decode === undefined ? entry : { ...entry, decode })
    if (candidates.size > config.reviewMaxFrames) throw Error('VIDEO_SCAN_LIMIT: too many detected changes; increase the deployment budget, do not truncate the episode')
  }
  const frames = (): ReviewFrame[] => [...candidates].sort(([left], [right]) => left - right)
    .map(([time, entry], index) => ({ id: `F${String(index + 1).padStart(5, '0')}`, time, reasons: [...entry.reasons],
      exposed: false, ...entry.decode === undefined ? {} : { decode: entry.decode } }))
  add(0, 'opening')
  let closing = 0
  for (let start = 0; start < duration; start += config.reviewChunkSeconds) {
    signal.throwIfAborted()
    const end = Math.min(duration, start + config.reviewChunkSeconds)
    const maxLocalTime = end - start + 0.001
    const common = [ffmpeg, '-nostdin', '-hide_banner', '-v', 'error', '-protocol_whitelist', 'file,pipe',
      '-ss', String(start), '-i', source, '-t', String(end - start), '-map', '0:v:0', '-an', '-sn', '-dn']
    const limits = { timeoutMs: config.commandTimeoutMs, graceMs: config.graceMs }
    // Output -t does not bound upstream filter metadata or thumbnail lookahead.
    // Keep the boundary frame for cut continuity without admitting later frames.
    const cuts = await runMedia(ctx, [...common, '-vf',
      `scale=320:-2,select='gte(scene,0)*lt(t,${maxLocalTime})',metadata=print:file=-`, '-f', 'null', '-'], policy, signal,
    { ...limits, maxBytes: config.reviewMaxScanBytes })
    const scores = new TextDecoder('utf-8', { fatal: true }).decode(cuts.bytes)
    let seen = false
    for (const row of scores.matchAll(/frame:\s*(\d+)\s+pts:\s*\S+\s+pts_time:(\S+)[^\n]*\r?\n\s*lavfi\.scene_score=([\d.e+-]+)/g)) {
      const index = Number(row[1]), local = Number(row[2]), score = Number(row[3])
      if (!Number.isSafeInteger(index) || !Number.isFinite(local) || !Number.isFinite(score) || local < 0 || local >= maxLocalTime) throw Error('VIDEO_SCAN_INCOMPLETE: invalid decoded timecode')
      seen = true; closing = Math.max(closing, start + local)
      if (score > config.sceneThreshold) {
        add(start + local - config.scenePaddingSeconds, 'before_cut')
        add(start + local, 'cut', { start_seconds: start, frame_index: index })
        add(start + local + config.scenePaddingSeconds, 'after_cut')
      }
    }
    if (!seen) throw Error('VIDEO_SCAN_INCOMPLETE: no decoded frame metadata for scan interval')
    const thumbnails = await runMedia(ctx, [...common, '-vf',
      `fps=${config.reviewAnalysisFps},select='lt(t,${maxLocalTime})',scale=48:32,format=rgb24`, '-fps_mode', 'passthrough', '-f', 'rawvideo', 'pipe:1'], policy, signal,
    { ...limits, maxBytes: Math.ceil(config.reviewChunkSeconds * config.reviewAnalysisFps + 2) * 48 * 32 * 3 })
    for (const time of appearanceCandidates(thumbnails.bytes, config, start, end)) add(time, 'appearance_or_continuity')
    progress(end, frames())
  }
  for (const time of [...candidates.keys()]) if (time > closing) candidates.delete(time)
  add(Math.max(0, closing - 0.000001), 'closing')
  return frames()
}
