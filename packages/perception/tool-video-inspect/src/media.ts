/** Bounded media subprocesses in the same execution world as the filesystem. */
import type { Context } from '@deepseek-ai/cordis'
import type { SandboxExecutionPolicy } from '@deepseek-ai/dsh-sandbox'
import { SandboxUnavailableError } from '@deepseek-ai/dsh-sandbox'
import type {} from '@deepseek-ai/dsh-subprocess'

/** Byte output and diagnostic text of one completed media operation. */
export interface MediaOutput {
  /** Complete bounded stdout bytes. */
  bytes: Uint8Array
  /** Bounded stderr, containing frame timestamps for extraction. */
  diagnostic: string
}

/**
 * Execute one media command with bounded output and awaited cancellation.
 * @param ctx - Registered subprocess runtime and optional confinement provider.
 * @param argv - Verified executable followed by non-shell arguments.
 * @param policy - Session-derived filesystem execution policy.
 * @param signal - Cancels the owned process range.
 * @param limits - Command duration, byte output and termination bounds.
 * @returns Complete stdout and bounded diagnostics from a successful command.
 */
export async function runMedia(ctx: Context, argv: readonly string[], policy: SandboxExecutionPolicy, signal: AbortSignal | undefined,
  limits: { timeoutMs: number; maxBytes: number; graceMs: number }): Promise<MediaOutput> {
  const controller = new AbortController()
  const timer = setTimeout(() => { controller.abort(new Error('Video inspection command timed out')) }, limits.timeoutMs)
  const operation = signal ? AbortSignal.any([controller.signal, signal]) : controller.signal
  let child: ReturnType<Context['subprocess']['spawn']> | undefined
  try {
    operation.throwIfAborted()
    let command = argv
    if (policy.mode !== 'danger-full-access') {
      const sandbox = ctx.get('sandbox')
      if (!sandbox) throw new SandboxUnavailableError(policy.mode)
      command = (await sandbox.confine(argv, { ...policy, mode: policy.mode }, operation)).argv
    }
    child = ctx.subprocess.spawn({ argv: command, cwd: policy.workspaceRoot, graceMs: limits.graceMs, signal: operation,
      stdio: { stdin: 'ignore', stdout: 'pipe', stderr: { maxBytes: 32_768 } },
    })
    // Attach rejection handling before reading stdout; a spawn failure can settle first.
    const done = child.done.then(outcome => ({ outcome }), (error: unknown) => ({ error }))
    const chunks: Uint8Array[] = []
    let length = 0
    if (!child.stdout) throw new Error('Video subprocess did not provide an output stream')
    for await (const chunk of child.stdout) {
      if (!Buffer.isBuffer(chunk)) throw new Error('Video subprocess returned non-binary bytes')
      length += chunk.byteLength
      if (length > limits.maxBytes) throw new Error('Video inspection output exceeds its byte limit')
      chunks.push(chunk)
    }
    const result = await done
    operation.throwIfAborted()
    if ('error' in result) throw result.error
    const diagnostic = child.collected.stderr?.readFrom(0).text ?? ''
    if (result.outcome.exitCode !== 0) throw new Error(`Video media command failed (exit ${String(result.outcome.exitCode)}): ${diagnostic.slice(-2000)}`)
    return { bytes: Buffer.concat(chunks, length), diagnostic }
  } finally {
    clearTimeout(timer)
    if (child) {
      child.terminate()
      await child.waitForExit()
    }
  }
}

/** Probed source facts; no observations of actions or speech are inferred. */
export interface VideoMetadata {
  duration_seconds: number
  width: number
  height: number
  video_codec: string
  has_audio: boolean
}

/**
 * Validate an FFprobe JSON report before accepting source metadata.
 * @param bytes - Complete bounded FFprobe stdout.
 * @returns Duration, encoded dimensions, codec and audio-track presence.
 */
export function parseVideoMetadata(bytes: Uint8Array): VideoMetadata {
  const raw: unknown = JSON.parse(Buffer.from(bytes).toString('utf8'))
  if (!raw || typeof raw !== 'object' || !('streams' in raw) || !Array.isArray(raw.streams) || !('format' in raw)
    || !raw.format || typeof raw.format !== 'object' || !('duration' in raw.format)) throw new Error('Media probe did not return video metadata')
  const duration = Number(raw.format.duration)
  const streams: readonly unknown[] = raw.streams
  const stream = streams.find(row => row && typeof row === 'object' && 'codec_type' in row && row.codec_type === 'video')
  if (!stream || typeof stream !== 'object' || !('width' in stream) || !('height' in stream) || !('codec_name' in stream)) throw new Error('Input has no decodable video track')
  const width = Number(stream.width), height = Number(stream.height)
  if (!Number.isFinite(duration) || duration <= 0 || !Number.isSafeInteger(width) || width <= 0
    || !Number.isSafeInteger(height) || height <= 0
    || typeof stream.codec_name !== 'string') throw new Error('Video metadata is invalid')
  return { duration_seconds: duration, width, height, video_codec: stream.codec_name,
    has_audio: streams.some(row => Boolean(row && typeof row === 'object' && 'codec_type' in row && row.codec_type === 'audio')) }
}
