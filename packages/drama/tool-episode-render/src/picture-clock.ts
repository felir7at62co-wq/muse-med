/** The measured, zero-based picture clock shared by a native render and editable draft. */
import { HarnessError } from '@deepseek-ai/dsh-llm'
import { z } from 'zod'
import { MediaCommandError } from './ffmpeg.ts'
import type { MediaToolkit, TimelineClip } from './types.ts'

const microsecondsPerSecond = 1_000_000
const maxSeconds = 120
const maxFrames = 7_200
const frameIndex = z.number().int().nonnegative()

function roundNearestEven(value: number): number {
  const nearest = Math.round(value)
  return nearest - value === 0.5 && nearest % 2 !== 0 ? nearest - 1 : nearest
}

/** Preserve an exactly serialized frame cut, otherwise select the first frame at or after the authored cut. */
export function deliveryFrameAtUs(timeUs: number, fps: number): number {
  const frames = timeUs * fps / microsecondsPerSecond
  const nearest = roundNearestEven(frames)
  return deliveryFrameTimeUs(nearest, fps) === timeUs ? nearest : Math.ceil(frames)
}

/** Project an absolute delivery frame boundary onto the editor's microsecond grid. */
export function deliveryFrameTimeUs(frame: number, fps: number): number {
  return roundNearestEven(frame * microsecondsPerSecond / fps)
}

/** Schema shared by source and draft receipts. A field's presence is a measured claim. */
export const deliveryPictureClockSchema = z.strictObject({
  status: z.literal('verified_cfr'),
  evidence: z.literal('verified_segment_frames_and_output_pts'),
  fps: z.number().int().positive(),
  body_end_frame: z.number().int().positive(),
  body_end_us: z.number().int().positive(),
  total_frames: z.number().int().positive(),
  clips: z.array(z.strictObject({
    shot: z.number().int().positive(), start_frame: frameIndex, end_frame: z.number().int().positive(),
    start_us: frameIndex, duration_us: z.number().int().positive(),
  })).min(1).max(maxFrames),
}).refine((clock) => {
  if (clock.total_frames > maxFrames || clock.total_frames > maxSeconds * clock.fps || clock.body_end_frame > clock.total_frames
    || clock.body_end_us !== deliveryFrameTimeUs(clock.body_end_frame, clock.fps)) return false
  let previousEnd = 0
  for (const [index, clip] of clock.clips.entries()) {
    if (clip.shot !== index + 1 || clip.start_frame !== previousEnd || clip.end_frame <= previousEnd
      || clip.end_frame > clock.body_end_frame || clip.start_us !== deliveryFrameTimeUs(clip.start_frame, clock.fps)
      || clip.start_us + clip.duration_us !== deliveryFrameTimeUs(clip.end_frame, clock.fps)) return false
    previousEnd = clip.end_frame
  }
  return previousEnd === clock.body_end_frame
}, '成片画面时钟的帧边界或微秒边界不连续。')

/** Timing facts shared by the native MP4 and editable draft. */
export type DeliveryPictureClock = z.infer<typeof deliveryPictureClockSchema>

/**
 * Plan a bounded exact cut sequence from absolute prepared timeline boundaries.
 * @param clips - Ordered body clips from prepare.
 * @param fps - Integer delivery frame rate.
 * @param endingSeconds - Product ending duration, or zero for a body-only delivery.
 * @returns The expected grid, or undefined for timelines without a bounded, contiguous grid.
 */
export function planDeliveryPictureClock(clips: readonly TimelineClip[], fps: number,
  endingSeconds: number): DeliveryPictureClock | undefined {
  if (!Number.isSafeInteger(fps) || fps <= 0) return undefined
  let previousEndUs = 0
  const rows: DeliveryPictureClock['clips'] = []
  for (const clip of clips) {
    const endUs = clip.startUs + clip.durationUs
    if (clip.startUs !== previousEndUs || endUs > maxSeconds * microsecondsPerSecond || rows.length === maxFrames) return undefined
    previousEndUs = endUs
    const startFrame = deliveryFrameAtUs(clip.startUs, fps)
    const endFrame = deliveryFrameAtUs(endUs, fps)
    const start = deliveryFrameTimeUs(startFrame, fps)
    rows.push({ shot: clip.shot, start_frame: startFrame, end_frame: endFrame,
      start_us: start, duration_us: deliveryFrameTimeUs(endFrame, fps) - start })
  }
  const bodyEndFrame = deliveryFrameAtUs(previousEndUs, fps)
  const result = deliveryPictureClockSchema.safeParse({ status: 'verified_cfr', evidence: 'verified_segment_frames_and_output_pts',
    fps, body_end_frame: bodyEndFrame, body_end_us: deliveryFrameTimeUs(bodyEndFrame, fps),
    total_frames: bodyEndFrame + endingSeconds * fps, clips: rows })
  return result.success ? result.data : undefined
}

