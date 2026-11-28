/** Fit a local picture repair and its retained sound onto one measured source clock. */
import { constants } from 'node:fs'
import { copyFile, lstat, mkdir, mkdtemp, realpath, rm, rmdir } from 'node:fs/promises'
import { extname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileSha256 } from './cache.ts'
import { firstStreamOfType, frameRateOf, MediaCommandError, probeMedia, runFfmpeg } from './ffmpeg.ts'
import { episodeNumberOf } from './paths.ts'
import { measurePictureClock } from './picture-clock-readback.ts'
import type { MediaToolkit } from './types.ts'

const LOCAL_MP4_INPUT = ['-protocol_whitelist', 'file', '-f', 'mov', '-enable_drefs', '0']
const OUTPUT_SAMPLE_RATE = 48000
const INPUT_LIMIT_SECONDS = 120
const INPUT_LIMIT_BYTES = 1024 ** 3

/** A finite interval on the input MP4, with an optional rectangle in stored pixels. */
export interface LocalClipRepairArgs {
  readonly project: string
  readonly episode: number
  readonly input: string
  /** Exact previously reviewed bytes required by the strict local repair entry. */
  readonly expectedInputSha256?: string
  readonly startMs: number
  readonly endMs: number
  readonly crop?: { readonly x: number; readonly y: number; readonly width: number; readonly height: number }
}

/** Evidence issued by the trim tool after encoding, probing and hashing a new clip. */
export interface LocalClipRepairBinding {
  readonly project: string
  readonly episode: string
  readonly original: { readonly path: string; readonly sha256: string }
  readonly output: { readonly path: string; readonly sha256: string }
  readonly startMs: number
  readonly endMs: number
  readonly durationSeconds: number
  /** Diagnostic from the local readback. Stored receipts issued by older versions may omit it. */
  readonly pictureClock: { readonly status: 'matching' | 'unverified'; readonly matchingSamples: number }
}

function inside(root: string, path: string): boolean {
  const rel = relative(root, path)
  return rel !== '' && rel !== '..' && !isAbsolute(rel) && !rel.startsWith(`..${sep}`)
}

async function canonicalDirectory(path: string): Promise<void> {
  if (await realpath(path) !== path || !(await lstat(path)).isDirectory()) throw new Error('返工目录不是项目内的规范目录。')
}

function validateCrop(crop: NonNullable<LocalClipRepairArgs['crop']>, width: number, height: number): string {
  if (![crop.x, crop.y, crop.width, crop.height].every(value => Number.isSafeInteger(value) && value % 2 === 0)
    || crop.x < 0 || crop.y < 0 || crop.width < 2 || crop.height < 2
    || crop.x + crop.width > width || crop.y + crop.height > height) {
    throw new Error('裁切范围须在原图内，位置和尺寸必须符合偶数像素边界。')
  }
  return `crop=${crop.width}:${crop.height}:${crop.x}:${crop.y}`
}

function localProbe(toolkit: MediaToolkit): MediaToolkit {
  return { ...toolkit, channel: { run: (command, args) => toolkit.channel.run(command, [...LOCAL_MP4_INPUT, ...args]) } }
}

async function verifyDecodedClock(toolkit: MediaToolkit, path: string, fps: number, sampleRate: number, frameCount: number) {
  const args = ['-v', 'error', '-show_frames', '-show_entries', 'frame=media_type,best_effort_timestamp_time,nb_samples',
    '-of', 'json', path]
  const result = await toolkit.channel.run(toolkit.ffprobe, args)
  if (result.code !== 0) throw new MediaCommandError(toolkit.ffprobe, args, result.code, result.stderr)
  const data: unknown = JSON.parse(result.stdout)
  if (typeof data !== 'object' || data === null || !('frames' in data) || !Array.isArray(data.frames)) {
    throw new Error('未能读取返工源的解码时钟。')
  }
  let videoFrames = 0
  let audioSamples = 0
  const frames: readonly unknown[] = data.frames
  for (const frame of frames) {
    if (typeof frame !== 'object' || frame === null || !('media_type' in frame)
      || !('best_effort_timestamp_time' in frame) || typeof frame.best_effort_timestamp_time !== 'string'
      || !/^-?\d+(?:\.\d+)?$/u.test(frame.best_effort_timestamp_time)) {
      throw new Error('返工源含未能核实的解码时间戳。')
    }
    const time = Number(frame.best_effort_timestamp_time)
    if (frame.media_type === 'video') {
      if (Math.abs(time - videoFrames / fps) > 0.001) throw new Error('返工源视频帧率不恒定，或首帧没有对齐。')
      videoFrames += 1
    } else if (frame.media_type === 'audio') {
      if (Math.round(time * sampleRate) !== audioSamples || !('nb_samples' in frame)
        || typeof frame.nb_samples !== 'number' || !Number.isSafeInteger(frame.nb_samples) || frame.nb_samples <= 0) {
        throw new Error('返工源音频时钟有空缺或重叠，无法保留原声。')
      }
      audioSamples += frame.nb_samples
    }
  }
  if (videoFrames !== frameCount || audioSamples === 0) throw new Error('解码帧数或原声不足以核实返工时钟。')
  return audioSamples
}

