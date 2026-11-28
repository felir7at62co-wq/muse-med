/** Pair an audited processed picture with its original, fully retained sound clock. */
import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { copyFile, lstat, mkdir, mkdtemp, readFile, realpath, rm, rmdir } from 'node:fs/promises'
import { extname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { z } from 'zod'
import { fileSha256 } from './cache.ts'
import { captureFfmpeg, firstStreamOfType, MediaCommandError, probeMedia, runFfmpeg } from './ffmpeg.ts'
import { episodeNumberOf } from './paths.ts'
import type { MediaToolkit } from './types.ts'

const mp4Input = ['-protocol_whitelist', 'file', '-f', 'mov', '-enable_drefs', '0']
const maxDuration = 120
const maxFrames = maxDuration * 60
const featureSize = 48
const tileSize = featureSize / 4
/** FFmpeg extraction and comparison settings shared by picture verification. */
export const pictureClockFeatures = {
  size: featureSize,
  bytes: featureSize ** 2 * 3,
  filter: `crop=iw:trunc(ih/3)*2:0:0,scale=${featureSize}:${featureSize}:flags=area,format=rgb24`,
  paired: [8, 24],
  repeated: [4, 16],
} as const
const featureBytes = pictureClockFeatures.bytes
const file = z.strictObject({ path: z.string().min(1), sha256: z.hash('sha256') })
const rateText = z.string().regex(/^[1-9]\d{0,6}\/[1-9]\d{0,6}$/u)

/** Exact native conform result. Provider source identity and visual observations require separate checks. */
export const sourceClockConformBindingSchema = z.strictObject({
  version: z.literal(1), project: z.string().min(1), episode: z.string().regex(/^\d{2,}$/u),
  original: file, processed: file, output: file,
  clock: z.strictObject({ originalRate: rateText, processedRate: rateText,
    originalFrames: z.number().int().positive(), processedFrames: z.number().int().positive(), mappingSha256: z.hash('sha256') }),
  audio: z.strictObject({ sha256: z.hash('sha256'), sampleRate: z.number().int().positive(), channels: z.number().int().positive(),
    packetsSha256: z.hash('sha256') }),
})
/** Source digests, frame mapping and original audio evidence bound to the new candidate. */
export type SourceClockConformBinding = z.infer<typeof sourceClockConformBindingSchema>
/** Project-owned original and processed MP4 identities for a new clock-bound candidate. */
export interface SourceClockConformArgs {
  readonly project: string
  readonly episode: number
  readonly original: SourceClockConformBinding['original']
  readonly processed: SourceClockConformBinding['processed']
}

interface Rate { readonly num: bigint; readonly den: bigint }
interface VideoClock { readonly rate: Rate; readonly rateString: string; readonly count: number }
const exactRate = (text: string): Rate => {
  const separator = text.indexOf('/')
  return { num: BigInt(text.slice(0, separator)), den: BigInt(text.slice(separator + 1)) }
}
const ceil = (num: bigint, den: bigint): bigint => (num + den - 1n) / den

const clockProbe = z.object({
  streams: z.tuple([z.object({ time_base: rateText, avg_frame_rate: rateText, r_frame_rate: rateText,
    duration_ts: z.number().int().positive(), nb_frames: z.string().regex(/^\d+$/u) })]),
  frames: z.array(z.object({ best_effort_timestamp: z.number().int().nonnegative() })).min(1).max(maxFrames),
})

/**
 * Read and prove the full zero-based constant-frame-rate picture clock.
 * @param toolkit - FFprobe binary and the owning subprocess channel.
 * @param path - Local MP4 whose first video stream is checked.
 * @returns Exact rational rate and verified number of decoded frames.
 */
export async function probeClock(toolkit: MediaToolkit, path: string): Promise<VideoClock> {
  const args = ['-v', 'error', ...mp4Input, '-select_streams', 'v:0', '-show_streams', '-show_frames',
    '-show_entries', 'stream=time_base,avg_frame_rate,r_frame_rate,duration_ts,nb_frames:frame=best_effort_timestamp', '-of', 'json', path]
  const result = await toolkit.channel.run(toolkit.ffprobe, args)
  if (result.code !== 0) throw new MediaCommandError(toolkit.ffprobe, args, result.code, result.stderr)
  const decoded = clockProbe.safeParse(JSON.parse(result.stdout))
  if (!decoded.success) throw new Error('SOURCE_CLOCK: 不能读取完整视频帧时钟。')
  const [stream] = decoded.data.streams
  const rate = exactRate(stream.avg_frame_rate), nominal = exactRate(stream.r_frame_rate), timeBase = exactRate(stream.time_base)
  const count = decoded.data.frames.length
  const numerator = rate.den * timeBase.den, denominator = rate.num * timeBase.num
  if (rate.num * nominal.den !== nominal.num * rate.den || rate.num < rate.den || rate.num > rate.den * 60n
    || BigInt(count) * rate.den > BigInt(maxDuration) * rate.num || count !== Number(stream.nb_frames)
    || BigInt(stream.duration_ts) * denominator !== BigInt(count) * numerator
    || decoded.data.frames.some(({ best_effort_timestamp }, index) =>
      BigInt(best_effort_timestamp) * denominator !== BigInt(index) * numerator)) {
    throw new Error('SOURCE_CLOCK: 仅支持从零开始且每帧都能证明等间隔的视频。')
  }
  return { rate, rateString: stream.avg_frame_rate, count }
}

function cadence(original: VideoClock, processed: VideoClock) {
  const num = processed.rate.num * original.rate.den, den = processed.rate.den * original.rate.num
  if (num < den || BigInt(processed.count) !== ceil(BigInt(original.count) * num, den)) {
    throw new Error('SOURCE_CLOCK: 处理片帧数或帧率不能完整对应原片。')
  }
  const frames = Array.from({ length: original.count }, (_, index) => Number(ceil(BigInt(index) * num, den)))
  // The inverse membership test is the same rational cadence for any accepted rates.
  const selection = num === den ? 'null' : `select='eq(n,ceil(floor(n*${den}/${num})*${num}/${den}))'`
  return { frames, selection, digest: createHash('sha256').update(JSON.stringify(frames)).digest('hex') }
}

async function frameFeatures(toolkit: MediaToolkit, video: string, raw: string, count: number): Promise<Buffer> {
  // Subtitle removal changes the lower band. Use the upper picture to reject clock mismatches and extra frames.
  await runFfmpeg(toolkit, ['-n', '-v', 'error', '-xerror', '-noautorotate', ...mp4Input, '-i', video,
    '-map', '0:v:0', '-vf', pictureClockFeatures.filter, '-fps_mode', 'passthrough',
    '-c:v', 'rawvideo', '-threads', '1', '-f', 'rawvideo', raw])
  const expectedBytes = count * featureBytes
  const invalidSize = () => new Error('SOURCE_CLOCK: 画面比较没有覆盖全部解码帧。')
  if ((await lstat(raw)).size !== expectedBytes) throw invalidSize()
  const bytes = await readFile(raw)
  if (bytes.length !== expectedBytes) throw invalidSize()
  return bytes
}

/**
 * Measure the pixel difference for two normalized upper-picture frames.
 * @param left - First verified normalized frame buffer.
 * @param leftFrame - The frame index within the first buffer.
 * @param right - Second verified normalized frame buffer.
 * @param rightFrame - The frame index within the second buffer.
 * @returns Overall and largest local tile mean absolute RGB difference.
 */
export function pictureFeatureDifference(left: Buffer, leftFrame: number, right: Buffer, rightFrame: number): {
  meanDifference: number
  maximumTileDifference: number
} {
  const leftStart = leftFrame * featureBytes, rightStart = rightFrame * featureBytes
  let difference = 0
  let maximumTile = 0
  for (let y = 0; y < featureSize; y += tileSize) for (let x = 0; x < featureSize; x += tileSize) {
    let tile = 0
    for (let row = y; row < y + tileSize; row++) for (let col = x * 3; col < (x + tileSize) * 3; col++) {
      const offset = row * featureSize * 3 + col
      tile += Math.abs(left.readUInt8(leftStart + offset) - right.readUInt8(rightStart + offset))
    }
    maximumTile = Math.max(maximumTile, tile)
    difference += tile
  }
  return { meanDifference: difference / featureBytes, maximumTileDifference: maximumTile / (tileSize ** 2 * 3) }
}

function featureDistanceOkay(left: Buffer, leftFrame: number, right: Buffer, rightFrame: number, limits: readonly [number, number]) {
  const { meanDifference, maximumTileDifference } = pictureFeatureDifference(left, leftFrame, right, rightFrame)
  return meanDifference <= limits[0] && maximumTileDifference <= limits[1]
}

function verifyPictures(original: Buffer, processed: Buffer, frames: readonly number[], signal?: AbortSignal): void {
  for (const [index, selected] of frames.entries()) {
    signal?.throwIfAborted()
    if (!featureDistanceOkay(original, index, processed, selected, pictureClockFeatures.paired)) {
      throw new Error(`SOURCE_CLOCK: 原片第 ${String(index + 1)} 帧与其处理片时点不相符。`)
    }
    const next = frames[index + 1] ?? processed.length / featureBytes
    for (let skipped = selected + 1; skipped < next; skipped++) {
      if (!featureDistanceOkay(processed, selected, processed, skipped, pictureClockFeatures.repeated)) {
        throw new Error(`SOURCE_CLOCK: 处理片第 ${String(skipped + 1)} 帧不能证明是可略过的重复画面。`)
      }
    }
  }
}

/**
 * Verify the same decoded picture timing across two re-encoded versions before their ending.
 * @param toolkit - Media binaries and owning subprocess channel.
 * @param original - Source video and private temporary decoded-feature path.
 * @param donor - Same-rate alternate video and private temporary decoded-feature path.
 * @param count - Complete verified frame count of both videos.
 * @param prefixCount - Number of original picture frames before the replacement boundary.
 * @param signal - Cancellation checked while comparing the frames.
 */
export async function verifyMatchingPicturePrefix(toolkit: MediaToolkit,
  original: { path: string; features: string }, donor: { path: string; features: string },
  count: number, prefixCount: number, signal?: AbortSignal): Promise<void> {
  const length = prefixCount * featureBytes
  const before = (await frameFeatures(toolkit, original.path, original.features, count)).subarray(0, length)
  const alternate = (await frameFeatures(toolkit, donor.path, donor.features, count)).subarray(0, length)
  verifyPictures(before, alternate, Array.from({ length: prefixCount }, (_, index) => index), signal)
}

/**
 * Hash the decoded first audio track without mixing or resampling.
 * @param toolkit - FFmpeg binary and the owning subprocess channel.
 * @param path - Local MP4 containing the first audio stream.
 * @returns SHA-256 of the decoded 32-bit PCM stream.
 */
export async function audioHash(toolkit: MediaToolkit, path: string): Promise<string> {
  const args = ['-v', 'error', '-xerror', ...mp4Input, '-i', path, '-map', '0:a:0',
    '-c:a', 'pcm_s32le', '-f', 'hash', '-hash', 'sha256', 'pipe:1']
  const result = await captureFfmpeg(toolkit, args)
  if (result.code !== 0) throw new MediaCommandError(toolkit.ffmpeg, args, result.code, result.stderr)
  const sha = /^SHA256=([0-9a-f]{64})\s*$/u.exec(result.stdout)?.[1]
  if (sha === undefined) throw new Error('SOURCE_CLOCK: 未取得完整音轨摘要。')
  return sha
}

const audioPacketProbe = z.object({
  streams: z.tuple([z.object({ time_base: rateText, channels: z.number().int().positive() })]),
  packets: z.array(z.object({ pts: z.number().int(), dts: z.number().int(), duration: z.number().int().positive(),
    data_hash: z.string().regex(/^SHA256:[0-9a-f]{64}$/u) })).min(1).max(24000),
})

/**
 * Bind the first track's encoded payloads, timing and channel count.
 * @param toolkit - FFprobe binary and the owning subprocess channel.
 * @param path - Local MP4 containing the first audio stream.
 * @returns Verified channel count and SHA-256 of packet order, timing and digests.
 */
export async function audioPackets(toolkit: MediaToolkit, path: string): Promise<{ channels: number; packetsSha256: string }> {
  const args = ['-v', 'error', ...mp4Input, '-select_streams', 'a:0', '-show_packets', '-show_streams',
    '-show_entries', 'stream=time_base,channels:packet=pts,dts,duration,data_hash', '-show_data_hash', 'sha256', '-of', 'json', path]
  const result = await toolkit.channel.run(toolkit.ffprobe, args)
  if (result.code !== 0) throw new MediaCommandError(toolkit.ffprobe, args, result.code, result.stderr)
  const parsed = audioPacketProbe.safeParse(JSON.parse(result.stdout))
  if (!parsed.success) throw new Error('SOURCE_CLOCK: 完整原声音频包或时钟未知。')
  return { channels: parsed.data.streams[0].channels, packetsSha256: createHash('sha256').update(JSON.stringify(parsed.data)).digest('hex') }
}

/**
 * Hash every decoded YUV420P picture in presentation order.
 * @param toolkit - FFmpeg binary and the owning subprocess channel.
 * @param path - Local MP4 whose first video stream is checked.
 * @param count - Required number of decoded frame hashes.
 * @returns A SHA-256 digest for each complete frame in presentation order.
 */
export async function frameHashes(toolkit: MediaToolkit, path: string, count: number): Promise<string[]> {
  const args = ['-v', 'error', '-xerror', '-noautorotate', ...mp4Input, '-i', path, '-map', '0:v:0', '-vf', 'format=yuv420p',
    '-fps_mode', 'passthrough', '-c:v', 'rawvideo', '-threads', '1', '-f', 'framehash', '-hash', 'sha256', 'pipe:1']
  const result = await captureFfmpeg(toolkit, args)
  if (result.code !== 0) throw new MediaCommandError(toolkit.ffmpeg, args, result.code, result.stderr)
  const lines = result.stdout.split(/\r?\n/u).filter(line => line.length > 0 && !line.startsWith('#'))
  const hashes = lines.map(line => /,\s*([a-f0-9]{64})\s*$/u.exec(line)?.[1] ?? '')
  if (hashes.length !== count || hashes.some(sha => sha.length === 0)) throw new Error('SOURCE_CLOCK: 全画面摘要没有覆盖全部解码帧。')
  return hashes
}

async function sourceFile(project: string, declared: SourceClockConformBinding['original']) {
  const path = await realpath(resolve(project, declared.path))
  const rel = relative(project, path), info = await lstat(path)
  if (rel === '' || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel) || extname(path).toLowerCase() !== '.mp4'
    || !info.isFile() || info.size <= 0 || info.size > 1024 ** 3 || !file.safeParse({ path, sha256: declared.sha256 }).success) {
    throw new Error('SOURCE_CLOCK: 仅支持项目内已知摘要的本地 MP4，单份不超过 1 GiB。')
  }
  return { path, sha256: declared.sha256 }
}

