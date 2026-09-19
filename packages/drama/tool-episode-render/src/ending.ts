/**
 * The two-second ending: the last body shot's real tail frame, and the effect
 * blended over it.
 *
 * The tail frame is extracted by seeking to the end (`-sseof`) and is then
 * *proved* against a full sequential decode, because a too-short seek window
 * returns exit code 0 without writing any file — a silent failure that produced
 * an ending built from the wrong frame. The seek window here is 0.1 seconds, and
 * the extracted frame's `framemd5` must equal the last frame of a sequential
 * decode; when it does not, the frame is re-extracted by index, and if that still
 * does not match, the render stops instead of freezing an unverified frame.
 *
 * @module @deepseek-ai/dsh-tool-episode-render/ending
 */

import { ENDING_SECONDS, endingEffectFilter } from './delivery.ts'
import { runFfmpeg } from './ffmpeg.ts'
import { pathExists } from './paths.ts'
import type { MediaToolkit, TailFrameEvidence } from './types.ts'

/**
 * How far before the end the seek starts.
 *
 * `-sseof -0.05` returns exit code 0 without writing a file on some sources, so
 * the window is widened rather than trusted. See the module note.
 */
export const TAIL_SEEK_SECONDS = '-0.1'

/** The pixel format both sides of the comparison are hashed in. */
const COMPARISON_PIXEL_FORMAT = 'rgb24'

/**
 * The last video frame's index in a sequential `framemd5` report.
 * @param frameCount - Frames the report listed.
 * @returns The 0-based index of the final frame.
 */
export function lastFrameIndex(frameCount: number): number {
  return frameCount - 1
}

/**
 * Read the frame hashes from a `framemd5` report.
 *
 * `framemd5` writes one comma-separated line per frame and one hash-only line per
 * stream, so only the per-frame lines are hashes of the picture.
 * @param output - Everything `framemd5` wrote to standard output.
 * @returns One MD5 per decoded frame, in decode order.
 */
export function parseFramemd5(output: string): string[] {
  const hashes: string[] = []
  for (const line of output.split(/\r?\n/)) {
    const fields = line.split(',')
    if (fields.length < 2 || !/^\s*\d+\s*$/.test(fields.slice(0, 1).join(''))) continue
    const hash = fields.slice(-1).join('').trim()
    if (hash !== '') hashes.push(hash)
  }
  return hashes
}

/**
 * Hash one image file's single frame.
 * @param toolkit - The binaries and channel to use.
 * @param file - Absolute path of the image to decode.
 * @returns The frame's MD5.
 * @throws {Error} When the file holds no decodable frame.
 */
async function frameHash(toolkit: MediaToolkit, file: string): Promise<string> {
  const outcome = await toolkit.channel.run(toolkit.ffmpeg, [
    '-v', 'error', '-i', file, '-pix_fmt', COMPARISON_PIXEL_FORMAT, '-f', 'framemd5', '-',
  ])
  if (outcome.code !== 0) {
    throw new Error(`无法读取尾帧 ${file} 的 framemd5：${outcome.stderr.trim()}。`
      + '请确认该 PNG 没有被截断；必要时删掉渲染缓存目录后重跑 render。')
  }
  const hashes = parseFramemd5(outcome.stdout)
  const hash = hashes.slice(-1).join('')
  if (hash === '') {
    throw new Error(`${file}: 解不出任何一帧的 framemd5，说明这个尾帧文件是空的或已损坏。`
      + '请删掉渲染缓存目录后重跑 render。')
  }
  return hash
}

/**
 * Hash every frame of one video by decoding it from the start.
 * @param toolkit - The binaries and channel to use.
 * @param file - Absolute path of the video to decode.
 * @returns The frame hashes in decode order.
 * @throws {Error} When the decode fails or yields no frame.
 */
