/**
 * Adaptive speech detection over one clip's own audio.
 *
 * A clip's noise floor belongs to the render that produced it, not to this
 * package: provider encoder noise can sit above any fixed `silencedetect`
 * level, and then every frame of the clip reads as speech and the line split
 * silently falls back to counting characters. The floor is estimated from the
 * clip instead and the level follows from it, so one implementation decides
 * correctly on a quiet studio mix and on a noisy provider render.
 *
 * The analysis decodes to mono PCM at {@link VAD_SAMPLE_RATE}, measures each
 * {@link VAD_FRAME_MILLISECONDS} frame, and takes the clip's own
 * {@link VAD_FLOOR_PERCENTILE} percentile as its floor.
 *
 * @module @deepseek-ai/dsh-tool-episode-render/vad
 */

import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { MediaToolkit } from './types.ts'

/** Rate the analysis decodes to before measuring. */
export const VAD_SAMPLE_RATE = 16_000

/** Frame length and stride in milliseconds; frames do not overlap. */
export const VAD_FRAME_MILLISECONDS = 20

/** Percentile of the frame levels taken as the clip's noise floor. */
export const VAD_FLOOR_PERCENTILE = 20

/** Decibels a frame must rise above the floor to count as speech. */
export const VAD_MARGIN_DB = 12

/** Lowest level the margin may derive, so a nearly silent clip cannot make clicks speech. */
export const VAD_MIN_THRESHOLD_DB = -45

/** Shortest stretch kept as speech. */
export const VAD_MIN_RUN_SECONDS = 0.25

/** Silent gap short enough to belong to the same utterance. */
export const VAD_MERGE_GAP_SECONDS = 0.3

/** One stretch of a clip in which speech is present, in seconds from the clip's start. */
export interface SpeechRegion {
  /** Region start, seconds from the clip start. */
  readonly startSeconds: number
  /** Region end, seconds from the clip start. */
  readonly endSeconds: number
}

/** What one clip's detection measured. */
export interface SpeechDetection {
  /** Speaking stretches in time order, clamped to the clip's declared duration. */
  readonly regions: readonly SpeechRegion[]
  /** The clip's own noise floor, in dBFS. */
  readonly floorDb: number
  /** The level derived from that floor, in dBFS. */
  readonly thresholdDb: number
  /** Frames the analysis measured. */
  readonly frames: number
}

/** Read one little-endian 16-bit sample. */
function sampleAt(bytes: Buffer, index: number): number {
  return bytes.readInt16LE(index * 2) / 32_768
}

/**
 * Measure every frame's level in dBFS.
 *
 * A frame's level is the RMS of its samples; the `1e-12` floors keep digital
 * silence finite instead of negative infinity.
 * @param samples - Decoded mono samples, in the range -1 to 1.
 * @param frameSamples - Samples per frame.
 * @returns One level per whole frame, in time order; a trailing partial frame is dropped.
 */
export function frameLevelsDb(samples: readonly number[], frameSamples: number): number[] {
  if (frameSamples <= 0 || !Number.isInteger(frameSamples)) throw new Error('VAD 帧长必须是正整数采样数。')
  const frames = Math.max(1, Math.floor(samples.length / frameSamples))
  const levels: number[] = []
  for (let frame = 0; frame < frames; frame += 1) {
    let energy = 0
    const from = frame * frameSamples
    for (let index = from; index < from + frameSamples; index += 1) {
      const value = samples[index] ?? 0
      energy += value * value
    }
    levels.push(20 * Math.log10(Math.sqrt(energy / frameSamples + 1e-12) + 1e-12))
  }
  return levels
}

/**
 * Read one percentile of a level list, interpolating between neighbours.
 * @param levels - Measured levels in any order.
 * @param percent - Percentile to read, from 0 to 100.
 * @returns The interpolated level.
 * @throws {Error} When the list is empty or the percentile is out of range.
 */
export function levelPercentile(levels: readonly number[], percent: number): number {
  if (levels.length === 0) throw new Error('VAD 没有可统计的帧。')
  if (!Number.isFinite(percent) || percent < 0 || percent > 100) throw new Error('VAD 百分位必须在 0 到 100 之间。')
  const sorted = [...levels].sort((left, right) => left - right)
  const position = ((sorted.length - 1) * percent) / 100
  const lower = Math.floor(position)
  const upper = Math.ceil(position)
  const low = sorted[lower] ?? 0
  const high = sorted[upper] ?? low
  return low + (high - low) * (position - lower)
}

/**
 * Derive the level above which a frame counts as speech.
 *
 * The margin keeps the decision relative to the clip; the ceiling keeps a clip
 * with almost no content from turning its own dither into speech.
 * @param floorDb - The clip's measured noise floor.
 * @returns The threshold in dBFS.
 */
export function speechThresholdDb(floorDb: number): number {
  if (!Number.isFinite(floorDb)) throw new Error('VAD 噪声底不是有效数值。')
  return Math.max(floorDb + VAD_MARGIN_DB, VAD_MIN_THRESHOLD_DB)
}

