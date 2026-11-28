/** Replace only the terminal picture frames of a final cut, with exact clock and audio proof. */
import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { copyFile, link, lstat, mkdir, mkdtemp, realpath, rm, rmdir } from 'node:fs/promises'
import { extname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { z } from 'zod'
import { fileSha256 } from './cache.ts'
import { firstStreamOfType, MediaCommandError, probeMedia, runFfmpeg } from './ffmpeg.ts'
import { episodeNumberOf } from './paths.ts'
import { audioHash, audioPackets, frameHashes, probeClock, verifyMatchingPicturePrefix } from './source-clock-conform.ts'
import type { MediaToolkit } from './types.ts'

const mp4Input = ['-protocol_whitelist', 'file', '-f', 'mov', '-enable_drefs', '0'] as const
const maxInputBytes = 1024 ** 3
const maxOutputBytes = 4 * maxInputBytes
const maxDurationSeconds = 120
const maxTailSeconds = 3
const sha = z.string().regex(/^[a-f0-9]{64}$/u)
const file = z.strictObject({ path: z.string().min(1), sha256: sha })
const milliseconds = z.number().int().positive().max(maxDurationSeconds * 1000)
const startingFrame = z.number().int().positive().max(maxDurationSeconds * 60 - 1)

/** Actual output and exact picture/audio identities measured after local ending restoration. */
export const endingRestoreBindingSchema = z.strictObject({
  version: z.literal(1), project: z.string().min(1), episode: z.string().regex(/^\d{2,}$/u),
  original: file, donor: file, output: file, startMs: milliseconds, endMs: milliseconds,
  clock: z.strictObject({ rate: z.string().regex(/^[1-9]\d{0,6}\/[1-9]\d{0,6}$/u),
    frames: z.number().int().positive().max(maxDurationSeconds * 60),
    width: z.number().int().positive().max(4096), height: z.number().int().positive().max(4096),
    startFrame: startingFrame, bodySha256: sha, tailSha256: sha }),
  audio: z.strictObject({ sha256: sha, sampleRate: z.number().int().positive().max(192000),
    channels: z.number().int().positive(), packetsSha256: sha }),
})

/** Candidate identity and evidence of its retained body, replacement ending and original audio. */
export type EndingRestoreBinding = z.infer<typeof endingRestoreBindingSchema>

/** Project-owned original cut, alternate ending and exact replacement frame boundary. */
export interface EndingRestoreArgs {
  readonly project: string
  readonly episode: number
  readonly original: EndingRestoreBinding['original']
  readonly donor: EndingRestoreBinding['donor']
  /** Rounded millisecond value of a frame boundary inside the last three seconds. */
  readonly startMs: number
}

function invalid(detail: string): Error { return new Error(`ENDING_RESTORE: ${detail}`) }

async function canonicalDirectory(path: string): Promise<void> {
  if (await realpath(path) !== path || !(await lstat(path)).isDirectory()) throw invalid('候选位置不是项目内的规范目录。')
}

async function boundedFile(path: string, bytes: number): Promise<void> {
  const info = await lstat(path)
  if (!info.isFile() || info.size <= 0 || info.size > bytes) throw invalid('素材或候选大小超出允许范围。')
}

async function projectFile(project: string, declared: EndingRestoreBinding['original']) {
  const path = await realpath(resolve(project, declared.path))
  const rel = relative(project, path)
  if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel) || extname(path).toLowerCase() !== '.mp4'
    || !sha.safeParse(declared.sha256).success) throw invalid('需要项目内的本地 MP4 和已核对的素材摘要。')
  await boundedFile(path, maxInputBytes)
  return { path, sha256: declared.sha256 }
}

const pictureMetadata = z.object({
  streams: z.tuple([z.object({ pix_fmt: z.literal('yuv420p'), sample_aspect_ratio: z.enum(['1:1', '0:1', 'N/A']).optional(),
    color_range: z.string().optional(), color_space: z.string().optional(), color_primaries: z.string().optional(),
    color_transfer: z.string().optional(), chroma_location: z.string().optional(),
    side_data_list: z.array(z.object({ rotation: z.number().optional() })).optional() })]),
})

