/** Patch one short sound window while preserving the primary picture and both source files. */
import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { copyFile, link, lstat, mkdir, mkdtemp, readFile, realpath, rm, rmdir, writeFile } from 'node:fs/promises'
import { extname, isAbsolute, join, relative, sep } from 'node:path'
import { HarnessError } from '@deepseek-ai/dsh-llm'
import { z } from 'zod'
import { fileSha256 } from './cache.ts'
import { firstStreamOfType, MediaCommandError, probeMedia, runFfmpeg } from './ffmpeg.ts'
import { episodeNumberOf } from './paths.ts'
import type { MediaToolkit } from './types.ts'

const minWindowMs = 80
const maxWindowMs = 600
const fadeMs = 8
const maxSeconds = 60
const maxSourceBytes = 1024 ** 3
const movInput = ['-protocol_whitelist', 'file', '-f', 'mov', '-enable_drefs', '0']
const sha = z.hash('sha256')
const file = z.strictObject({ path: z.string().min(1), sha256: sha })
const source = file.extend({ startMs: z.number().int().nonnegative().max(maxSeconds * 1000) })
const ratio = z.string().regex(/^[1-9]\d{0,6}\/[1-9]\d{0,6}$/u)
const windowMs = z.number().int().min(minWindowMs).max(maxWindowMs)
const channels = z.union([z.literal(1), z.literal(2)])

/** The exact technical candidate, which still requires source and listening review. */
export const localDialoguePatchBindingSchema = z.strictObject({
  version: z.literal(1), project: z.string().min(1), episode: z.string().regex(/^\d{2,}$/u),
  target: source, donor: source, output: file, durationMs: windowMs, fadeMs: z.literal(fadeMs),
  video: z.strictObject({ packetsSha256: sha, frames: z.number().int().positive(), timeBase: ratio }),
  audio: z.strictObject({ sampleRate: z.number().int().positive(), channels, samples: z.number().int().positive(),
    targetStartSample: z.number().int().nonnegative(), donorStartSample: z.number().int().nonnegative(),
    patchSamples: z.number().int().positive(), fadeSamples: z.number().int().positive(),
    beforeSha256: sha, afterSha256: sha, originalPatchSha256: sha, replacementSha256: sha, outsidePatchSha256: sha }),
  reviewStatus: z.literal('pending_review'), listeningVerified: z.literal(false), sourceApproved: z.literal(false),
})
/** The result of verifying the splice against both source files. */
export type LocalDialoguePatchBinding = z.infer<typeof localDialoguePatchBindingSchema>
/** Two project-local source files and the single matching audio window to splice. */
export interface LocalDialoguePatchArgs {
  readonly project: string
  readonly episode: number
  readonly target: z.infer<typeof source>
  readonly donor: z.infer<typeof source>
  readonly durationMs: number
}

const videoStream = z.object({
  codec_name: z.enum(['h264', 'hevc']), codec_tag_string: z.enum(['avc1', 'hvc1', 'hev1']),
  time_base: ratio, start_pts: z.literal(0), duration_ts: z.number().int().positive(),
  width: z.number().int().positive(), height: z.number().int().positive(), display_aspect_ratio: z.string().optional(),
  sample_aspect_ratio: z.string().optional(), pix_fmt: z.string().optional(), field_order: z.string().optional(),
  color_range: z.string().optional(), color_space: z.string().optional(),
  color_transfer: z.string().optional(), color_primaries: z.string().optional(),
  extradata_hash: z.string().regex(/^SHA256:[a-f0-9]{64}$/u),
  side_data_list: z.array(z.object({ side_data_type: z.string(), displaymatrix: z.string().optional(),
    rotation: z.number().optional() })).optional(),
})
const videoProbe = z.object({
  streams: z.tuple([videoStream]),
  packets: z.array(z.object({ pts: z.number().int().nonnegative(), dts: z.number().int(),
    duration: z.number().int().positive(), flags: z.string(), data_hash: z.string().regex(/^SHA256:[a-f0-9]{64}$/u) }))
    .min(1).max(maxSeconds * 60),
})
const audioStream = z.object({ codec_name: z.enum(['aac', 'alac', 'pcm_s32le', 'pcm_s16le']),
  time_base: ratio, start_pts: z.literal(0), duration_ts: z.number().int().positive(),
  sample_rate: z.string().regex(/^\d{4,5}$/u), channels,
  channel_layout: z.enum(['mono', 'stereo']).optional(),
})
const audioProbe = z.object({
  streams: z.tuple([audioStream]),
  packets: z.array(z.object({ pts: z.number().int(), dts: z.number().int(), duration: z.number().int().positive(),
    side_data_list: z.array(z.object({ side_data_type: z.string(), skip_samples: z.number().int().nonnegative().optional() })).optional(),
  })).min(1).max(12_000),
})

