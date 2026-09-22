/**
 * Fixtures shared by this package's specs: the stub process channel, the fake
 * ffprobe reports, the framemd5 and detection responses, and the temporary
 * project tree the pipeline writes into.
 */

import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import type { MediaCommandOutcome, ProcessChannel } from '../src/types.ts'

/**
 * The registry context a registered tool's executor receives.
 *
 * `drama_render` reads only its arguments and its injected settings, so the
 * registry-owned identity fields are placeholders. The cast stays here so no
 * spec spells out eight fields it never reads.
 * @returns A context the registered executor accepts.
 */
export function runContext(): ToolRunContext {
  return {
    callId: 'drama-render-spec',
    rootCallId: 'drama-render-spec',
    name: 'drama_render',
    arguments: {},
    signal: new AbortController().signal,
    token: 'drama-render-spec',
    deferContext: () => {},
    concludeTurn: () => {},
  } as unknown as ToolRunContext
}

/** One process call the stub channel received. */
export interface ChannelCall {
  /** The executable that was requested. */
  readonly command: string
  /** The arguments that were requested. */
  readonly args: readonly string[]
}

/** What one stub handler answers for a call it claims. */
export interface StubResponse {
  /** Exit code; 0 when omitted. */
  readonly code?: number
  /** Standard output; empty when omitted. */
  readonly stdout?: string
  /** Standard error; empty when omitted. */
  readonly stderr?: string
  /** Side effect to run before the outcome is returned, such as writing the file ffmpeg would have produced. */
  readonly after?: () => Promise<void> | void
}

/** One stub handler; returning `undefined` passes the call to the next handler. */
export type StubHandler = (call: ChannelCall) => StubResponse | undefined

/** A stub channel plus every call it recorded. */
export interface StubChannel {
  /** The channel a `MediaToolkit` is built from. */
  readonly channel: ProcessChannel
  /** Every call, in request order. */
  readonly calls: ChannelCall[]
}

/**
 * Build a channel that answers from handlers instead of starting processes.
 *
 * An unmatched call throws, so a spec that forgets a handler fails loudly rather
 * than silently returning an empty success.
 * @param handlers - The handlers, tried in order.
 * @returns The channel and its recorded calls.
 */
export function stubChannel(handlers: readonly StubHandler[]): StubChannel {
  const calls: ChannelCall[] = []
  const channel: ProcessChannel = {
    run: async (command, args): Promise<MediaCommandOutcome> => {
      const call: ChannelCall = { command, args: [...args] }
      calls.push(call)
      for (const handler of handlers) {
        const response = handler(call)
        if (response === undefined) continue
        await response.after?.()
        return { code: response.code ?? 0, stdout: response.stdout ?? '', stderr: response.stderr ?? '' }
      }
      throw new Error(`unexpected command: ${command} ${args.join(' ')}`)
    },
  }
  return { channel, calls }
}

/** One speaking stretch a stub clip's samples carry. */
export interface SpeechSpan {
  /** Stretch start, seconds from the clip start; a multiple of the analysis frame. */
  readonly start: number
  /** Stretch end, seconds from the clip start; a multiple of the analysis frame. */
  readonly end: number
}

/** One stub clip's synthesized audio. */
export interface ClipAudio {
  /** Clip length in seconds. */
  readonly seconds: number
  /** Stretches in which the clip speaks; the rest carries a quiet floor. */
  readonly spans?: readonly SpeechSpan[]
  /** Amplitude of the clip's own floor; defaults to a nearly silent one. */
  readonly floorAmplitude?: number
}

/** Amplitude of a speaking frame; loud enough to clear any derived level. */
const SPEAKING_AMPLITUDE = 8000

/** Amplitude of a silent frame; the clip's own floor the analysis must derive. */
const SILENT_AMPLITUDE = 30

/**
 * Build the handler that answers the speech analysis's PCM decode.
 *
 * The command writes raw mono samples to the file named last, which is what the
 * analysis then measures, so a stub clip speaks exactly where its table says.
 * @param clips - Clip audio keyed by input path.
 * @returns The handler; an unregistered path answers like a missing file.
 */
