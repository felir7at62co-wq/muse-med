/** Read bounded picture-clock evidence from two local MP4s at preselected times. */
import { lstat, mkdtemp, readFile, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { extname, isAbsolute, join } from 'node:path'
import { z } from 'zod'
import { captureFfmpeg } from './ffmpeg.ts'
import { pictureClockFeatures, pictureFeatureDifference } from './source-clock-conform.ts'
import type { MediaToolkit } from './types.ts'

const localMp4 = ['-protocol_whitelist', 'file', '-f', 'mov', '-enable_drefs', '0'] as const
const maxDuration = 120
const maxFileBytes = 1024 ** 3
const maxPixels = 4_194_304
const maxSamples = 3
const maxFrames = 64
const activitySeconds = 0.4
const clockPrecision = 0.000002

const streamProbe = z.object({
  streams: z.tuple([z.object({
    width: z.number().int().positive(),
    height: z.number().int().positive(),
    start_time: z.string(),
    duration: z.string(),
    r_frame_rate: z.string(),
    sample_aspect_ratio: z.string().optional(),
    side_data_list: z.array(z.object({ rotation: z.number().optional() })).optional(),
  })]),
})

/** A supplied comparison time in each exact MP4, relative to zero-based picture time. */
export interface PictureClockSample {
  readonly referenceSeconds: number
  readonly outputSeconds: number
}

type PictureClockStatus = 'matching' | 'mismatched' | 'unverified'

/** Recorded picture evidence for one preselected comparison. */
export interface PictureClockSampleResult extends PictureClockSample {
  readonly status: PictureClockStatus
  readonly reason: 'compared' | 'stationary_reference' | 'unavailable'
  readonly referencePtsSeconds: number | null
  readonly outputPtsSeconds: number | null
  readonly meanDifference: number | null
  readonly maximumTileDifference: number | null
}

/** Result for the supplied times, which do not establish continuous lip sync. */
export interface PictureClockReport {
  readonly status: PictureClockStatus
  readonly samples: readonly PictureClockSampleResult[]
}

interface PictureCrop {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}

interface PictureSource {
  readonly path: string
  readonly aspect: number
  readonly duration: number
  readonly frameSeconds: number
  readonly featureFilter: string
}

interface Window {
  readonly bytes: Buffer
  readonly times: readonly number[]
}

function unavailable(sample: PictureClockSample, referencePtsSeconds: number | null = null,
  reason: PictureClockSampleResult['reason'] = 'unavailable'): PictureClockSampleResult {
  return { ...sample, status: 'unverified', reason, referencePtsSeconds, outputPtsSeconds: null,
    meanDifference: null, maximumTileDifference: null }
}

async function readPictureSource(toolkit: MediaToolkit, file: string,
  signal?: AbortSignal, crop?: PictureCrop): Promise<PictureSource> {
  if (!isAbsolute(file) || extname(file).toLowerCase() !== '.mp4') throw Error('需要本地 MP4。')
  const path = await realpath(file)
  const info = await lstat(path)
  if (!info.isFile() || info.size <= 0 || info.size > maxFileBytes) throw Error('视频文件大小不受支持。')
  signal?.throwIfAborted()
  const result = await toolkit.channel.run(toolkit.ffprobe, ['-v', 'error', ...localMp4,
    '-select_streams', 'v:0', '-show_entries',
    'stream=width,height,start_time,duration,r_frame_rate,sample_aspect_ratio:stream_side_data=rotation', '-of', 'json', path])
  signal?.throwIfAborted()
  if (result.code !== 0) throw Error('无法读取画面时钟。')
  const [stream] = streamProbe.parse(JSON.parse(result.stdout)).streams
  const rate = /^([1-9]\d{0,6})\/([1-9]\d{0,6})$/u.exec(stream.r_frame_rate)
  const fps = rate === null ? 0 : Number(rate[1]) / Number(rate[2])
  const duration = Number(stream.duration)
  const pixelShape = /^([1-9]\d{0,8}):([1-9]\d{0,8})$/u.exec(stream.sample_aspect_ratio ?? 'N/A')
  const pixelAspect = pixelShape !== null ? Number(pixelShape[1]) / Number(pixelShape[2])
    : [undefined, 'N/A'].includes(stream.sample_aspect_ratio) ? 1 : 0
  if (!stream.start_time || Number(stream.start_time) !== 0 || !Number.isFinite(duration) || duration <= 0
    || duration > maxDuration || fps < 12 || fps > 60 || stream.width * stream.height > maxPixels
    // Production scale/crop can leave a small rounding difference in the MP4 pixel aspect.
    || Math.abs(pixelAspect - 1) > 0.005
    || stream.side_data_list?.some(item => item.rotation !== undefined && item.rotation !== 0)) {
    throw Error('画面规格或时钟不受支持。')
  }
  const source = { path, aspect: stream.width / stream.height * pixelAspect, duration,
    frameSeconds: 1 / fps, featureFilter: pictureClockFeatures.filter }
  if (crop === undefined) return source
  const { x, y, width, height } = crop
  if (![x, y, width, height].every(value => Number.isSafeInteger(value) && value % 2 === 0)
    || x < 0 || y < 0 || width < 2 || height < 2 || width > stream.width - x || height > stream.height - y) {
    throw Error('画面抽查的裁切范围无效。')
  }
  return { ...source, aspect: width / height * pixelAspect,
    featureFilter: `crop=${String(width)}:${String(height)}:${String(x)}:${String(y)},${source.featureFilter}` }
}

function frameTimes(stderr: string): number[] {
  const timeBase = /\bconfig in time_base:\s*([1-9]\d{0,6})\/([1-9]\d{0,8})/u.exec(stderr)
  if (timeBase === null) throw Error('缺少取样画面时基。')
  const times: number[] = []
  for (const frame of stderr.matchAll(/\bn:\s*(\d+)\s+pts:\s*(\d+)\s+pts_time:[^\r\n]*?\bfmt:rgb24\b[^\r\n]*?\bs:(\d+)x(\d+)/gu)) {
    const pts = Number(frame[2])
    const time = pts * Number(timeBase[1]) / Number(timeBase[2])
    const previous = times.at(-1)
    if (Number(frame[1]) !== times.length || !Number.isSafeInteger(pts) || (previous !== undefined && time <= previous)
      || Number(frame[3]) !== pictureClockFeatures.size || Number(frame[4]) !== pictureClockFeatures.size) {
      throw Error('取样画面时点或规格不符。')
    }
    times.push(time)
  }
  return times
}

async function decodeWindow(toolkit: MediaToolkit, source: PictureSource, path: string, center: number, radius: number,
  signal?: AbortSignal): Promise<Window> {
  const start = Math.max(0, center - radius)
  const end = Math.min(source.duration, center + radius)
  if (end <= start || center >= source.duration) throw Error('指定时点不在画面内。')
  const seek = Math.max(0, start - source.frameSeconds)
  signal?.throwIfAborted()
  const result = await captureFfmpeg(toolkit, ['-n', '-nostdin', '-v', 'info', '-xerror', '-copyts', '-noautorotate',
    ...localMp4, '-threads', '2', '-ss', seek.toFixed(6), '-t', (end - seek + source.frameSeconds).toFixed(6),
    '-i', source.path, '-map', '0:v:0', '-an', '-sn', '-dn', '-filter_threads', '1',
    '-vf', `trim=start=${start.toFixed(6)}:end=${end.toFixed(6)},${source.featureFilter},showinfo`,
    '-fps_mode', 'passthrough', '-frames:v', String(maxFrames), '-c:v', 'rawvideo', '-threads', '1', '-f', 'rawvideo', path])
  signal?.throwIfAborted()
  if (result.code !== 0) throw Error('无法解码选定的画面窗。')
  const times = frameTimes(result.stderr)
  const size = times.length * pictureClockFeatures.bytes
  const info = await lstat(path)
  // FFmpeg trim rounds each limit to its filter time base. Comparisons below use the reported PTS.
  const trimPrecision = source.frameSeconds + clockPrecision
  if (times.length === 0 || times.length >= maxFrames || !info.isFile() || info.size !== size
    || times.some(time => time < start - trimPrecision || time > end + trimPrecision)) {
    throw Error('画面取样缺失或实际时间不符。')
  }
  const bytes = await readFile(path, { signal })
  if (bytes.length !== size) throw Error('读取期间画面取样大小发生变化。')
  return { bytes, times }
}

function closestIndex(times: readonly number[], center: number): number {
  let best = 0, distance = Infinity
  for (const [index, time] of times.entries()) {
    const difference = Math.abs(time - center)
    if (difference < distance - clockPrecision) {
      best = index
      distance = difference
    }
  }
  return best
}

type PictureDifference = ReturnType<typeof pictureFeatureDifference>

function score(difference: PictureDifference, limits: readonly [number, number]): number {
  return Math.max(difference.meanDifference / limits[0], difference.maximumTileDifference / limits[1])
}

async function compareSample(toolkit: MediaToolkit, reference: PictureSource, output: PictureSource,
  sample: PictureClockSample, directory: string, index: number, signal?: AbortSignal): Promise<PictureClockSampleResult> {
  let referencePts: number | null = null
  try {
    const before = await decodeWindow(toolkit, reference, join(directory, `reference-${String(index)}.rgb`),
      sample.referenceSeconds, activitySeconds + reference.frameSeconds, signal)
    const frame = closestIndex(before.times, sample.referenceSeconds)
    const time = before.times[frame]
    const tolerance = reference.frameSeconds + clockPrecision
    if (time === undefined || Math.abs(time - sample.referenceSeconds) > tolerance) return unavailable(sample)
    referencePts = time
    const activity = before.times.some((observed, candidate) => Math.abs(observed - time) >= activitySeconds / 2
      && score(pictureFeatureDifference(before.bytes, frame, before.bytes, candidate), pictureClockFeatures.repeated) > 1)
    if (!activity) return unavailable(sample, time, 'stationary_reference')
    const after = await decodeWindow(toolkit, output, join(directory, `output-${String(index)}.rgb`),
      sample.outputSeconds, tolerance + output.frameSeconds, signal)
    const alignedTime = sample.outputSeconds + time - sample.referenceSeconds
    let best: { pts: number; difference: PictureDifference; score: number } | undefined
    for (const [candidate, pts] of after.times.entries()) {
      if (Math.abs(pts - sample.outputSeconds) > tolerance || Math.abs(pts - alignedTime) > tolerance) continue
      const difference = pictureFeatureDifference(before.bytes, frame, after.bytes, candidate)
      const value = score(difference, pictureClockFeatures.paired)
      if (best === undefined || value < best.score
        || (value === best.score && Math.abs(pts - alignedTime) < Math.abs(best.pts - alignedTime))) {
        best = { pts, difference, score: value }
      }
    }
    if (best === undefined) return unavailable(sample, time)
    return { ...sample, ...best.difference, status: best.score <= 1 ? 'matching' : 'mismatched',
      reason: 'compared', referencePtsSeconds: time, outputPtsSeconds: best.pts }
  } catch (_error) {
    signal?.throwIfAborted()
    return unavailable(sample, referencePts)
  }
}

/**
 * Compare up to three supplied times using measured frame timestamps and upper-picture features.
 * @param toolkit - Media binaries and the caller-owned process channel.
 * @param input - Authorized local MP4 paths, fixed time pairs, and an optional reference crop in source pixels.
 * @param signal - Cancels the comparison; the toolkit channel owns cancellation of its active subprocess.
 * @returns Sampled evidence. Untestable or stationary reference windows stay unverified.
 */
export async function measurePictureClock(toolkit: MediaToolkit, input: {
  readonly reference: string
  readonly output: string
  readonly samples: readonly PictureClockSample[]
  readonly referenceCrop?: PictureCrop
}, signal?: AbortSignal): Promise<PictureClockReport> {
  signal?.throwIfAborted()
  if (input.samples.length === 0 || input.samples.length > maxSamples) return { status: 'unverified', samples: [] }
  const pending = (): PictureClockReport => ({ status: 'unverified', samples: input.samples.map(sample => unavailable(sample)) })
  if (input.samples.some(({ referenceSeconds, outputSeconds }) =>
    ![referenceSeconds, outputSeconds].every(time => Number.isFinite(time) && time >= 0 && time <= maxDuration))) {
    return pending()
  }
  try {
    const reference = await readPictureSource(toolkit, input.reference, signal, input.referenceCrop)
    const output = await readPictureSource(toolkit, input.output, signal)
    if (Math.abs(reference.aspect / output.aspect - 1) > 0.02) return pending()
    const directory = await mkdtemp(join(tmpdir(), 'dsh-picture-readback-'))
    try {
      const samples: PictureClockSampleResult[] = []
      for (const [index, sample] of input.samples.entries()) {
        samples.push(await compareSample(toolkit, reference, output, sample, directory, index, signal))
      }
      signal?.throwIfAborted()
      const status = samples.some(sample => sample.status === 'mismatched') ? 'mismatched'
        : samples.every(sample => sample.status === 'matching') ? 'matching' : 'unverified'
      return { status, samples }
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  } catch (_error) {
    signal?.throwIfAborted()
    return pending()
  }
}
