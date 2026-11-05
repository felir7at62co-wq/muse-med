/** Verify a local editor export against the exact approved picture and audio. */
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { lstat, realpath } from 'node:fs/promises'
import { dirname, join, relative } from 'node:path'
import { promisify } from 'node:util'
import { MEDIA_LIMITS } from '@deepseek-ai/dsh-jubian-api'
import type { ApprovedClipDelivery } from './types.ts'
import { decodeVideoFile } from './video-media-check.ts'

const execute = promisify(execFile)
const frameBytes = 64 * 36
const audioRate = 4000

async function hashMedia(path: string): Promise<string> {
  const hash = createHash('sha256')
  let size = 0
  for await (const chunk of createReadStream(path)) {
    if (!Buffer.isBuffer(chunk)) throw new Error('Expected video bytes')
    size += chunk.length
    if (size > MEDIA_LIMITS.video) throw new Error('Export exceeds the video size limit')
    hash.update(chunk)
  }
  return hash.digest('hex')
}

function pictureSimilarity(expected: Buffer, actual: Buffer): number {
  const length = Math.min(expected.length, actual.length)
  if (length < frameBytes || Math.abs(expected.length - actual.length) > frameBytes) return 0
  let minimum = 1
  for (let start = 0; start + frameBytes <= length; start += frameBytes) {
    let distance = 0
    for (let i = start; i < start + frameBytes; i += 1) {
      distance += Math.abs(expected.readUInt8(i) - actual.readUInt8(i))
    }
    minimum = Math.min(minimum, 1 - distance / (frameBytes * 255))
  }
  return minimum
}

function soundSimilarity(expected: Buffer, actual: Buffer): number {
  const length = Math.min(expected.length, actual.length) / 2
  const margin = audioRate / 10
  if (length <= 2 * margin || Math.abs(expected.length - actual.length) > audioRate * 0.25) return 0
  let best = 0
  for (let lag = -margin; lag <= margin; lag += 1) {
    let product = 0
    let sourceEnergy = 0
    let exportEnergy = 0
    for (let i = margin; i < length - margin; i += 4) {
      const source = expected.readInt16LE(i * 2)
      const output = actual.readInt16LE((i + lag) * 2)
      product += source * output
      sourceEnergy += source * source
      exportEnergy += output * output
    }
    if (sourceEnergy === 0 && exportEnergy === 0) return 1
    if (sourceEnergy > 0 && exportEnergy > 0) {
      const gain = exportEnergy / sourceEnergy
      if (gain >= 0.25 && gain <= 4) best = Math.max(best, product / Math.sqrt(sourceEnergy * exportEnergy))
    }
  }
  return best
}

async function samples(path: string, ffmpeg: string, timeout: number, signal: AbortSignal) {
  const run = async (args: string[]) => (await execute(ffmpeg, [
    '-nostdin', '-v', 'error', '-xerror', '-protocol_whitelist', 'file', '-f', 'mov', '-enable_drefs', '0',
    '-i', path, ...args, '-',
  ], {
    cwd: dirname(path), timeout, signal, windowsHide: true,
    env: { SystemRoot: process.env.SystemRoot }, encoding: 'buffer', maxBuffer: 4 * 1024 * 1024,
  })).stdout
  const picture = await run(['-map', '0:v:0', '-vf', 'fps=4,scale=64:36,format=gray', '-f', 'rawvideo'])
  const sound = await run(['-map', '0:a:0', '-ac', '1', '-ar', String(audioRate), '-f', 's16le'])
  return { picture, sound }
}

/**
 * Decode the exported MP4, compare its frames and audio, and bind the result to both hashes.
 * @param projectDir - Authorized project root.
 * @param source - Absolute path to the managed approved video.
 * @param sourceSha256 - Hash from the approved report.
 * @param path - Project-relative MP4 in the exports directory.
 * @param ffmpeg - Trusted Host FFmpeg path.
 * @param timeout - Maximum decoder invocation duration in milliseconds.
 * @param signal - Host cancellation.
 * @returns The verified export path, hash and similarity scores between zero and one.
 */
export async function verifyApprovedClipExport(projectDir: string, source: string, sourceSha256: string, path: string,
  ffmpeg: string, timeout: number, signal: AbortSignal): Promise<NonNullable<ApprovedClipDelivery['export']>> {
  if (!/^exports\/[\p{L}\p{N}_][\p{L}\p{N}_. ()-]{0,150}\.mp4$/iu.test(path)
    || /^exports\/(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(path)) {
    throw new Error('Select an MP4 directly inside the project exports directory')
  }
  const exportPath = join(projectDir, path)
  const folder = await lstat(dirname(exportPath))
  const file = await lstat(exportPath)
  if (!folder.isDirectory() || !file.isFile()
    || file.size > MEDIA_LIMITS.video || relative(exportPath, await realpath(exportPath)) !== '') {
    throw new Error('Select a regular export file within the project')
  }
  const sha256 = await hashMedia(exportPath)
  if (await hashMedia(source) !== sourceSha256) throw new Error('Approved media changed')
  const checks = await decodeVideoFile(exportPath, ffmpeg, timeout, signal)
  if (!checks.video || !checks.audio) throw new Error('The export must have decodable video and audio')
  const approved = await samples(source, ffmpeg, timeout, signal)
  const exported = await samples(exportPath, ffmpeg, timeout, signal)
  const videoSimilarity = pictureSimilarity(approved.picture, exported.picture)
  const audioSimilarity = soundSimilarity(approved.sound, exported.sound)
  if (videoSimilarity < 0.94 || audioSimilarity < 0.95) {
    throw new Error('Exported picture or audio does not match the approved video')
  }
  if (await hashMedia(source) !== sourceSha256 || await hashMedia(exportPath) !== sha256) {
    throw new Error('The approved source or export changed during verification')
  }
  return { path, sha256, videoSimilarity, audioSimilarity }
}