function invalid(detail: string): HarnessError { return new HarnessError(detail, 'DIALOGUE_PATCH_INVALID') }
function digest(data: Buffer | string): string { return createHash('sha256').update(data).digest('hex') }

async function requireDirectory(path: string): Promise<void> {
  if (await realpath(path) !== path || !(await lstat(path)).isDirectory()) throw invalid('需要实际存在的项目内目录。')
}

async function requireSource(project: string, declared: LocalDialoguePatchArgs['target']) {
  const { path } = declared
  const inner = relative(project, path)
  const parsed = source.safeParse(declared)
  const validSource = () => invalid('需要项目内两份有摘要的本地视频及有效的毫秒位置。')
  if (!parsed.success || !isAbsolute(path) || inner === '' || isAbsolute(inner)
    || inner === '..' || inner.startsWith(`..${sep}`) || !['.mp4', '.mov'].includes(extname(path).toLowerCase())) {
    throw validSource()
  }
  if (await realpath(path) !== path) throw validSource()
  const info = await lstat(path)
  if (!info.isFile() || info.size <= 0 || info.size > maxSourceBytes) throw validSource()
  return parsed.data
}

async function verifyFiles(files: readonly z.infer<typeof file>[], signal?: AbortSignal): Promise<void> {
  for (const item of files) {
    signal?.throwIfAborted()
    if (await realpath(item.path) !== item.path || await fileSha256(item.path, signal) !== item.sha256) {
      throw invalid('来源字节与已核对的摘要不一致。')
    }
  }
}

async function probeTrack<T>(toolkit: MediaToolkit, path: string, stream: 'v:0' | 'a:0',
  entries: string, schema: z.ZodType<T>): Promise<T> {
  const args = ['-v', 'error', ...movInput, '-select_streams', stream, '-show_streams', '-show_packets',
    '-show_data_hash', 'sha256', '-show_entries', entries, '-of', 'json', path]
  const result = await toolkit.channel.run(toolkit.ffprobe, args)
  if (result.code !== 0) throw new MediaCommandError(toolkit.ffprobe, args, result.code, result.stderr)
  const parsed = schema.safeParse(JSON.parse(result.stdout))
  if (!parsed.success) throw invalid('媒体未提供完整的单一音视频数据和时钟。')
  return parsed.data
}

const frameProbe = z.object({
  streams: z.tuple([z.object({ time_base: ratio, avg_frame_rate: ratio, r_frame_rate: ratio,
    duration_ts: z.number().int().positive(), nb_frames: z.string().regex(/^\d+$/u) })]),
  frames: z.array(z.object({ best_effort_timestamp: z.number().int().nonnegative() })).min(1).max(maxSeconds * 60),
})

function rational(text: string) {
  const separator = text.indexOf('/')
  return { numerator: BigInt(text.slice(0, separator)), denominator: BigInt(text.slice(separator + 1)) }
}

async function probePictureClock(toolkit: MediaToolkit, path: string) {
  const args = ['-v', 'error', ...movInput, '-select_streams', 'v:0', '-show_streams', '-show_frames',
    '-show_entries', 'stream=time_base,avg_frame_rate,r_frame_rate,duration_ts,nb_frames:frame=best_effort_timestamp',
    '-of', 'json', path]
  const result = await toolkit.channel.run(toolkit.ffprobe, args)
  if (result.code !== 0) throw new MediaCommandError(toolkit.ffprobe, args, result.code, result.stderr)
  const decoded = frameProbe.safeParse(JSON.parse(result.stdout))
  if (!decoded.success) throw invalid('不能读取完整视频帧时钟。')
  const [stream] = decoded.data.streams
  const rate = rational(stream.avg_frame_rate), nominal = rational(stream.r_frame_rate), timeBase = rational(stream.time_base)
  const count = decoded.data.frames.length
  const numerator = rate.denominator * timeBase.denominator, denominator = rate.numerator * timeBase.numerator
  if (rate.numerator * nominal.denominator !== nominal.numerator * rate.denominator
    || rate.numerator < rate.denominator || rate.numerator > rate.denominator * 60n
    || BigInt(count) * rate.denominator > BigInt(maxSeconds) * rate.numerator || count !== Number(stream.nb_frames)
    || BigInt(stream.duration_ts) * denominator !== BigInt(count) * numerator
    || decoded.data.frames.some(({ best_effort_timestamp }, index) =>
      BigInt(best_effort_timestamp) * denominator !== BigInt(index) * numerator)) {
    throw invalid('仅支持从零开始且等间隔的视频帧。')
  }
  return { rateString: stream.avg_frame_rate, count }
}