async function colorProfile(toolkit: MediaToolkit, path: string): Promise<readonly string[]> {
  const args = ['-v', 'error', ...mp4Input, '-select_streams', 'v:0', '-show_streams',
    '-show_entries', 'stream=pix_fmt,sample_aspect_ratio,color_range,color_space,color_primaries,color_transfer,chroma_location:stream_side_data=rotation',
    '-of', 'json', path]
  const outcome = await toolkit.channel.run(toolkit.ffprobe, args)
  if (outcome.code !== 0) throw new MediaCommandError(toolkit.ffprobe, args, outcome.code, outcome.stderr)
  const parsed = pictureMetadata.safeParse(JSON.parse(outcome.stdout))
  if (!parsed.success || parsed.data.streams[0].side_data_list?.some(data => (data.rotation ?? 0) !== 0) === true) {
    throw invalid('仅支持正向、方形像素的 8 位 YUV420P 画面。')
  }
  const video = parsed.data.streams[0]
  const options = [['-color_range', video.color_range], ['-colorspace', video.color_space],
    ['-color_primaries', video.color_primaries], ['-color_trc', video.color_transfer],
    ['-chroma_sample_location', video.chroma_location]] as const
  return options.flatMap(([option, value]) => value && value !== 'unknown' && value !== 'unspecified' ? [option, value] : [])
}

async function verifyFiles(files: readonly EndingRestoreBinding['original'][], signal?: AbortSignal): Promise<void> {
  for (const file of files) {
    await boundedFile(file.path, maxInputBytes)
    if (await realpath(file.path) !== file.path || await fileSha256(file.path, signal) !== file.sha256) {
      throw invalid('当前素材与本次已核对的摘要不一致。')
    }
  }
}

function hashesOf(frames: readonly string[]): string {
  return createHash('sha256').update(frames.join('\n')).digest('hex')
}

/**
 * Publish a new candidate only after every picture and the entire original audio match decoded readback.
 * @param toolkit - Owner of ffprobe and ffmpeg subprocesses.
 * @param args - Original/final donor identities and the measured tail boundary in this project.
 * @param signal - Owning tool cancellation.
 * @returns The local candidate and verified identities. Artistic approval is separate.
 */