async function requireCanonicalDirectory(path: string): Promise<void> {
  if (await realpath(path) !== path || !(await lstat(path)).isDirectory()) throw new Error('SOURCE_CLOCK: 候选目录不在规范项目路径。')
}

/**
 * Produce a new clock-bound candidate from exact authorized inputs in the project.
 * @param toolkit - Media binaries and the owning subprocess channel.
 * @param args - Project, episode and exact original and processed file identities.
 * @param signal - Cancellation checked during evidence verification and before publication.
 * @returns New candidate identity with its verified frame mapping and original audio evidence.
 */
export async function conformSourceClock(toolkit: MediaToolkit, args: SourceClockConformArgs,
  signal?: AbortSignal): Promise<SourceClockConformBinding> {
  signal?.throwIfAborted()
  if (!Number.isSafeInteger(args.episode) || args.episode < 1) throw new Error('SOURCE_CLOCK: 需要正整数集号。')
  const project = await realpath(args.project), episode = episodeNumberOf(args.episode)
  const original = await sourceFile(project, args.original), processed = await sourceFile(project, args.processed)
  if (original.path === processed.path || original.sha256 === processed.sha256) throw new Error('SOURCE_CLOCK: 需要不同的原片和处理片。')
  const editing = join(project, 'editing')
  await mkdir(editing, { recursive: true })
  await requireCanonicalDirectory(editing)
  const directory = await mkdtemp(join(editing, `source-clock-${episode}-`))
  const originalFile = join(directory, 'original.mp4'), processedFile = join(directory, 'processed.mp4')
  const originalFeatures = join(directory, 'original.rgb'), processedFeatures = join(directory, 'processed.rgb')
  const outputPath = join(directory, 'clip.mp4')
  const temporary = [originalFile, processedFile, originalFeatures, processedFeatures]
  let completed = false
  try {
    await requireCanonicalDirectory(directory)
    await copyFile(original.path, originalFile, constants.COPYFILE_EXCL)
    await copyFile(processed.path, processedFile, constants.COPYFILE_EXCL)
    if (await fileSha256(originalFile, signal) !== original.sha256 || await fileSha256(processedFile, signal) !== processed.sha256) {
      throw new Error('SOURCE_CLOCK: 输入与本次已核对的素材摘要不一致。')
    }
    const probe = { ...toolkit, channel: {
      run: (command: string, argv: readonly string[]) => toolkit.channel.run(command, [...mp4Input, ...argv]),
    } }
    const originalMedia = await probeMedia(probe, originalFile), processedMedia = await probeMedia(probe, processedFile)
    const originalVideo = firstStreamOfType(originalMedia, 'video'), processedVideo = firstStreamOfType(processedMedia, 'video')
    const audio = firstStreamOfType(originalMedia, 'audio'), sampleRate = audio?.sampleRate
    const dimensions = [originalVideo?.width ?? 0, originalVideo?.height ?? 0, processedVideo?.width ?? 0, processedVideo?.height ?? 0]
    if (originalMedia.streams.length !== 2 || processedMedia.streams.filter(stream => stream.codecType === 'video').length !== 1
      || dimensions.some(dimension => dimension < 48 || dimension > 4096 || dimension % 2 !== 0)
      || originalMedia.durationSeconds > maxDuration || processedMedia.durationSeconds > maxDuration
      || audio?.codecName !== 'aac' || audio.startSeconds !== 0 || !sampleRate || sampleRate > 192000) {
      throw new Error('SOURCE_CLOCK: 输入尺寸、长度或零起点原声超出当前恢复范围。')
    }
    const originClock = await probeClock(toolkit, originalFile), processedClock = await probeClock(toolkit, processedFile)
    const mapping = cadence(originClock, processedClock)
    const processedFrames = await frameFeatures(toolkit, processedFile, processedFeatures, processedClock.count)
    verifyPictures(await frameFeatures(toolkit, originalFile, originalFeatures, originClock.count), processedFrames, mapping.frames, signal)
    const audioProof = { sha256: await audioHash(toolkit, originalFile), sampleRate, ...await audioPackets(toolkit, originalFile) }
    const { num, den } = originClock.rate
    await runFfmpeg(toolkit, ['-n', '-v', 'error', '-xerror', '-noautorotate', ...mp4Input, '-i', processedFile, ...mp4Input, '-i', originalFile,
      '-map', '0:v:0', '-map', '1:a:0', '-map_metadata', '-1', '-map_chapters', '-1',
      '-vf', `${mapping.selection},settb=${den}/${num},setpts=N`, '-r', originClock.rateString, '-fps_mode', 'cfr',
      '-c:v', 'libx264', '-preset', 'fast', '-qp', '0', '-pix_fmt', 'yuv420p', '-c:a', 'copy',
      '-video_track_timescale', String(num), '-movie_timescale', String(sampleRate), '-movflags', '+faststart', outputPath])
    signal?.throwIfAborted()
    const outputClock = await probeClock(toolkit, outputPath), outputMedia = await probeMedia(probe, outputPath)
    const outputVideo = firstStreamOfType(outputMedia, 'video'), outputSound = firstStreamOfType(outputMedia, 'audio')
    if (outputClock.count !== originClock.count || outputClock.rateString !== originClock.rateString
      || outputVideo?.width !== processedVideo?.width || outputVideo?.height !== processedVideo?.height
      || outputSound?.startSeconds !== 0 || outputSound.sampleRate !== sampleRate || outputSound.durationSeconds !== audio.durationSeconds
      || await audioHash(toolkit, outputPath) !== audioProof.sha256
      || (await audioPackets(toolkit, outputPath)).packetsSha256 !== audioProof.packetsSha256) {
      throw new Error('SOURCE_CLOCK: 回读的候选帧时钟或完整原声不符。')
    }
    const processedHashes = await frameHashes(toolkit, processedFile, processedClock.count)
    const outputHashes = await frameHashes(toolkit, outputPath, outputClock.count)
    for (const [index, selected] of mapping.frames.entries()) {
      if (outputHashes[index] !== processedHashes[selected]) throw new Error('SOURCE_CLOCK: 回读的候选画面与本次所选帧不符。')
    }
    if (await fileSha256(originalFile, signal) !== original.sha256 || await fileSha256(processedFile, signal) !== processed.sha256
      || await fileSha256(original.path, signal) !== original.sha256 || await fileSha256(processed.path, signal) !== processed.sha256) {
      throw new Error('SOURCE_CLOCK: 本次运行期间源片已变化。')
    }
    const binding = sourceClockConformBindingSchema.parse({ version: 1, project, episode, original, processed,
      output: { path: outputPath, sha256: await fileSha256(outputPath, signal) },
      clock: { originalRate: originClock.rateString, processedRate: processedClock.rateString,
        originalFrames: originClock.count, processedFrames: processedClock.count, mappingSha256: mapping.digest }, audio: audioProof })
    completed = true
    return binding
  } finally {
    await requireCanonicalDirectory(directory)
    for (const path of temporary) await rm(path, { force: true })
    if (!completed) {
      await rm(outputPath, { force: true })
      await rmdir(directory)
    }
  }
}