async function videoClock(toolkit: MediaToolkit, path: string) {
  const clock = await probePictureClock(toolkit, path)
  const track = await probeTrack(toolkit, path, 'v:0', [
    'stream=codec_name,codec_tag_string,time_base,start_pts,duration_ts,width,height,display_aspect_ratio,',
    'sample_aspect_ratio,pix_fmt,field_order,color_range,color_space,color_transfer,color_primaries,extradata_hash',
    ':stream_side_data=side_data_type,displaymatrix,rotation:packet=pts,dts,duration,flags,data_hash',
  ].join(''), videoProbe)
  const [stream] = track.streams
  const scale = Number(stream.time_base.split('/')[1])
  if (track.packets.length !== clock.count || !stream.time_base.startsWith('1/') || scale > 1_000_000) {
    throw invalid('视频包数量与完整的零起点视频时钟不符。')
  }
  return { stream, frames: clock.count, rate: clock.rateString, scale, packetsSha256: digest(JSON.stringify(track)) }
}

async function audioClock(toolkit: MediaToolkit, path: string) {
  const { streams: [stream], packets } = await probeTrack(toolkit, path, 'a:0',
    'stream=codec_name,time_base,start_pts,duration_ts,sample_rate,channels,channel_layout:packet=pts,dts,duration:packet_side_data=side_data_type,skip_samples',
    audioProbe)
  const rate = Number(stream.sample_rate)
  const layout = stream.channels === 1 ? 'mono' : 'stereo'
  const first = packets[0]
  if (first === undefined || rate < 8_000 || rate > 96_000 || stream.time_base !== `1/${rate}`
    || stream.duration_ts > rate * maxSeconds || (stream.channel_layout !== undefined && stream.channel_layout !== layout)) {
    throw invalid('仅支持无偏移、已知采样率的单声道或立体声音频。')
  }

  let cursor = first.pts
  if (cursor !== 0 && (stream.codec_name !== 'aac' || cursor >= 0 || cursor < -4096 || first.duration !== -cursor
    || !first.side_data_list?.some(data => data.side_data_type === 'Skip Samples' && data.skip_samples === -cursor))) {
    throw invalid('音频起点有偏移或编码延迟不明确。')
  }
  for (const packet of packets) {
    if (packet.pts !== cursor || packet.pts !== packet.dts) throw invalid('音频存在断点、重叠或时钟偏移。')
    cursor += packet.duration
  }
  if (cursor !== stream.duration_ts) throw invalid('音频包覆盖的采样数与声音时钟不符。')
  return { rate, channels: stream.channels, samples: stream.duration_ts }
}

async function inspectSource(toolkit: MediaToolkit, path: string) {
  const movie = { ...toolkit, channel: {
    run: (command: string, args: readonly string[]) => toolkit.channel.run(command, [...movInput, ...args]),
  } }
  const media = await probeMedia(movie, path)
  const picture = firstStreamOfType(media, 'video'), sound = firstStreamOfType(media, 'audio')
  if (media.streams.length !== 2 || picture?.startSeconds !== 0 || sound?.startSeconds !== 0
    || !(media.durationSeconds > 0 && media.durationSeconds <= maxSeconds)) {
    throw invalid('仅支持从零开始且只有一条视频和一条音频的短片。')
  }
  const video = await videoClock(toolkit, path)
  const audio = await audioClock(toolkit, path)
  return { video, audio }
}