export async function restoreEnding(toolkit: MediaToolkit, args: EndingRestoreArgs, signal?: AbortSignal): Promise<EndingRestoreBinding> {
  signal?.throwIfAborted()
  if (!Number.isSafeInteger(args.episode) || args.episode < 1 || !milliseconds.safeParse(args.startMs).success) {
    throw invalid('需要有效集号和画面边界毫秒值。')
  }
  const project = await realpath(args.project), episode = episodeNumberOf(args.episode)
  const original = await projectFile(project, args.original), donor = await projectFile(project, args.donor)
  if (original.path === donor.path || original.sha256 === donor.sha256) throw invalid('需要不同的原片和片尾来源。')
  const editing = join(project, 'editing')
  await mkdir(editing, { recursive: true })
  await canonicalDirectory(editing)
  const directory = await mkdtemp(join(editing, `ending-restore-${episode}-`))
  const a = join(directory, 'original.mp4'), b = join(directory, 'donor.mp4')
  const aFeatures = join(directory, 'original.rgb'), bFeatures = join(directory, 'donor.rgb')
  const pending = join(directory, 'candidate.mp4'), output = join(directory, 'clip.mp4')
  const snapshots = [{ path: a, sha256: original.sha256 }, { path: b, sha256: donor.sha256 }]
  let published = false
  try {
    await canonicalDirectory(directory)
    await copyFile(original.path, a, constants.COPYFILE_EXCL)
    await copyFile(donor.path, b, constants.COPYFILE_EXCL)
    await verifyFiles(snapshots, signal)
    const probe = { ...toolkit, channel: {
      run: (command: string, argv: readonly string[]) => toolkit.channel.run(command, [...mp4Input, ...argv]),
    } }
    const source = await probeMedia(probe, a), replacement = await probeMedia(probe, b)
    const video = firstStreamOfType(source, 'video'), replacementVideo = firstStreamOfType(replacement, 'video')
    const audio = firstStreamOfType(source, 'audio'), sampleRate = audio?.sampleRate ?? 0
    const width = video?.width ?? 0, height = video?.height ?? 0
    if (source.streams.length !== 2 || replacement.streams.filter(stream => stream.codecType === 'video').length !== 1
      || ![source, replacement].every(media => media.durationSeconds > 0 && media.durationSeconds <= maxDurationSeconds)
      || ![width, height].every(size => Number.isInteger(size) && size >= 2 && size <= 4096 && size % 2 === 0)
      || replacementVideo?.width !== width || replacementVideo.height !== height
      || audio?.codecName !== 'aac' || audio.startSeconds !== 0 || !audio.durationSeconds || !Number.isInteger(sampleRate)
      || sampleRate <= 0 || sampleRate > 192000) throw invalid('画幅、时长或原片原声超出支持范围。')
    const clock = await probeClock(toolkit, a), donorClock = await probeClock(toolkit, b)
    const { num, den } = clock.rate
    if (donorClock.count !== clock.count || donorClock.rate.num * den !== num * donorClock.rate.den) {
      throw invalid('片尾来源须与原片具备相同的完整帧数和帧率。')
    }
    const fps = Number(num) / Number(den)
    const startFrame = Math.round(args.startMs * fps / 1000), endMs = Math.round(clock.count * 1000 / fps)
    if (startFrame < 1 || startFrame >= clock.count || Math.round(startFrame * 1000 / fps) !== args.startMs
      || BigInt(clock.count - startFrame) * den > BigInt(maxTailSeconds) * num) {
      throw invalid('替换起点须为最后三秒内真实的帧边界。')
    }
    const profile = await colorProfile(toolkit, a)
    if (JSON.stringify(profile) !== JSON.stringify(await colorProfile(toolkit, b))) throw invalid('两份画面的颜色标记不一致。')
    await verifyMatchingPicturePrefix(toolkit, { path: a, features: aFeatures }, { path: b, features: bFeatures },
      clock.count, startFrame, signal)
    const audioProof = { sha256: await audioHash(toolkit, a), sampleRate, ...await audioPackets(toolkit, a) }
    const before = await frameHashes(toolkit, a, clock.count), after = await frameHashes(toolkit, b, clock.count)
    const body = before.slice(0, startFrame), tail = after.slice(startFrame)
    if (tail.every((hash, index) => hash === before[startFrame + index])) throw invalid('该时段的两份片尾画面相同。')

    signal?.throwIfAborted()
    const filter = `[0:v:0]trim=end_frame=${String(startFrame)},setpts=PTS-STARTPTS,setsar=1[body];`
      + `[1:v:0]trim=start_frame=${String(startFrame)},setpts=PTS-STARTPTS,setsar=1[tail];`
      + `[body][tail]concat=n=2:v=1:a=0,settb=${String(den)}/${String(num)},setpts=N[out]`
    await runFfmpeg(toolkit, ['-n', '-v', 'error', '-xerror', '-noautorotate', ...mp4Input, '-i', a,
      '-noautorotate', ...mp4Input, '-i', b, '-filter_complex', filter, '-map', '[out]', '-map', '0:a:0',
      '-map_metadata', '-1', '-map_chapters', '-1', '-r', clock.rateString, '-fps_mode', 'cfr', '-c:v', 'libx264',
      '-preset', 'ultrafast', '-qp', '0', '-pix_fmt', 'yuv420p', ...profile, '-c:a', 'copy',
      '-video_track_timescale', String(num), '-movie_timescale', String(sampleRate), '-movflags', '+faststart',
      '-fs', String(maxOutputBytes), pending])
    signal?.throwIfAborted()
    await boundedFile(pending, maxOutputBytes)
    const candidateSha256 = await fileSha256(pending, signal)
    const measured = await probeMedia(probe, pending), outputClock = await probeClock(toolkit, pending)
    const outputVideo = firstStreamOfType(measured, 'video'), outputAudio = firstStreamOfType(measured, 'audio')
    if (outputClock.count !== clock.count || outputClock.rate.num * den !== num * outputClock.rate.den
      || outputVideo?.width !== width || outputVideo.height !== height
      || JSON.stringify(await colorProfile(toolkit, pending)) !== JSON.stringify(profile)
      || outputAudio?.codecName !== 'aac' || outputAudio.startSeconds !== 0 || outputAudio.sampleRate !== sampleRate
      || outputAudio.durationSeconds !== audio.durationSeconds
      || await audioHash(toolkit, pending) !== audioProof.sha256
      || (await audioPackets(toolkit, pending)).packetsSha256 !== audioProof.packetsSha256) {
      throw invalid('候选回读的完整时钟、画面规格或原声不符。')
    }
    const expected = [...body, ...tail]
    const actual = await frameHashes(toolkit, pending, clock.count)
    if (actual.some((hash, index) => hash !== expected[index])) throw invalid('候选的原片身或新片尾与逐帧核对结果不符。')
    await verifyFiles([...snapshots, original, donor], signal)
    await boundedFile(pending, maxOutputBytes)
    if (await fileSha256(pending, signal) !== candidateSha256) throw invalid('候选文件在回读期间已经变化。')
    const binding = endingRestoreBindingSchema.parse({ version: 1, project, episode, original, donor,
      output: { path: output, sha256: candidateSha256 }, startMs: args.startMs, endMs,
      clock: { rate: clock.rateString, frames: clock.count, width, height, startFrame,
        bodySha256: hashesOf(body), tailSha256: hashesOf(tail) }, audio: audioProof })
    await canonicalDirectory(directory)
    signal?.throwIfAborted()
    await link(pending, output)
    published = true
    return binding
  } finally {
    await canonicalDirectory(directory)
    for (const path of [a, b, aFeatures, bFeatures, pending]) await rm(path, { force: true })
    if (!published) await rmdir(directory)
  }
}