async function sequentialFrameHashes(toolkit: MediaToolkit, file: string): Promise<string[]> {
  const outcome = await toolkit.channel.run(toolkit.ffmpeg, [
    '-v', 'error', '-i', file, '-an', '-pix_fmt', COMPARISON_PIXEL_FORMAT, '-f', 'framemd5', '-',
  ])
  if (outcome.code !== 0) {
    throw new Error(`无法顺序解码 ${file} 取尾帧：${outcome.stderr.trim()}。`
      + '请确认该镜的成片文件可完整解码，修复后重跑 render。')
  }
  const hashes = parseFramemd5(outcome.stdout)
  if (hashes.length === 0) {
    throw new Error(`${file}: 顺序解码没有得到任何一帧，说明该镜的成片是空的或已损坏。`
      + '请重新导出该镜后重跑 render。')
  }
  return hashes
}

/**
 * Extract the ending frame and prove it is the source's real last frame.
 * @param toolkit - The binaries and channel to use.
 * @param sourceVideo - Absolute path of the last body shot's video.
 * @param target - Absolute path of the PNG to write.
 * @returns The written frame plus the evidence that it is the tail frame.
 * @throws {Error} When the seek writes nothing, or the extracted frame cannot be proved to be the tail.
 */
export async function extractTailFrame(
  toolkit: MediaToolkit,
  sourceVideo: string,
  target: string,
): Promise<TailFrameEvidence> {
  await runFfmpeg(toolkit, [
    '-y', '-v', 'error', '-sseof', TAIL_SEEK_SECONDS, '-i', sourceVideo, '-frames:v', '1', '-f', 'image2', target,
  ])
  if (!await pathExists(target)) {
    throw new Error(`尾帧抽取没有写出任何文件：${target}`
      + `（用 -sseof ${TAIL_SEEK_SECONDS} 从 ${sourceVideo} 抽取）。`
      + '这是 -sseof 窗口过短导致的静默失败：请把 TAIL_SEEK_SECONDS 放宽到 -0.1 以上，'
      + '或先用 ffmpeg -i 该文件确认它真的含视频帧。')
  }
  const frameMd5 = await frameHash(toolkit, target)
  const hashes = await sequentialFrameHashes(toolkit, sourceVideo)
  const sequentialTailMd5 = hashes.slice(-1).join('')
  if (frameMd5 === sequentialTailMd5) {
    return { path: target, frameMd5, sequentialTailMd5, fromSequentialDecode: false, matchesSequentialTail: true }
  }
  await runFfmpeg(toolkit, [
    '-y', '-v', 'error', '-i', sourceVideo,
    '-vf', `select=eq(n\\,${String(lastFrameIndex(hashes.length))})`,
    '-frames:v', '1', '-f', 'image2', target,
  ])
  const decodedMd5 = await frameHash(toolkit, target)
  if (decodedMd5 !== sequentialTailMd5) {
    throw new Error(`尾帧校验不通过：按索引抽出的帧 ${decodedMd5} 与顺序解码的最后一帧 ${sequentialTailMd5} 不一致`
      + `（源文件 ${sourceVideo}）。请确认该文件在渲染期间没有被改写，然后重跑 render。`)
  }
  return {
    path: target,
    frameMd5: decodedMd5,
    sequentialTailMd5,
    fromSequentialDecode: true,
    matchesSequentialTail: true,
  }
}

/**
 * Build the ending clip from the frozen frame and the ending effect.
 *
 * The freeze image is a looped input and `-t` cuts the result at exactly
 * {@link ENDING_SECONDS}, so the ending's length never depends on the effect's own
 * duration.
 * @param toolkit - The binaries and channel to use.
 * @param tailFrame - Absolute path of the frozen frame.
 * @param effect - Absolute path of the ending effect video.
 * @param target - Absolute path of the clip to write.
 * @param encoder - The encoder the body clips were encoded with.
 * @param encoderArgs - That encoder's rate-control arguments.
 */
export async function buildEndingClip(
  toolkit: MediaToolkit,
  tailFrame: string,
  effect: string,
  target: string,
  encoder: string,
  encoderArgs: readonly string[],
): Promise<void> {
  await runFfmpeg(toolkit, [
    '-y', '-v', 'error', '-loop', '1', '-i', tailFrame, '-i', effect,
    '-filter_complex', endingEffectFilter(), '-map', '[v]',
    '-t', ENDING_SECONDS.toFixed(3), '-an', '-c:v', encoder, ...encoderArgs, target,
  ])
}