async function decodeAudio(toolkit: MediaToolkit, input: string, pcm: string,
  clock: Awaited<ReturnType<typeof audioClock>>): Promise<Buffer> {
  const samples = clock.samples
  await runFfmpeg(toolkit, ['-n', '-v', 'error', '-xerror', ...movInput, '-i', input, '-map', '0:a:0',
    '-af', `atrim=end_sample=${samples}`, '-c:a', 'pcm_s32le', '-f', 's32le', pcm])
  const bytes = samples * clock.channels * 4
  if ((await lstat(pcm)).size !== bytes) throw invalid('解码后的实际采样数与音频时钟不符。')
  return await readFile(pcm)
}

function exactSamples(ms: number, sampleRate: number): number {
  const samples = ms * sampleRate / 1000
  if (!Number.isSafeInteger(samples)) throw invalid('所选毫秒边界不能精确落到采样点。')
  return samples
}

function replaceAudio(targetPcm: Buffer, donorPcm: Buffer, targetStart: number, donorStart: number, samples: number,
  fadeSamples: number, channelCount: number) {
  const bytesPerFrame = channelCount * 4
  const start = targetStart * bytesPerFrame, end = start + samples * bytesPerFrame
  const donorOffset = donorStart * bytesPerFrame
  const replaced = Buffer.from(targetPcm)
  const originalWindow = targetPcm.subarray(start, end)
  donorPcm.copy(replaced, start, donorOffset, donorOffset + originalWindow.length)
  for (let index = 0; index < fadeSamples; index++) {
    for (const frame of [index, samples - 1 - index]) {
      const gain = index / fadeSamples
      for (let channel = 0; channel < channelCount; channel++) {
        const byte = start + frame * bytesPerFrame + channel * 4
        const original = targetPcm.readInt32LE(byte), donor = replaced.readInt32LE(byte)
        replaced.writeInt32LE(Math.round(original * (1 - gain) + donor * gain), byte)
      }
    }
  }
  const replacement = replaced.subarray(start, end)
  if (replacement.equals(originalWindow)) throw invalid('提供的音频没有改变目标窗口。')
  const outside = createHash('sha256').update(targetPcm.subarray(0, start)).update(targetPcm.subarray(end)).digest('hex')
  return { replaced, originalWindow, replacement, outside }
}

/**
 * Produce one lossless technical candidate and verify its exact picture and sound before publication.
 * @param toolkit - Local media binaries and the owning subprocess channel.
 * @param args - Two hash-bound source files, explicit local windows and a shared duration.
 * @param signal - Cancellation from the owning tool invocation, when available.
 * @returns A pending candidate with both source files preserved and no source or listening approval.
 */