/**
 * Turn frame levels into speaking stretches.
 *
 * Runs separated by less than {@link VAD_MERGE_GAP_SECONDS} are one utterance
 * and are merged before the {@link VAD_MIN_RUN_SECONDS} filter, so a short
 * breath inside a line does not split it.
 * @param levels - Frame levels in time order.
 * @param frameSeconds - Seconds one frame covers.
 * @param thresholdDb - Level a frame must exceed to count as speech.
 * @returns The speaking stretches, in time order.
 */
export function speechRuns(
  levels: readonly number[],
  frameSeconds: number,
  thresholdDb: number,
): SpeechRegion[] {
  if (!Number.isFinite(frameSeconds) || frameSeconds <= 0) throw new Error('VAD 帧时长必须大于零。')
  const raw: SpeechRegion[] = []
  let open: number | undefined
  for (const [index, level] of levels.entries()) {
    const loud = level > thresholdDb
    if (loud && open === undefined) open = index
    if (!loud && open !== undefined) {
      raw.push({ startSeconds: open * frameSeconds, endSeconds: index * frameSeconds })
      open = undefined
    }
  }
  if (open !== undefined) raw.push({ startSeconds: open * frameSeconds, endSeconds: levels.length * frameSeconds })
  const merged: { startSeconds: number; endSeconds: number }[] = []
  for (const run of raw) {
    const previous = merged[merged.length - 1]
    if (previous !== undefined && run.startSeconds - previous.endSeconds < VAD_MERGE_GAP_SECONDS) {
      previous.endSeconds = run.endSeconds
      continue
    }
    merged.push({ startSeconds: run.startSeconds, endSeconds: run.endSeconds })
  }
  return merged.filter(run => run.endSeconds - run.startSeconds >= VAD_MIN_RUN_SECONDS)
}

/**
 * Detect one clip's speaking stretches from decoded audio.
 * @param samples - Decoded mono samples, in the range -1 to 1.
 * @param sampleRate - The rate the samples were decoded at.
 * @param totalSeconds - The clip's declared duration, which clamps a trailing region.
 * @returns The regions plus the floor and threshold they were measured against.
 */
export function detectSpeech(samples: readonly number[], sampleRate: number, totalSeconds: number): SpeechDetection {
  const frameSamples = Math.max(1, Math.round((sampleRate * VAD_FRAME_MILLISECONDS) / 1000))
  const frameSeconds = frameSamples / sampleRate
  const levels = frameLevelsDb(samples, frameSamples)
  const floorDb = levelPercentile(levels, VAD_FLOOR_PERCENTILE)
  const thresholdDb = speechThresholdDb(floorDb)
  const limit = Number.isFinite(totalSeconds) && totalSeconds > 0 ? totalSeconds : Infinity
  const regions = speechRuns(levels, frameSeconds, thresholdDb)
    .map(run => ({ startSeconds: Math.min(run.startSeconds, limit), endSeconds: Math.min(run.endSeconds, limit) }))
    .filter(run => run.endSeconds > run.startSeconds)
  return { regions, floorDb, thresholdDb, frames: levels.length }
}

/**
 * Decode one clip to mono PCM at {@link VAD_SAMPLE_RATE}.
 *
 * The samples go to a file rather than a pipe: the sandbox rejects a child
 * process's pipes, and the file keeps the same bytes.
 * @param toolkit - The binaries and channel to use.
 * @param file - Absolute path of the clip to decode.
 * @returns The samples, in the range -1 to 1.
 * @throws {Error} When ffmpeg fails or writes nothing.
 */
export async function decodeMonoSamples(toolkit: MediaToolkit, file: string): Promise<number[]> {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-drama-vad-'))
  const pcmPath = join(directory, 'audio.s16le')
  try {
    const outcome = await toolkit.channel.run(toolkit.ffmpeg, [
      '-v', 'error', '-y', '-i', file, '-vn', '-ac', '1', '-ar', String(VAD_SAMPLE_RATE),
      '-f', 's16le', pcmPath,
    ])
    if (outcome.code !== 0) {
      throw new Error(`发声检测失败：${file}（${outcome.stderr.trim()}）。`
        + '请确认该镜的成片可完整解码后重试。')
    }
    const bytes = await readFile(pcmPath)
    const count = bytes.length >> 1
    const samples = new Array<number>(count)
    for (let index = 0; index < count; index += 1) samples[index] = sampleAt(bytes, index)
    return samples
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

/**
 * Detect one clip's speaking stretches from its own audio.
 * @param toolkit - The binaries and channel to use.
 * @param file - Absolute path of the clip whose audio carries this shot's dialogue.
 * @param totalSeconds - The clip's probed duration.
 * @returns The regions plus the floor and threshold they were measured against.
 * @throws {Error} When the decode or the measurement fails.
 */
export async function detectSpeechRegions(
  toolkit: MediaToolkit,
  file: string,
  totalSeconds: number,
): Promise<SpeechDetection> {
  return detectSpeech(await decodeMonoSamples(toolkit, file), VAD_SAMPLE_RATE, totalSeconds)
}
