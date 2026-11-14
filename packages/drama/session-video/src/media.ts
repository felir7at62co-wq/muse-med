/** Cancellation-owned FFmpeg commands and complete visual cut intervals. */
import type { Context } from '@deepseek-ai/cordis'
import { brandString } from '@deepseek-ai/dsh-brand'
import { SandboxUnavailableError, type SandboxExecutionPolicy } from '@deepseek-ai/dsh-sandbox'
import type {} from '@deepseek-ai/dsh-subprocess'
import type { SessionVideoShot, SessionVideoShotId, SessionVideoSourceId } from './types.ts'
import { digest, record } from './sources.ts'

/** Bounds for one media subprocess and its complete captured output. */
export interface MediaBounds { readonly commandTimeoutMs: number; readonly graceMs: number; readonly maxOutputBytes: number }

/**
 * Run a verified executable through the configured execution world and sandbox.
 * @param ctx - Subprocess runtime and optional sandbox implementation.
 * @param argv - Executable and literal arguments; no shell expansion is used.
 * @param policy - The source Session's execution policy.
 * @param signal - Operation lifetime and user cancellation.
 * @param bounds - Deadline, output and termination limits.
 * @returns Complete bounded stdout after successful process settlement.
 */
export async function command(ctx: Context, argv: readonly string[], policy: SandboxExecutionPolicy,
  signal: AbortSignal, bounds: MediaBounds): Promise<Uint8Array> {
  const deadline = AbortSignal.timeout(bounds.commandTimeoutMs)
  const operation = AbortSignal.any([signal, deadline])
  let confined = argv
  if (policy.mode !== 'danger-full-access') {
    const sandbox = ctx.get('sandbox')
    if (sandbox === undefined) throw new SandboxUnavailableError(policy.mode)
    confined = (await sandbox.confine(argv, { ...policy, mode: policy.mode }, operation)).argv
  }
  operation.throwIfAborted()
  const child = ctx.subprocess.spawn({ argv: confined, cwd: policy.workspaceRoot, graceMs: bounds.graceMs, signal: operation,
    stdio: { stdin: 'ignore', stdout: 'pipe', stderr: { maxBytes: bounds.maxOutputBytes } } })
  const settled = child.done.then(outcome => ({ outcome }), (error: unknown) => ({ error }))
  try {
    // oxlint-disable-next-line typescript/no-non-null-assertion -- The subprocess service guarantees raw stdout for pipe mode.
    const stdout = child.stdout!
    const chunks: Uint8Array[] = []
    let size = 0
    for await (const chunk of stdout) {
      if (!(chunk instanceof Uint8Array)) throw Error('Video process returned non-binary output')
      size += chunk.byteLength
      if (size > bounds.maxOutputBytes) throw Error('Video detection output exceeds its limit')
      chunks.push(chunk)
    }
    const result = await settled
    operation.throwIfAborted()
    if ('error' in result) throw result.error
    if (result.outcome.exitCode !== 0) {
      // oxlint-disable-next-line typescript/no-non-null-assertion -- stderr collect mode always provides its retained reader.
      const diagnostic = child.collected.stderr!.readFrom(0).text.slice(-1000)
      throw Error(`Video process failed (${String(result.outcome.exitCode)}): ${diagnostic}`)
    }
    return Buffer.concat(chunks, size)
  } finally {
    child.terminate()
    await child.waitForExit()
  }
}

/** Validated video-track dimensions and full container duration. */
export interface VideoFacts { readonly durationSeconds: number; readonly width: number; readonly height: number }

/**
 * Validate the bounded FFprobe report before accepting any cut ranges.
 * @param bytes - Complete FFprobe JSON bytes.
 * @returns Positive duration and dimensions of a real video track.
 */
export function facts(bytes: Uint8Array): VideoFacts {
  const value = record(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)))
  const stream = Array.isArray(value?.streams) ? value.streams.map(record).find(item => item?.codec_type === 'video') : undefined
  const durationSeconds = Number(record(value?.format)?.duration), width = Number(stream?.width), height = Number(stream?.height)
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0 || !Number.isSafeInteger(width) || width <= 0
    || !Number.isSafeInteger(height) || height <= 0) throw Error('Input has no valid video duration or dimensions')
  return { durationSeconds, width, height }
}

/**
 * Make chronological intervals that cover the full source without gaps or empty shots.
 * @param bytes - Complete FFmpeg scene metadata; empty output means one continuous shot.
 * @param duration - Probed full duration in seconds.
 * @param sourceId - Verified Session source identity.
 * @param version - Exact source version used for this detection.
 * @param minimum - Minimum separation between retained boundaries.
 * @param maximum - Maximum complete shot count; overflow is refused rather than truncated.
 * @returns Original-video ranges with stable version-bound ids.
 */
export function shotRanges(bytes: Uint8Array, duration: number, sourceId: SessionVideoSourceId,
  version: string, minimum: number, maximum: number): SessionVideoShot[] {
  const points = [0]
  let previous = 0
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  const detected = [...new Set([...text.matchAll(/\bpts_time:(\S+)/g)].map(match => Number(match[1])))].sort((a, b) => a - b)
  for (const point of detected) {
    if (!Number.isFinite(point) || point < 0 || point >= duration) throw Error('Cut detector returned an invalid source timestamp')
    if (point - previous >= minimum && duration - point >= minimum) { points.push(point); previous = point }
  }
  points.push(duration)
  if (points.length - 1 > maximum) throw Error('Video contains more cut intervals than the configured limit')
  let startSeconds = 0
  return points.slice(1).map((endSeconds, index) => {
    const start = startSeconds
    startSeconds = endSeconds
    return { id: brandString<SessionVideoShotId>(digest(`${sourceId}:${version}:${start}:${endSeconds}`)),
      index: index + 1, startSeconds: start, endSeconds, thumbnail: null }
  })
}