export async function patchLocalDialogue(toolkit: MediaToolkit, args: LocalDialoguePatchArgs,
  signal?: AbortSignal): Promise<LocalDialoguePatchBinding> {
  signal?.throwIfAborted()
  if (!Number.isSafeInteger(args.episode) || args.episode < 1 || !windowMs.safeParse(args.durationMs).success) {
    throw invalid('需要有效集号和 80–600 毫秒的单一窗口。')
  }
  const project = await realpath(args.project), episode = episodeNumberOf(args.episode)
  const [target, donor] = await Promise.all([requireSource(project, args.target), requireSource(project, args.donor)])
  if (target.path === donor.path || target.sha256 === donor.sha256) throw invalid('需要两个不同的输入版本。')
  const editing = join(project, 'editing')
  await mkdir(editing, { recursive: true })
  await requireDirectory(editing)
  const directory = await mkdtemp(join(editing, `dialogue-patch-${episode}-`))
  const targetFile = join(directory, 'target.mov'), donorFile = join(directory, 'donor.mov')
  const pcmTarget = join(directory, 'target.pcm'), pcmDonor = join(directory, 'donor.pcm')
  const pcmPatch = join(directory, 'patched.pcm'), pcmCheck = join(directory, 'verified.pcm')
  const pending = join(directory, 'candidate.mov'), output = join(directory, 'clip.mov')
  const snapshots = [{ path: targetFile, sha256: target.sha256 }, { path: donorFile, sha256: donor.sha256 }]
  let published = false
  try {
    await requireDirectory(directory)
    await copyFile(target.path, targetFile, constants.COPYFILE_EXCL)
    await copyFile(donor.path, donorFile, constants.COPYFILE_EXCL)
    await verifyFiles(snapshots, signal)
    const primary = await inspectSource(toolkit, targetFile)
    const replacement = await inspectSource(toolkit, donorFile)
    const sampleRate = primary.audio.rate, channelCount = primary.audio.channels
    if (sampleRate !== replacement.audio.rate || channelCount !== replacement.audio.channels
      || primary.video.rate !== replacement.video.rate || primary.video.stream.width !== replacement.video.stream.width
      || primary.video.stream.height !== replacement.video.stream.height) {
      throw invalid('两份来源的画面规格、帧率、声道或采样率不相容。')
    }
    const targetStart = exactSamples(target.startMs, sampleRate), donorStart = exactSamples(donor.startMs, sampleRate)
    const patchSamples = exactSamples(args.durationMs, sampleRate)
    const fadeSamples = Math.floor(fadeMs * sampleRate / 1000)
    const fits = (start: number, media: typeof primary) =>
      start + patchSamples <= media.audio.samples
      && (start + patchSamples) * media.video.scale <= media.video.stream.duration_ts * sampleRate
    if (!fits(targetStart, primary) || !fits(donorStart, replacement)) throw invalid('两个窗口都须位于各自的画面和音频范围内。')
    const targetAudio = await decodeAudio(toolkit, targetFile, pcmTarget, primary.audio)
    const donorAudio = await decodeAudio(toolkit, donorFile, pcmDonor, replacement.audio)
    const edit = replaceAudio(targetAudio, donorAudio, targetStart, donorStart, patchSamples, fadeSamples, channelCount)
    await writeFile(pcmPatch, edit.replaced, { flag: 'wx' })
    // PCM keeps every verified sample outside the edit intact; another AAC encode would change it.
    await runFfmpeg(toolkit, ['-n', '-v', 'error', '-xerror', '-copyts', ...movInput, '-i', targetFile,
      '-protocol_whitelist', 'file', '-f', 's32le', '-ar', String(sampleRate), '-ac', String(channelCount), '-i', pcmPatch,
      '-map', '0:v:0', '-map', '1:a:0', '-map_metadata', '-1', '-map_chapters', '-1', '-c:v', 'copy', '-c:a', 'pcm_s32le',
      '-tag:v', primary.video.stream.codec_tag_string, '-video_track_timescale', String(primary.video.scale),
      '-movie_timescale', String(sampleRate), '-avoid_negative_ts', 'disabled', '-f', 'mov', pending])

    const sha256 = await fileSha256(pending, signal)
    const result = await inspectSource(toolkit, pending)
    if (result.video.packetsSha256 !== primary.video.packetsSha256
      || result.video.frames !== primary.video.frames || result.video.rate !== primary.video.rate
      || result.audio.samples !== primary.audio.samples || result.audio.rate !== sampleRate || result.audio.channels !== channelCount
      || !(await decodeAudio(toolkit, pending, pcmCheck, result.audio)).equals(edit.replaced)) {
      throw invalid('输出回读与预期的完整画面、时间戳或音频采样不符。')
    }
    await verifyFiles([...snapshots, target, donor, { path: pending, sha256 }], signal)
    const binding = localDialoguePatchBindingSchema.parse({
      version: 1, project, episode, target, donor, output: { path: output, sha256 }, durationMs: args.durationMs, fadeMs,
      video: { packetsSha256: result.video.packetsSha256, frames: result.video.frames, timeBase: result.video.stream.time_base },
      audio: { sampleRate, channels: channelCount, samples: result.audio.samples, targetStartSample: targetStart,
        donorStartSample: donorStart, patchSamples, fadeSamples, beforeSha256: digest(targetAudio), afterSha256: digest(edit.replaced),
        originalPatchSha256: digest(edit.originalWindow), replacementSha256: digest(edit.replacement), outsidePatchSha256: edit.outside },
      reviewStatus: 'pending_review', listeningVerified: false, sourceApproved: false,
    })
    await requireDirectory(directory)
    signal?.throwIfAborted()
    await link(pending, output)
    published = true
    return binding
  } finally {
    await requireDirectory(directory)
    for (const path of [targetFile, donorFile, pcmTarget, pcmDonor, pcmPatch, pcmCheck, pending]) await rm(path, { force: true })
    if (!published) await rmdir(directory)
  }
}