const rate = z.string().regex(/^[1-9]\d{0,8}\/[1-9]\d{0,8}$/u).transform((text) => {
  const separator = text.indexOf('/')
  return [BigInt(text.slice(0, separator)), BigInt(text.slice(separator + 1))] as const
})
const clockProbeSchema = z.object({
  streams: z.tuple([z.object({ time_base: rate, avg_frame_rate: rate, r_frame_rate: rate,
    duration_ts: frameIndex, nb_frames: z.string().regex(/^\d{1,5}$/u) })]),
  frames: z.array(z.object({ pts: frameIndex })).min(1).max(maxFrames),
})

/**
 * Check every decoded picture PTS, the frame count, and stream duration against one CFR grid.
 * @param toolkit - Configured binaries and managed process channel.
 * @param path - Local encoded MP4 to measure.
 * @param fps - Expected integer constant frame rate.
 * @param frames - Expected frame count on this clip's zero-based clock.
 */
export async function requirePictureFrameGrid(toolkit: MediaToolkit, path: string, fps: number, frames: number): Promise<void> {
  const args = ['-v', 'error', '-protocol_whitelist', 'file', '-f', 'mov', '-enable_drefs', '0', '-select_streams', 'v:0',
    '-read_intervals', `%+${String(maxSeconds + 1)}`, '-show_streams', '-show_frames',
    '-show_entries', 'stream=time_base,avg_frame_rate,r_frame_rate,duration_ts,nb_frames:frame=pts', '-of', 'json=compact=1', path]
  const outcome = await toolkit.channel.run(toolkit.ffprobe, args)
  if (outcome.code !== 0) throw new MediaCommandError(toolkit.ffprobe, args, outcome.code, outcome.stderr)
  let report: unknown
  try {
    report = JSON.parse(outcome.stdout)
  } catch (error) {
    throw new HarnessError('无法读取实际画面时间戳，请重新渲染并复验。', 'RENDER_FRAME_CLOCK', { cause: error })
  }
  const parsed = clockProbeSchema.safeParse(report)
  if (outcome.stderr.trim() !== '' || !parsed.success) {
    throw new HarnessError('实际画面缺少完整或可解码的时间戳，请重新渲染并复验。', 'RENDER_FRAME_CLOCK')
  }
  const stream = parsed.data.streams[0]
  const [baseNum, baseDen] = stream.time_base
  const [avgNum, avgDen] = stream.avg_frame_rate
  const [nominalNum, nominalDen] = stream.r_frame_rate
  const exactFps = BigInt(fps)
  if (avgNum !== exactFps * avgDen || nominalNum !== exactFps * nominalDen
    || parsed.data.frames.length !== frames || Number(stream.nb_frames) !== frames
    || BigInt(stream.duration_ts) * baseNum * exactFps !== BigInt(frames) * baseDen
    || parsed.data.frames.some(({ pts }, index) => BigInt(pts) * baseNum * exactFps !== BigInt(index) * baseDen)) {
    throw new HarnessError('实际画面的帧数或时间戳与交付时间线不一致，请重新渲染并复验。', 'RENDER_FRAME_CLOCK')
  }
}

/**
 * Recheck the complete final MP4 against the native delivery receipt.
 * @param toolkit - Configured binaries and managed process channel.
 * @param output - Exact native MP4 paired with the draft.
 * @param clock - Validated record of the expected cuts and final clock.
 */
export async function requireRenderedPicturePts(toolkit: MediaToolkit, output: string, clock: DeliveryPictureClock): Promise<void> {
  await requirePictureFrameGrid(toolkit, output, clock.fps, clock.total_frames)
}
