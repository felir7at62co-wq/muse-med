/** FFmpeg process helpers and no-clobber publication for BGM artifacts. */

import { link, unlink } from 'node:fs/promises'
import type { SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import type { SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import type { MediaToolkit, ProbedAudio, ProcessChannel, ProcessOutcome } from './types.ts'

export type { ProcessChannel } from './types.ts'

const STDERR_TAIL_CHARS = 4000
const UNKNOWN_EXIT_CODE = 127

/** A failed FFmpeg or ffprobe command with its diagnostic tail. */
export class MediaCommandError extends Error {
  /** Executable that failed. */
  readonly command: string
  /** Arguments supplied to the executable. */
  readonly args: readonly string[]
  /** Process exit code. */
  readonly code: number
  /** Captured standard error. */
  readonly stderr: string

  /**
   * Record one command failure.
   * @param command - Executable that failed.
   * @param args - Arguments supplied to the executable.
   * @param outcome - Captured process outcome.
   */
  constructor(command: string, args: readonly string[], outcome: ProcessOutcome) {
    super(`${command} ${args.join(' ')} 退出码 ${String(outcome.code)}：${outcome.stderr.slice(-STDERR_TAIL_CHARS)}`)
    this.name = 'MediaCommandError'
    this.command = command
    this.args = [...args]
    this.code = outcome.code
    this.stderr = outcome.stderr
  }
}

/**
 * Adapt the Harness subprocess service to the composer's process channel.
 * @param subprocess - Provider-managed subprocess service.
 * @param cwd - Project directory used by every media command.
 * @param timeoutMs - Maximum duration of one command.
 * @param graceMs - Provider termination grace.
 * @param outputMaxBytes - In-memory cap for each collected stream.
 * @returns A channel that resolves executables in the provider's execution world.
 */
export function createSubprocessChannel(
  subprocess: SubprocessRuntime,
  cwd: string,
  timeoutMs: number,
  graceMs: number,
  outputMaxBytes: number,
): ProcessChannel {
  return {
    run: async (command, args, signal) => {
      const timeout = AbortSignal.timeout(timeoutMs)
      const combined = signal === undefined ? timeout : AbortSignal.any([signal, timeout])
      const executable = await subprocess.resolveExecutable(command, undefined, combined)
      const handle = subprocess.spawn({
        argv: [executable, ...args],
        cwd,
        stdio: {
          stdin: 'ignore',
          stdout: { maxBytes: outputMaxBytes },
          stderr: { maxBytes: outputMaxBytes },
        },
        graceMs,
        signal: combined,
      } satisfies SubprocessSpawnSpec)
      const outcome = await handle.done
      combined.throwIfAborted()
      const stdout = handle.collected.stdout?.readFrom(0)
      const stderr = handle.collected.stderr?.readFrom(0)
      if (stdout === undefined || stderr === undefined) throw new Error('媒体命令没有返回可收集的输出流。')
      if (stdout.lossy || stderr.lossy) throw new Error('媒体命令输出超过收集上限。')
      return {
        code: outcome.exitCode ?? UNKNOWN_EXIT_CODE,
        stdout: stdout.text,
        stderr: `${stderr.text}${outcome.signal === null ? '' : `\nterminated by ${outcome.signal}`}`,
      }
    },
  }
}

/**
 * Build the source-analysis operations used by preview and compose.
 * @param ffmpegPath - FFmpeg executable.
 * @param _ffprobePath - Reserved ffprobe executable for the complete toolkit.
 * @param channel - Process channel.
 * @returns Media analysis operations.
 */
export function createMediaToolkit(
  ffmpegPath: string,
  _ffprobePath: string,
  channel: ProcessChannel,
): MediaToolkit {
  const checked = async (args: readonly string[], signal?: AbortSignal): Promise<ProcessOutcome> => {
    const outcome = await channel.run(ffmpegPath, args, signal)
    if (outcome.code !== 0) throw new MediaCommandError(ffmpegPath, args, outcome)
    return outcome
  }
  return {
    detectSourceStart: async (source, signal) => {
      const args = [
        '-hide_banner', '-nostats', '-ss', '1', '-t', '4', '-i', source,
        '-af', 'silencedetect=noise=-45dB:d=0.08', '-f', 'null', '-',
      ]
      const outcome = await checked(args, signal)
      const silence = /silence_start:\s*(-?[0-9]+(?:\.[0-9]+)?)(?:.|\n)*?silence_end:\s*([0-9]+(?:\.[0-9]+)?)/u
        .exec(outcome.stderr)
      const startsSilent = /silence_start:\s*(-?[0-9]+(?:\.[0-9]+)?)/u.exec(outcome.stderr)
      if (startsSilent === null || Math.abs(Number(startsSilent[1])) > 0.001) {
        return { seconds: 1, kind: 'onset' }
      }
      if (silence === null) throw new Error(`BGM 在 1–5 秒内没有可用起音：${source}`)
      const seconds = 1 + Number(silence[2])
      if (!Number.isFinite(seconds) || seconds >= 5) throw new Error(`BGM 在 1–5 秒内没有可用起音：${source}`)
      return { seconds: Number(seconds.toFixed(6)), kind: 'onset' }
    },
    meanVolume: async (source, startSeconds, durationSeconds, signal) => {
      const args = [
        '-hide_banner', '-nostats', '-ss', startSeconds.toFixed(6), '-t', durationSeconds.toFixed(6),
        '-i', source, '-af', 'volumedetect', '-f', 'null', '-',
      ]
      const outcome = await checked(args, signal)
      const match = /mean_volume:\s*(-?(?:[0-9]+(?:\.[0-9]+)?|inf))\s*dB/iu.exec(outcome.stderr)
      if (match === null || match[1]?.toLowerCase() === '-inf') throw new Error(`无法测量 BGM 源曲响度：${source}`)
      return Number(match[1])
    },
  }
}

/**
 * Probe one audio file through ffprobe.
 * @param ffprobePath - ffprobe executable.
 * @param channel - Process channel.
 * @param path - Audio file path.
 * @param signal - Optional cancellation signal.
 * @returns Parsed audio facts.
 */
export async function probeAudio(
  ffprobePath: string,
  channel: ProcessChannel,
  path: string,
  signal?: AbortSignal,
): Promise<ProbedAudio> {
  const args = ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', path]
  const outcome = await channel.run(ffprobePath, args, signal)
  if (outcome.code !== 0) throw new MediaCommandError(ffprobePath, args, outcome)
  let document: unknown
  try {
    document = JSON.parse(outcome.stdout)
  } catch (error) {
    throw new Error(`ffprobe 返回了无效 JSON：${path}`, { cause: error })
  }
  if (typeof document !== 'object' || document === null) throw new Error(`ffprobe 缺少媒体信息：${path}`)
  const root = document as { streams?: unknown; format?: unknown }
  if (!Array.isArray(root.streams) || typeof root.format !== 'object' || root.format === null) {
    throw new Error(`ffprobe 缺少媒体信息：${path}`)
  }
  const stream = root.streams.find(item => typeof item === 'object' && item !== null
    && (item as { codec_type?: unknown }).codec_type === 'audio') as Record<string, unknown> | undefined
  if (stream === undefined) throw new Error(`媒体没有音频流：${path}`)
  const format = root.format as Record<string, unknown>
  const formatName = typeof format.format_name === 'string' ? format.format_name : ''
  const codec = typeof stream.codec_name === 'string' ? stream.codec_name : ''
  const sampleRate = Number(stream.sample_rate)
  const channels = Number(stream.channels)
  const durationSeconds = Number(format.duration)
  const sizeBytes = Number(format.size)
  if (!formatName || !codec || !Number.isFinite(sampleRate) || !Number.isFinite(channels)
    || !Number.isFinite(durationSeconds) || !Number.isFinite(sizeBytes)) {
    throw new Error(`ffprobe 音频信息不完整：${path}`)
  }
  return { formatName, codec, sampleRate, channels, durationSeconds, sizeBytes }
}

/**
 * Run the final FFmpeg mix command.
 * @param ffmpegPath - FFmpeg executable.
 * @param channel - Process channel.
 * @param sources - Ordered source audio paths.
 * @param filter - Complete filter-complex graph.
 * @param output - Staged WAV path.
 * @param signal - Optional cancellation signal.
 */
export async function renderBgm(
  ffmpegPath: string,
  channel: ProcessChannel,
  sources: readonly string[],
  filter: string,
  output: string,
  signal?: AbortSignal,
): Promise<void> {
  const args = [
    '-y', '-v', 'error', ...sources.flatMap(source => ['-i', source]),
    '-filter_complex', filter, '-map', '[bgmout]', '-c:a', 'pcm_s16le', '-ar', '48000', '-ac', '2', output,
  ]
  const outcome = await channel.run(ffmpegPath, args, signal)
  if (outcome.code !== 0) throw new MediaCommandError(ffmpegPath, args, outcome)
}

/**
 * Publish staged files without overwriting an existing destination.
 *
 * Every staged file must share a volume with its destination. A conflict or
 * link failure removes only destinations created by this call and retains every
 * staged file so the caller can clean it in one place.
 * @param pairs - Staged and final path pairs.
 */
export async function publishNoClobber(pairs: readonly (readonly [string, string])[]): Promise<void> {
  const created: string[] = []
  try {
    for (const [temporary, final] of pairs) {
      await link(temporary, final)
      created.push(final)
    }
  } catch (error) {
    await Promise.all(created.reverse().map(async (path) => {
      try {
        await unlink(path)
      } catch (unlinkError) {
        if ((unlinkError as NodeJS.ErrnoException).code !== 'ENOENT') throw unlinkError
      }
    }))
    throw error
  }
  await Promise.all(pairs.map(async ([temporary]) => { await unlink(temporary) }))
}