/**
 * Produce a separate project-local repair. Millisecond endpoints must come from
 * rounded frame boundaries. Trim both picture and original sound to that same
 * window, and do not synthesize audio samples for uncovered time.
 * @param toolkit - Project subprocess owner and bundled media binaries.
 * @param args - Source MP4, episode, bounded interval and optional crop.
 * @param signal - Owning tool cancellation. The subprocess channel owns child teardown.
 * @returns The source/output identities and measured clip duration.
 */
export async function repairLocalClip(toolkit: MediaToolkit, args: LocalClipRepairArgs,
  signal?: AbortSignal): Promise<LocalClipRepairBinding> {
  signal?.throwIfAborted()
  if (!Number.isSafeInteger(args.episode) || args.episode < 1
    || !Number.isSafeInteger(args.startMs) || !Number.isSafeInteger(args.endMs)
    || args.startMs < 0 || args.endMs <= args.startMs || args.endMs > INPUT_LIMIT_SECONDS * 1000) {
    throw new Error('返工需要正整数集号、非负毫秒起点和较大的结束毫秒，源片最长 120 秒。')
  }
  const project = await realpath(args.project)
  const source = await realpath(resolve(project, args.input))
  if (!inside(project, source) || extname(source).toLowerCase() !== '.mp4') throw new Error('返工源必须是项目内 MP4。')
  const sourceInfo = await lstat(source)
  if (!sourceInfo.isFile() || sourceInfo.size <= 0 || sourceInfo.size > INPUT_LIMIT_BYTES) {
    throw new Error('返工源必须是完整的本地文件，大小不超过 1 GiB。')
  }
  const expected = args.expectedInputSha256
  if (expected !== undefined && await fileSha256(source, signal) !== expected) {
    throw new Error('VISUAL_REPAIR_EVIDENCE: 源片和已审看的版本不符。')
  }
  const episode = episodeNumberOf(args.episode)
  const editing = join(project, 'editing')
  await mkdir(editing, { recursive: true })
  await canonicalDirectory(editing)
  const directory = await mkdtemp(join(editing, `local-repair-${episode}-`))
  const snapshot = join(directory, 'original-snapshot.mp4')
  const output = join(directory, 'clip.mp4')
  let finished = false
  try {
    await canonicalDirectory(directory)
    const sourceHash = expected ?? await fileSha256(source, signal)
    await copyFile(source, snapshot, constants.COPYFILE_EXCL)
    if (await fileSha256(snapshot, signal) !== sourceHash) throw new Error('返工源在复制时变化，请用稳定素材重试。')
    const probe = localProbe(toolkit)
    const media = await probeMedia(probe, snapshot)
    const video = firstStreamOfType(media, 'video')
    const audio = firstStreamOfType(media, 'audio')
    const width = video?.width ?? 0
    const height = video?.height ?? 0
    const rate = video?.avgFrameRate ?? ''
    const fps = frameRateOf(video)
    const frameCount = video?.frameCount ?? 0
    const audioRate = audio?.sampleRate ?? 0
    if (media.durationSeconds <= 0 || media.durationSeconds > INPUT_LIMIT_SECONDS + 0.001
      || media.streams.filter(stream => stream.codecType === 'video').length !== 1
      || media.streams.filter(stream => stream.codecType === 'audio').length !== 1
      || ![width, height].every(value => Number.isSafeInteger(value) && value >= 2 && value <= 4096 && value % 2 === 0)
      || !/^[1-9]\d{0,6}\/[1-9]\d{0,6}$/u.test(rate)
      || fps < 1 || fps > 120 || !Number.isSafeInteger(frameCount) || frameCount <= 0
      || !Number.isSafeInteger(audioRate) || audioRate <= 0 || audioRate > 192000
      || video?.startSeconds !== 0 || audio?.startSeconds !== 0
      || Math.abs((video.durationSeconds ?? 0) - frameCount / fps) > 0.001) {
      throw new Error('返工要求零起点、可核恒定帧率的视频和一条原声轨。')
    }
    const first = Math.round(args.startMs * fps / 1000)
    const end = Math.round(args.endMs * fps / 1000)
    if (end > frameCount || end <= first || Math.round(first * 1000 / fps) !== args.startMs
      || Math.round(end * 1000 / fps) !== args.endMs) {
      throw new Error('返工切点须为源帧边界四舍五入后的毫秒值，且必须在源片内。')
    }
    const crop = args.crop === undefined ? '' : `,${validateCrop(args.crop, width, height)}`
    const decodedAudioSamples = await verifyDecodedClock(probe, snapshot, fps, audioRate, frameCount)
    const duration = (end - first) / fps
    const firstSample = Math.round(first * OUTPUT_SAMPLE_RATE / fps)
    const endSample = Math.round(end * OUTPUT_SAMPLE_RATE / fps)
    const audioEnd = Math.min(audio.durationSeconds ?? 0, decodedAudioSamples / audioRate)
    if (endSample > Math.round(audioEnd * OUTPUT_SAMPLE_RATE)) throw new Error('返工原声未覆盖所选视频区间。')
    // One timestamp tick per sample avoids rounding down an integer sample index during a long trim.
    const audioTrim = `aresample=${OUTPUT_SAMPLE_RATE},atrim=start_sample=${firstSample}:end_sample=${endSample},`
      + `asettb=1/${OUTPUT_SAMPLE_RATE},asetpts=N`
    signal?.throwIfAborted()
    await runFfmpeg(toolkit, ['-n', '-v', 'error', '-xerror', '-noautorotate', ...LOCAL_MP4_INPUT, '-i', snapshot,
      '-map', '0:v:0', '-map', '0:a:0', '-map_metadata', '-1', '-map_chapters', '-1',
      '-vf', `trim=start_frame=${first}:end_frame=${end},setpts=PTS-STARTPTS${crop}`,
      '-af', audioTrim,
      '-r', rate, '-fps_mode', 'cfr', '-c:v', 'libx264', '-preset', 'fast', '-crf', '16', '-pix_fmt', 'yuv420p',
      '-c:a', 'aac', '-ar', String(OUTPUT_SAMPLE_RATE), '-b:a', '320k',
      '-video_track_timescale', rate.slice(0, rate.indexOf('/')), '-movie_timescale', String(OUTPUT_SAMPLE_RATE),
      '-movflags', '+faststart', output])
    signal?.throwIfAborted()
    const produced = await probeMedia(probe, output)
    const picture = firstStreamOfType(produced, 'video')
    const sound = firstStreamOfType(produced, 'audio')
    const durationSeconds = picture?.durationSeconds ?? 0
    if (picture?.startSeconds !== 0 || sound?.startSeconds !== 0 || picture.frameCount !== end - first
      || picture.width !== (args.crop?.width ?? width) || picture.height !== (args.crop?.height ?? height)
      || Math.abs(durationSeconds - duration) > 0.000002
      || sound.codecName !== 'aac' || sound.sampleRate !== OUTPUT_SAMPLE_RATE
      || Math.abs((sound.durationSeconds ?? 0) * OUTPUT_SAMPLE_RATE - (endSample - firstSample)) > 1) {
      throw new Error('返工输出的画面或声音与同源切点不一致，请保留原片。')
    }
    const outputSamples = await verifyDecodedClock(probe, output, fps, OUTPUT_SAMPLE_RATE, end - first)
    const outputHash = await fileSha256(output, signal)
    const sampleFrames = [...new Set([0.25, 0.55, 0.8].map(fraction => Math.floor((end - first) * fraction)))]
    const pictures = await measurePictureClock(toolkit, {
      reference: snapshot, output,
      samples: sampleFrames.map(frame => ({ referenceSeconds: (first + frame) / fps, outputSeconds: frame / fps })),
      ...(args.crop === undefined ? {} : { referenceCrop: args.crop }),
    }, signal)
    const mismatches = pictures.samples.filter(sample => sample.status === 'mismatched')
    if (mismatches.length >= 2) {
      const times = mismatches.map(sample => sample.referenceSeconds.toFixed(3)).join('、')
      throw new Error(`LOCAL_CLIP_PICTURE_CLOCK: 候选画面与原片 ${times} 秒不符。请复查剪切范围后再生成候选。`)
    }
    const matchingSamples = pictures.samples.filter(sample => sample.status === 'matching').length
    const pictureStatus = matchingSamples >= 2 && mismatches.length === 0
      && pictures.samples.every(sample => sample.reason !== 'unavailable') ? 'matching' : 'unverified'
    if (outputSamples < endSample - firstSample || await fileSha256(snapshot, signal) !== sourceHash
      || await fileSha256(source, signal) !== sourceHash || await fileSha256(output, signal) !== outputHash) {
      throw new Error('返工输出解码不完整，或原片及候选发生变化。')
    }
    await rm(snapshot)
    finished = true
    return { project, episode, original: { path: source, sha256: sourceHash }, output: { path: output, sha256: outputHash },
      startMs: args.startMs, endMs: args.endMs, durationSeconds, pictureClock: { status: pictureStatus, matchingSamples } }
  } finally {
    if (!finished) {
      await canonicalDirectory(directory)
      await rm(snapshot, { force: true })
      await rm(output, { force: true })
      await rmdir(directory)
    }
  }
}