export function pcmHandler(clips: Readonly<Record<string, ClipAudio>>): StubHandler {
  const table = new Map(Object.entries(clips).map(([path, value]) => [slash(path), value]))
  return (call) => {
    const formatAt = call.args.indexOf('-f')
    if (call.command !== 'ffmpeg' || call.args[formatAt + 1] !== 's16le') return undefined
    const input = call.args[call.args.indexOf('-i') + 1] ?? ''
    const clip = table.get(slash(input))
    if (clip === undefined) return { code: 1, stderr: `No such file or directory: ${input}` }
    const rate = Number(call.args[call.args.indexOf('-ar') + 1] ?? 16_000)
    const frame = Math.max(1, Math.round(rate * 0.02))
    const frames = Math.max(1, Math.round(clip.seconds / 0.02))
    const samples = Buffer.alloc(frames * frame * 2)
    const floor = clip.floorAmplitude ?? SILENT_AMPLITUDE
    for (let index = 0; index < frames; index += 1) {
      const at = index * 0.02
      const speaking = (clip.spans ?? []).some(span => at >= span.start && at < span.end)
      const value = speaking ? SPEAKING_AMPLITUDE : floor
      for (let offset = 0; offset < frame; offset += 1) samples.writeInt16LE(value, (index * frame + offset) * 2)
    }
    const target = outputPath(call)
    return { after: async () => { await mkdir(dirname(target), { recursive: true }); await writeFile(target, samples) } }
  }
}

/** The last argument of a call, which is the output path of every command this package builds. */
export function outputPath(call: ChannelCall): string {
  return call.args[call.args.length - 1] ?? ''
}

/** Whether one call is the ffprobe invocation for a path. */
export function isProbe(call: ChannelCall): boolean {
  return call.command === 'ffprobe'
}

/** Whether one call reads a `-f framemd5` report. */
export function isFramemd5(call: ChannelCall): boolean {
  return call.command === 'ffmpeg' && call.args.includes('framemd5')
}

/** Whether one call performs the `-sseof` tail-frame seek. */
export function isSeek(call: ChannelCall): boolean {
  return call.command === 'ffmpeg' && call.args.includes('-sseof')
}

/** One fake media file's probed facts. */
export interface ProbeSpec {
  /** Container duration in seconds; defaults to 1. */
  readonly durationSeconds?: number
  /** File size in bytes; defaults to 1000. */
  readonly sizeBytes?: number
  /** Overall bitrate in bits per second; defaults to 8_000_000. */
  readonly bitRateBps?: number
  /** The video stream, or `undefined` for a file with no picture. */
  readonly video?: { width?: number; height?: number; codec?: string; fps?: number } | undefined
  /** The audio stream, or `false` for a file with no sound. */
  readonly audio?: { codec?: string; sampleRate?: number } | false
}

/**
 * Render one ffprobe report.
 * @param spec - The fake file's facts.
 * @returns The JSON text ffprobe would have written.
 */
export function probeJson(spec: ProbeSpec): string {
  const streams: Record<string, unknown>[] = []
  if (spec.video !== undefined) {
    streams.push({
      codec_type: 'video',
      codec_name: spec.video.codec ?? 'h264',
      width: spec.video.width ?? 1440,
      height: spec.video.height ?? 2560,
      avg_frame_rate: `${String(spec.video.fps ?? 60)}/1`,
      r_frame_rate: `${String(spec.video.fps ?? 60)}/1`,
    })
  }
  if (spec.audio !== false) {
    streams.push({
      codec_type: 'audio',
      codec_name: spec.audio?.codec ?? 'aac',
      sample_rate: String(spec.audio?.sampleRate ?? 48000),
      channels: 2,
    })
  }
  return JSON.stringify({
    streams,
    format: {
      duration: String(spec.durationSeconds ?? 1),
      size: String(spec.sizeBytes ?? 1000),
      bit_rate: String(spec.bitRateBps ?? 8_000_000),
    },
  })
}

/**
 * Build the handler that answers ffprobe from a path table.
 *
 * An unregistered path answers like ffprobe does for a missing file, so a spec
 * can assert the pipeline's own Chinese diagnostic.
 * @param files - Probed facts keyed by absolute path.
 * @returns The handler.
 */
