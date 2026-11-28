/** Reproduce and check the exact 48 kHz stereo PCM playback of a rendered episode. */
import { lstat } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import { z } from 'zod'
import { fileSha256 } from './cache.ts'
import { runFfmpeg } from './ffmpeg.ts'
import type { MediaToolkit } from './types.ts'

const sampleRate = 48_000
const channels = 2
const hash = z.string().regex(/^[0-9a-f]{64}$/u)
const positiveInteger = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER)

/** Retained playback track bound to a particular rendered MP4 and its playable audio samples. */
export const renderedDraftMixSchema = z.object({ schema_version: z.literal(1), path: z.string().min(1),
  sha256: hash, source_mp4_sha256: hash, pcm_sha256: hash, sample_count: positiveInteger,
  duration_us: positiveInteger, sample_rate: z.literal(sampleRate), channels: z.literal(channels) })

/** Shared receipt for the draft generator and the formal archive verifier. */
export type RenderedDraftMix = z.infer<typeof renderedDraftMixSchema>

const audioProbe = z.object({ streams: z.array(z.object({ codec_name: z.string(), sample_rate: z.string(),
  channels: z.number(), time_base: z.string(), start_pts: z.number().optional(), duration_ts: z.number() })) })

async function regularDigest(path: string, signal?: AbortSignal): Promise<string> {
  if (!isAbsolute(path) || !(await lstat(path)).isFile()) {
    throw new Error('剪映播放混音需要真实的本地音视频文件。')
  }
  return await fileSha256(path, signal)
}

async function sampleCount(toolkit: MediaToolkit, path: string, wav: boolean): Promise<number> {
  const result = await toolkit.channel.run(toolkit.ffprobe, ['-v', 'error', '-protocol_whitelist', 'file',
    '-select_streams', 'a', '-show_entries', 'stream=codec_name,sample_rate,channels,time_base,start_pts,duration_ts',
    '-of', 'json', path])
  if (result.code !== 0) throw new Error('无法核对剪映播放混音的声道和样本时间。')
  const decoded = audioProbe.safeParse(JSON.parse(result.stdout))
  const streams = decoded.success ? decoded.data.streams : []
  const stream = streams[0]
  if (streams.length !== 1 || stream === undefined || stream.sample_rate !== String(sampleRate)
    || stream.channels !== channels || stream.time_base !== `1/${String(sampleRate)}`
    || (wav ? stream.codec_name !== 'pcm_s16le' || (stream.start_pts ?? 0) !== 0 : stream.start_pts !== 0)
    || !positiveInteger.safeParse(stream.duration_ts).success) {
    throw new Error('剪映播放混音需要起点为零且可测量的单条 48 kHz 双声道。')
  }
  return stream.duration_ts
}

function decodeAudio(path: string, count: number): string[] {
  return ['-v', 'error', '-nostdin', '-protocol_whitelist', 'file', '-i', path, '-map', '0:a:0',
    '-af', `atrim=end_sample=${String(count)}`, '-c:a', 'pcm_s16le', '-ar', String(sampleRate), '-ac', String(channels)]
}

async function pcmDigest(toolkit: MediaToolkit, path: string, count: number): Promise<string> {
  const result = await toolkit.channel.run(toolkit.ffmpeg, [...decodeAudio(path, count), '-f', 'hash', '-hash', 'sha256', '-'])
  const digest = result.stdout.trim().match(/^SHA256=([0-9a-f]{64})$/u)?.[1]
  if (result.code !== 0 || digest === undefined) throw new Error('无法核对剪映播放混音的实际 PCM。')
  return digest
}

function durationUs(count: number): number { return Math.round(count * 1_000_000 / sampleRate) }

/** Decode the exact playable audio duration, excluding AAC encoder padding.
 * @param toolkit - Managed FFmpeg and ffprobe process access.
 * @param output - Current regular rendered MP4.
 * @param expectedSha - Actual output digest from the paired render receipt.
 * @param target - New disposable WAV path in the Host's managed draft staging directory.
 * @param signal - Cancellation of file reads and the owning media range.
 * @returns Canonical playback track and its observed source, clock and PCM hashes.
 */
export async function prepareRenderedDraftMix(toolkit: MediaToolkit, output: string, expectedSha: string,
  target: string, signal?: AbortSignal): Promise<RenderedDraftMix> {
  if (await regularDigest(output, signal) !== expectedSha) throw new Error('成片已变化，请重新选用配套成片。')
  const count = await sampleCount(toolkit, output, false)
  await runFfmpeg(toolkit, [...decodeAudio(output, count), '-n', '-map_metadata', '-1', '-f', 'wav', target])
  if (await sampleCount(toolkit, target, true) !== count || await regularDigest(output, signal) !== expectedSha) {
    throw new Error('提取剪映播放混音期间成片或音轨时钟发生变化。')
  }
  return renderedDraftMixSchema.parse({ schema_version: 1, path: target, sha256: await regularDigest(target, signal),
    source_mp4_sha256: expectedSha, pcm_sha256: await pcmDigest(toolkit, target, count),
    sample_count: count, duration_us: durationUs(count), sample_rate: sampleRate, channels })
}

/** Compare retained PCM against a fresh decode of the exact current MP4.
 * @param toolkit - Managed FFmpeg and ffprobe process access.
 * @param output - Current working MP4 from the same render and archive.
 * @param mix - Parsed receipt for its retained playback WAV.
 * @param signal - Cancellation for current-file verification.
 */
export async function verifyRenderedDraftMix(toolkit: MediaToolkit, output: string, mix: RenderedDraftMix,
  signal?: AbortSignal): Promise<void> {
  const count = mix.sample_count
  if (mix.duration_us !== durationUs(count) || await regularDigest(output, signal) !== mix.source_mp4_sha256
    || await regularDigest(mix.path, signal) !== mix.sha256 || await sampleCount(toolkit, output, false) !== count
    || await sampleCount(toolkit, mix.path, true) !== count) {
    throw new Error('剪映播放混音与当前成片的文件或样本数不一致。')
  }
  const [outputPcm, retainedPcm] = await Promise.all([
    pcmDigest(toolkit, output, count), pcmDigest(toolkit, mix.path, count),
  ])
  if (outputPcm !== mix.pcm_sha256 || retainedPcm !== mix.pcm_sha256
    || await regularDigest(output, signal) !== mix.source_mp4_sha256 || await regularDigest(mix.path, signal) !== mix.sha256) {
    throw new Error('剪映播放混音与当前成片实际解码的 PCM 不一致。')
  }
}
