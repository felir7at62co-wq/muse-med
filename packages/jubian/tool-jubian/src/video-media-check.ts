/** Decode exact provider bytes through the Host's managed native subprocess service. */
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { downloadMedia } from '@deepseek-ai/dsh-jubian-api'
import type { SubprocessOutcome, SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'

/** Fully resolved native decoder and deployment-selected process limits. */
export interface VideoMediaDecoder {
  readonly subprocess: SubprocessRuntime
  readonly ffmpegPath: string
  readonly timeoutMs: number
  readonly graceMs: number
  readonly maxOutputBytes: number
}

/** Managed-range observation failed; its input must remain available for diagnosis. */
export class VideoMediaDrainError extends Error {}

/**
 * Inspect both tracks of the exact downloaded provider output.
 * @param url - Verified provider video URL.
 * @param decoder - Resolved Host decoder and process limits.
 * @param signal - Owning operation cancellation.
 * @returns Provider SHA-256 and independent video/audio decode verdicts.
 */
export async function checkVideoMedia(url: string, decoder: VideoMediaDecoder, signal: AbortSignal):
Promise<{ sha256: string; video: boolean; audio: boolean }> {
  const media = await downloadMedia(url, { kind: 'video', signal })
  const root = await mkdtemp(join(tmpdir(), 'muse-video-review-'))
  let cleanupSafe = true
  try {
    const path = join(root, 'output.mp4')
    await writeFile(path, media.bytes, { flag: 'wx', mode: 0o600, signal })
    return { sha256: media.sha256, ...await decodeVideoFile(path, decoder, signal) }
  } catch (error) {
    cleanupSafe = !(error instanceof VideoMediaDrainError)
    throw error
  } finally {
    if (cleanupSafe) await rm(root, { recursive: true, force: true })
  }
}

/**
 * Decode a local MOV/MP4 without external protocols or data references.
 * @param path - Absolute captured media path.
 * @param decoder - Resolved Host decoder and process limits.
 * @param signal - Owning operation cancellation.
 * @returns Independent track verdicts after the managed process range has exited.
 */
export async function decodeVideoFile(path: string, decoder: VideoMediaDecoder, signal: AbortSignal):
Promise<{ video: boolean; audio: boolean }> {
  const decode = async (track: string): Promise<boolean> => {
    signal.throwIfAborted()
    const timeout = AbortSignal.timeout(decoder.timeoutMs)
    const control = AbortSignal.any([signal, timeout])
    const handle = decoder.subprocess.spawn({
      argv: [decoder.ffmpegPath, '-nostdin', '-v', 'error', '-xerror', '-protocol_whitelist', 'file',
        '-f', 'mov', '-enable_drefs', '0', '-i', path, '-map', track, '-f', 'null', '-'],
      cwd: dirname(path), signal: control, graceMs: decoder.graceMs,
      stdio: { stdin: 'ignore', stdout: { maxBytes: decoder.maxOutputBytes }, stderr: { maxBytes: decoder.maxOutputBytes } },
      env: Object.fromEntries(Object.keys(process.env)
        .filter(key => /COOKIE|PROXY|PYTHON|NODE_OPTIONS|NODE_PATH|^MUSE(_MED)?_HOME$/iu.test(key))
        .map(key => [key, undefined])),
    })
    let outcome: SubprocessOutcome
    try {
      try { outcome = await handle.done }
      finally {
        handle.terminate()
        try {
          if (!await handle.waitForExit()) throw new Error('Decoder range remains active')
        } catch (error) {
          throw new VideoMediaDrainError('Could not confirm decoder shutdown; captured media was retained', { cause: error })
        }
      }
    } catch (error) {
      if (error instanceof VideoMediaDrainError) throw error
      signal.throwIfAborted()
      if (timeout.aborted) return false
      throw error
    }
    signal.throwIfAborted()
    return !timeout.aborted && outcome.exitCode === 0 && outcome.signal === null
      && !handle.collected.stdout?.readFrom(0).lossy && !handle.collected.stderr?.readFrom(0).lossy
  }
  return { video: await decode('0:v:0'), audio: await decode('0:a:0') }
}