export function probeHandler(files: Readonly<Record<string, ProbeSpec>>): StubHandler {
  const normalized = new Map<string, ProbeSpec>()
  for (const [path, spec] of Object.entries(files)) normalized.set(slash(path), spec)
  return (call) => {
    if (!isProbe(call)) return undefined
    const spec = normalized.get(slash(outputPath(call)))
    if (spec === undefined) return { code: 1, stderr: 'No such file or directory' }
    return { stdout: probeJson(spec) }
  }
}

/** One path in the forward-slash form every stub table is keyed by. */
export function slash(path: string): string {
  return path.split('\\').join('/')
}

/** The framemd5 answers a stub channel resolves, keyed by input path. */
export interface FrameHashes {
  /** Hashes for a single-image input, in decode order. */
  readonly images: Readonly<Record<string, readonly string[]>>
  /** Hashes for a video input, in decode order. */
  readonly videos: Readonly<Record<string, readonly string[]>>
}

/**
 * Build the handler that answers `-f framemd5`.
 * @param hashes - The image and video hash tables.
 * @returns The handler.
 */
export function framemd5Handler(hashes: FrameHashes): StubHandler {
  return (call) => {
    if (!isFramemd5(call)) return undefined
    const input = call.args[call.args.indexOf('-i') + 1] ?? ''
    const table = input.endsWith('.png') ? hashes.images[input] : hashes.videos[input]
    if (table === undefined) return { code: 1, stderr: `framemd5: ${input}: no such input` }
    return { stdout: `${table.map((hash, index) => framemd5Line(index, hash)).join('\n')}\n` }
  }
}

/** One `framemd5` frame line, in ffmpeg's own comma-separated layout. */
export function framemd5Line(index: number, hash: string): string {
  return `${String(index)},          0,          0,        1,     6220800, ${hash}`
}

/**
 * Build the handler that plays the `-sseof` seek.
 * @param write - What the seek writes, or `undefined` to reproduce the silent failure that writes nothing.
 * @returns The handler.
 */
export function seekHandler(write: string | undefined): StubHandler {
  return (call) => {
    if (!isSeek(call)) return undefined
    const target = outputPath(call)
    if (write === undefined) return {}
    return { after: async () => { await writePlaceholder(target, write) } }
  }
}

/**
 * Build the catch-all handler for every remaining ffmpeg command.
 *
 * It writes a placeholder at the command's output path, which is what the
 * pipeline then stats, probes, and concatenates.
 * @param bytes - The placeholder's contents.
 * @returns The handler.
 */
export function placeholderHandler(bytes = 'media'): StubHandler {
  return (call) => {
    if (call.command !== 'ffmpeg') return undefined
    const target = outputPath(call)
    if (target === '-' || target === '') return {}
    return { after: async () => { await writePlaceholder(target, bytes) } }
  }
}

/** Create a file and every directory above it. */
export async function writePlaceholder(path: string, contents: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, contents, 'utf8')
}

/** Create a temporary project root the caller removes. */
export async function tempProject(): Promise<string> {
  return await mkdtemp(join(tmpdir(), 'drama-render-'))
}

/** Remove a temporary directory tree, ignoring an already-removed tree. */
export async function cleanup(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true })
}

/** Report one path's size in bytes, or -1 when it does not exist. */
export async function sizeOf(path: string): Promise<number> {
  try {
    return (await stat(path)).size
  } catch {
    return -1
  }
}

/** One episode timeline in the JSON the pipeline writes. */
export function timelineJson(clips: readonly { shot: number; startUs: number; durationUs: number }[],
  bodyEndSeconds: number): string {
  return JSON.stringify({
    clips: clips.map(clip => ({ shot: clip.shot, start_us: clip.startUs, duration_us: clip.durationUs })),
    body_end: bodyEndSeconds,
  }, null, 2)
}

/** One SRT document with the given cues. */
export function srtDocument(cues: readonly { start: string; end: string; text: string }[]): string {
  return cues.map((cue, index) => `${String(index + 1)}\n${cue.start} --> ${cue.end}\n${cue.text}\n`).join('\n')
}
