/**
 * The external-process edge of the renderer: one channel that starts a process,
 * the ffmpeg and ffprobe wrappers built on it, and the error a failed command
 * raises.
 *
 * Every other module takes a {@link MediaToolkit} and never starts a process
 * itself, so a test substitutes one channel and exercises the whole pipeline
 * without running ffmpeg.
 *
 * @module @deepseek-ai/dsh-tool-episode-render/ffmpeg
 */

import { spawn } from 'node:child_process'
import { mkdtemp, open, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { MediaCommandOutcome, MediaToolkit, ProcessChannel, ProbedMedia, ProbedStream } from './types.ts'

/** Bytes of a failed command's stderr kept for the diagnostic message. */
const STDERR_TAIL_CHARS = 4000

/** Exit code reported for a process that ended without one, so a failure never reads as success. */
const UNKNOWN_EXIT_CODE = 127

/** One external command that exited non-zero. */
export class MediaCommandError extends Error {
  /** The executable that was started. */
  readonly command: string

  /** The arguments the executable received. */
  readonly args: readonly string[]

  /** The exit code the command reported. */
  readonly code: number

  /** The last {@link STDERR_TAIL_CHARS} characters the command wrote to standard error. */
  readonly stderr: string

  /**
   * Record one failed command.
   * @param command - The executable that was started.
   * @param args - The arguments the executable received.
   * @param code - The exit code the command reported.
   * @param stderr - Everything the command wrote to standard error.
   */
  constructor(command: string, args: readonly string[], code: number, stderr: string) {
    super(`${describeCommand(command, args)} 退出码 ${String(code)}：${stderr.slice(-STDERR_TAIL_CHARS)}`)
    this.name = 'MediaCommandError'
    this.command = command
    this.args = args
    this.code = code
    this.stderr = stderr
  }
}

/**
 * Render one command line for a message or a log.
 * @param command - The executable to start.
 * @param args - The arguments the executable receives.
 * @returns The command and its arguments separated by single spaces.
 */
export function describeCommand(command: string, args: readonly string[]): string {
  return [command, ...args].join(' ')
}

/**
 * Read one process exit code.
 *
 * A process that ended without one — killed by a signal rather than exiting —
 * reports {@link UNKNOWN_EXIT_CODE}, because a null code must never be read as a
 * successful run.
 * @param code - The code Node reported, or null when the process did not exit on its own.
 * @returns The exit code, or 127 when there is none.
 */
export function exitCodeOf(code: number | null): number {
  return code ?? UNKNOWN_EXIT_CODE
}

/**
 * Build the channel that starts real child processes.
 *
 * Standard output and standard error are captured rather than inherited, because
 * every caller either parses them (ffprobe, framemd5, blackdetect) or quotes them
 * in a diagnostic. A process that cannot be started at all settles as exit code
 * 127 with the spawn error on standard error, so a missing ffmpeg reaches the
 * caller as one readable failure instead of an unhandled exception.
 * @returns A channel that spawns processes for real.
 */
export function createSpawnChannel(): ProcessChannel {
  return {
    run: async (command, args) => await new Promise<MediaCommandOutcome>((resolve) => {
      const child = spawn(command, [...args], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
      let stdout = ''
      let stderr = ''
      let settled = false
      const settle = (outcome: MediaCommandOutcome): void => {
        if (settled) return
        settled = true
        resolve(outcome)
      }
      child.stdout.setEncoding('utf8')
      child.stderr.setEncoding('utf8')
      child.stdout.on('data', (chunk: string) => { stdout += chunk })
      child.stderr.on('data', (chunk: string) => { stderr += chunk })
      child.on('error', (error: Error) => { settle({ code: UNKNOWN_EXIT_CODE, stdout, stderr: `${stderr}${error.message}` }) })
      child.on('close', (code: number | null) => { settle({ code: exitCodeOf(code), stdout, stderr }) })
    }),
  }
}

/**
 * Build a process channel that captures output through ordinary files.
 *
 * The DSH Windows sandbox rejects Node child-process pipes with EPERM. File
 * descriptors preserve the same capture contract without named pipes.
 */
export function createFileCaptureChannel(): ProcessChannel {
  return {
    run: async (command, args) => {
      const directory = await mkdtemp(join(tmpdir(), 'dsh-drama-render-'))
      const stdoutPath = join(directory, 'stdout.txt')
      const stderrPath = join(directory, 'stderr.txt')
      let stdoutFile: Awaited<ReturnType<typeof open>> | undefined
      let stderrFile: Awaited<ReturnType<typeof open>> | undefined
      try {
        stdoutFile = await open(stdoutPath, 'w')
        stderrFile = await open(stderrPath, 'w')
        const outcome = await new Promise<{ code: number; spawnError: string }>((resolve) => {
          const child = spawn(command, [...args], {
            stdio: ['ignore', stdoutFile?.fd, stderrFile?.fd], windowsHide: true,
          })
          let settled = false
          const settle = (code: number, spawnError = ''): void => {
            if (settled) return
            settled = true
            resolve({ code, spawnError })
          }
          child.on('error', (error: Error) => { settle(UNKNOWN_EXIT_CODE, error.message) })
          child.on('close', (code: number | null) => { settle(exitCodeOf(code)) })
        })
        await stdoutFile.close()
        await stderrFile.close()
        const stdout = await readFile(stdoutPath, 'utf8')
        const stderr = `${await readFile(stderrPath, 'utf8')}${outcome.spawnError}`
        return { code: outcome.code, stdout, stderr }
      } finally {
        await stdoutFile?.close().catch(() => undefined)
        await stderrFile?.close().catch(() => undefined)
        await rm(directory, { recursive: true, force: true })
      }
    },
  }
}

/**
 * Assemble the toolkit one call uses.
 * @param settings - The resolved binaries and an optional channel override.
 * @param settings.ffmpeg - The ffmpeg executable to start.
 * @param settings.ffprobe - The ffprobe executable to start.
 * @param settings.channel - The process channel; the file-capture channel when omitted.
 * @returns A toolkit every pipeline step can share.
 */
export function createMediaToolkit(
  settings: { ffmpeg: string; ffprobe: string; channel?: ProcessChannel | undefined },
): MediaToolkit {
  return {
    ffmpeg: settings.ffmpeg,
    ffprobe: settings.ffprobe,
    channel: settings.channel ?? createFileCaptureChannel(),
  }
}

/**
 * Start ffmpeg and return its outcome without judging the exit code.
 * @param toolkit - The binaries and channel to use.
 * @param args - Arguments handed to ffmpeg unchanged.
 * @returns The exit code and both captured streams.
 */
export async function captureFfmpeg(toolkit: MediaToolkit, args: readonly string[]): Promise<MediaCommandOutcome> {
  return await toolkit.channel.run(toolkit.ffmpeg, args)
}

/**
 * Run one ffmpeg command and fail loud when it exits non-zero.
 *
 * An encode that fails must never look like a finished render, so this is the
 * only form the pipeline uses for work whose output it then trusts. The full
 * argument list is part of the message: a failed filter graph is read from the
 * command, not guessed from the exit code.
 * @param toolkit - The binaries and channel to use.
 * @param args - Arguments handed to ffmpeg unchanged.
 * @throws {MediaCommandError} When ffmpeg exits non-zero.
 */
export async function runFfmpeg(toolkit: MediaToolkit, args: readonly string[]): Promise<void> {
  const outcome = await captureFfmpeg(toolkit, args)
  if (outcome.code !== 0) throw new MediaCommandError(toolkit.ffmpeg, args, outcome.code, outcome.stderr)
}

/** One ffprobe stream record, as the container reports it. */
interface RawProbeStream {
  codec_type?: unknown
  codec_name?: unknown
  width?: unknown
  height?: unknown
  avg_frame_rate?: unknown
  r_frame_rate?: unknown
  sample_rate?: unknown
  channels?: unknown
}

/** One ffprobe report, as the container reports it. */
interface RawProbeDocument {
  streams?: unknown
  format?: { duration?: unknown; size?: unknown; bit_rate?: unknown }
}

/** Read a numeric probe field, tolerating the strings ffprobe emits. */
function probeNumber(value: unknown): number | undefined {
  if (typeof value === 'number') return value
  if (typeof value !== 'string') return undefined
  const parsed = Number.parseFloat(value)
  return Number.isFinite(parsed) ? parsed : undefined
}

/** Read a textual probe field. */
function probeText(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

/**
 * Report whether one parsed report carries the streams array this package reads.
 *
 * `JSON.parse` returns `unknown` here: a report from another tool, a truncated
 * file, or an error page must fail the caller's own diagnostic rather than
 * reaching the stream loop as a missing field.
 * @param value - The parsed report.
 * @returns Whether the value is an object carrying a streams array.
 */
function hasStreamsArray(value: unknown): value is RawProbeDocument {
  return typeof value === 'object' && value !== null && Array.isArray((value as { streams?: unknown }).streams)
}

/**
 * Probe one media file through ffprobe.
 * @param toolkit - The binaries and channel to use.
 * @param file - Absolute path of the file to probe.
 * @returns The streams plus the container facts this package reads.
 * @throws {MediaCommandError} When ffprobe exits non-zero.
 * @throws {Error} When ffprobe's report is not the JSON object this package expects.
 */
export async function probeMedia(toolkit: MediaToolkit, file: string): Promise<ProbedMedia> {
  const args = ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', file]
  const outcome = await toolkit.channel.run(toolkit.ffprobe, args)
  if (outcome.code !== 0) throw new MediaCommandError(toolkit.ffprobe, args, outcome.code, outcome.stderr)
  let document: RawProbeDocument
  try {
    document = JSON.parse(outcome.stdout) as RawProbeDocument
  } catch (error) {
    throw new Error(`ffprobe 对 ${file} 没有返回 JSON，无法读取媒体参数。`
      + '请确认该文件是完整可解码的 MP4，必要时用 ffmpeg -err_detect explode 复跑一次定位损坏帧。', { cause: error })
  }
  if (!hasStreamsArray(document)) {
    throw new Error(`ffprobe 对 ${file} 的报告里没有 streams 数组，无法读取媒体参数。`
      + '请确认文件没有被截断；重新导出该文件后再试。')
  }
  const streams = (document.streams as readonly RawProbeStream[]).map((stream): ProbedStream => {
    const width = probeNumber(stream.width)
    const height = probeNumber(stream.height)
    const avgFrameRate = probeText(stream.avg_frame_rate)
    const rFrameRate = probeText(stream.r_frame_rate)
    const sampleRate = probeNumber(stream.sample_rate)
    const channels = probeNumber(stream.channels)
    return {
      codecType: probeText(stream.codec_type),
      codecName: probeText(stream.codec_name),
      ...(width === undefined ? {} : { width }),
      ...(height === undefined ? {} : { height }),
      ...(avgFrameRate === '' ? {} : { avgFrameRate }),
      ...(rFrameRate === '' ? {} : { rFrameRate }),
      ...(sampleRate === undefined ? {} : { sampleRate }),
      ...(channels === undefined ? {} : { channels }),
    }
  })
  return {
    streams,
    durationSeconds: probeNumber(document.format?.duration) ?? 0,
    sizeBytes: probeNumber(document.format?.size) ?? 0,
    bitRateBps: probeNumber(document.format?.bit_rate) ?? 0,
  }
}

/**
 * Read the first stream of one type.
 * @param media - The probed media.
 * @param codecType - `video` or `audio`.
 * @returns The first matching stream, or `undefined` when the file has none.
 */
export function firstStreamOfType(media: ProbedMedia, codecType: string): ProbedStream | undefined {
  return media.streams.find(stream => stream.codecType === codecType)
}

/**
 * Read a frame rate expressed as ffprobe's `numerator/denominator`.
 * @param stream - The video stream to read.
 * @returns Frames per second, or 0 when neither field parses.
 */
export function frameRateOf(stream: ProbedStream | undefined): number {
  if (stream === undefined) return 0
  const raw = stream.avgFrameRate ?? stream.rFrameRate ?? ''
  const parts = raw.split('/')
  const top = Number(parts[0])
  const bottom = Number(parts[1])
  if (!Number.isFinite(top) || !Number.isFinite(bottom) || bottom === 0) return 0
  return top / bottom
}

/**
 * Convert one path for use inside an ffmpeg filter argument.
 *
 * ffmpeg's filter parser treats `:` as an option separator and `\` as an escape,
 * so a Windows path reaches libass as `C\:/Windows/Fonts`.
 * @param path - The filesystem path to convert.
 * @returns The path with forward slashes and an escaped drive colon.
 */
export function escapeFilterPath(path: string): string {
  return path.split('\\').join('/').replace(/:/g, '\\:')
}
