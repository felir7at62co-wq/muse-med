/** Decode the video and audio tracks of a verified provider output. */
import { execFile } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'
import { downloadMedia } from '@deepseek-ai/dsh-jubian-api'

const execute = promisify(execFile)

/**
 * Inspect both tracks of the exact downloaded bytes for decoding errors.
 * @param url - Verified provider video URL.
 * @param ffmpeg - Configured absolute FFmpeg executable path.
 * @param timeout - Maximum milliseconds per decoder invocation.
 * @param signal - Host cancellation.
 * @returns Media digest and decode verdict for each track.
 */
export async function checkVideoMedia(url: string, ffmpeg: string, timeout: number, signal: AbortSignal):
Promise<{ sha256: string; video: boolean; audio: boolean }> {
  const media = await downloadMedia(url, { kind: 'video', signal })
  const root = await mkdtemp(join(tmpdir(), 'muse-video-review-'))
  try {
    const path = join(root, 'output.mp4')
    await writeFile(path, media.bytes, { flag: 'wx', mode: 0o600, signal })
    return { sha256: media.sha256, ...await decodeVideoFile(path, ffmpeg, timeout, signal) }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

/**
 * Decode a local snapshot without allowing additional input protocols.
 * @param path - Absolute path of the captured media.
 * @param ffmpeg - Configured absolute FFmpeg executable path.
 * @param timeout - Maximum milliseconds per decoder invocation.
 * @param signal - Host cancellation.
 * @returns Decode verdict for each track.
 */
export async function decodeVideoFile(path: string, ffmpeg: string, timeout: number, signal: AbortSignal):
Promise<{ video: boolean; audio: boolean }> {
  const decode = async (track: string): Promise<boolean> => {
    try {
      await execute(ffmpeg, ['-nostdin', '-v', 'error', '-xerror', '-protocol_whitelist', 'file',
        '-f', 'mov', '-enable_drefs', '0', '-i', path, '-map', track, '-f', 'null', '-'], {
        cwd: dirname(path), signal, timeout, windowsHide: true, env: { SystemRoot: process.env.SystemRoot },
      })
      return true
    } catch (error) {
      signal.throwIfAborted()
      if (!(error instanceof Error) || !('code' in error) || typeof error.code !== 'number') throw error
      return false
    }
  }
  return { video: await decode('0:v:0'), audio: await decode('0:a:0') }
}
