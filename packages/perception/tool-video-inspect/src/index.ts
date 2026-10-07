/** Model-visible video metadata and bounded, timestamped image observations. */
import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import { AttachmentId, IMAGE_RESULT_SCHEMA, type ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { FsVersion } from '@deepseek-ai/dsh-fs'
import type {} from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-attachment'
import type {} from '@deepseek-ai/dsh-sandbox-policy'
import { defineTool, type ToolExecution } from '@deepseek-ai/dsh-tools'
import { planSamples } from './sample.ts'
import { adaptivePlan, sceneTimecodes, type AdaptivePlan } from './adaptive.ts'
import { parseVideoMetadata, runMedia, type VideoMetadata } from './media.ts'

/** Plugin name for video observations. */
export const name = 'tool-video-inspect'

/** Media reads, process ownership and durable image admission are registered services. */
export const inject = ['tools', 'fs', 'subprocess', 'attachments', 'sandboxPolicy']

/** Deployment-resolved media executables and inspection bounds. */
export interface Config {
  /** Same-world FFmpeg executable. */
  ffmpegPath: string
  /** Same-world FFprobe executable. */
  ffprobePath: string
  /** Largest source file accepted, in bytes. */
  maxSourceBytes: number
  /** Largest encoded source image area accepted before decoding, in pixels. */
  maxSourcePixels: number
  /** Largest probed source duration, in seconds. */
  maxDurationSeconds: number
  /** Largest interval sampled by one call, in seconds. */
  maxRangeSeconds: number
  /** Largest number of returned image observations per call. */
  maxFrames: number
  /** Number of uniform observations used when the caller omits frame_count. */
  defaultFrames: number
  /** Largest dimension of an extracted frame, in pixels. */
  frameMaxDimension: number
  /** Largest complete PNG output from one extraction command, in bytes. */
  maxFrameBytes: number
  /** Largest simultaneous inspection count. */
  maxConcurrent: number
  /** Deadline of one probe or extraction command, in milliseconds. */
  commandTimeoutMs: number
  /** Process termination grace, in milliseconds. */
  graceMs: number
  /** Scene difference threshold supplied to the FFmpeg scene filter. */
  sceneThreshold: number
  /** Source time offset for observations before and after a detected cut. */
  scenePaddingSeconds: number
  /** Maximum event observations in one adaptive selection plan. */
  maxPlanPoints: number
  /** Maximum bytes read from an ASR transcript used for adaptive sampling. */
  maxTranscriptBytes: number
}

/** Validated deployment knobs; argument defaults are resolved before media work. */
export const Config: Schema<Partial<Config>, Config> = Schema.object({
  ffmpegPath: Schema.string().default('ffmpeg'), ffprobePath: Schema.string().default('ffprobe'),
  maxSourceBytes: Schema.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER).default(8 * 1024 * 1024 * 1024),
  maxSourcePixels: Schema.number().step(1).min(1).max(268_435_456).default(33_177_600),
  maxDurationSeconds: Schema.number().min(1).max(86_400).default(18_000),
  maxRangeSeconds: Schema.number().min(1).max(3600).default(120),
  maxFrames: Schema.number().step(1).min(1).max(32).default(12),
  defaultFrames: Schema.number().step(1).min(1).max(32).default(6),
  frameMaxDimension: Schema.number().step(1).min(64).max(4096).default(1280),
  maxFrameBytes: Schema.number().step(1).min(1024).max(32 * 1024 * 1024).default(4 * 1024 * 1024),
  maxConcurrent: Schema.number().step(1).min(1).max(16).default(2),
  commandTimeoutMs: Schema.number().step(1).min(1000).max(600_000).default(60_000),
  graceMs: Schema.number().step(1).min(1).max(10_000).default(1000),
  sceneThreshold: Schema.number().min(0.01).max(1).default(0.25),
  scenePaddingSeconds: Schema.number().min(0.01).max(5).default(0.12),
  maxPlanPoints: Schema.number().step(1).min(1).max(10_000).default(1000),
  maxTranscriptBytes: Schema.number().step(1).min(1).max(16 * 1024 * 1024).default(2 * 1024 * 1024),
})

/** One decoded frame with its original source presentation timestamp. */
export interface VideoFrame {
  /** Caller-selected seek time, in seconds. */
  requested_seconds: number
  /** Source frame presentation timestamp reported by FFmpeg, in seconds. */
  timestamp_seconds: number
  /** Durable normalized image supplied to the model alongside its timestamp. */
  image: ImageAttachmentRef
}

/** Published source facts and sampled observations, never continuous visual coverage. */
export interface VideoInspection extends VideoMetadata {
  path: string
  source_version: FsVersion
  inspection: 'metadata' | 'sampled_frames'
  interval: { start_seconds: number; end_seconds: number }
  frames: VideoFrame[]
  manifest_path: string
  verified_readback: boolean
  next_start_seconds?: number
  /** Selected and unviewed adaptive observations from the verified sources. */
  sampling_plan?: AdaptivePlan
  /** ASR file identity when utterance boundaries informed the selection. */
  transcript_source?: { path: string; version: FsVersion }
}

const imageSchema = IMAGE_RESULT_SCHEMA
const observationSchema = { type: 'object', additionalProperties: false, properties: { time: { type: 'number', required: true }, reasons: { type: 'array', items: { type: 'string' }, required: true } } } as const

const outputSchema = { type: 'object', additionalProperties: false, properties: {
  path: { type: 'string', required: true }, source_version: { type: 'string', required: true },
  duration_seconds: { type: 'number', required: true }, width: { type: 'integer', required: true }, height: { type: 'integer', required: true },
  video_codec: { type: 'string', required: true }, has_audio: { type: 'boolean', required: true },
  inspection: { type: 'string', enum: ['metadata', 'sampled_frames'], required: true },
  interval: { type: 'object', additionalProperties: false, required: true, properties: { start_seconds: { type: 'number', required: true }, end_seconds: { type: 'number', required: true } } },
  frames: { type: 'array', required: true, items: { type: 'object', additionalProperties: false, properties: {
    requested_seconds: { type: 'number', required: true }, timestamp_seconds: { type: 'number', required: true }, image: { ...imageSchema, required: true },
  } } },
  sampling_plan: { type: 'object', additionalProperties: false, properties: { strategy: { type: 'string', const: 'scene_dialogue', required: true }, selected: { type: 'array', items: observationSchema, required: true }, deferred: { type: 'array', items: observationSchema, required: true } } },
  transcript_source: { type: 'object', additionalProperties: false, properties: { path: { type: 'string', required: true }, version: { type: 'string', required: true } } },
  manifest_path: { type: 'string', required: true }, verified_readback: { type: 'boolean', required: true }, next_start_seconds: { type: 'number' },
} } as const

/**
 * Render compact metadata followed by real image blocks with adjacent source timecodes.
 * @param value - Published inspection and durable image references.
 * @returns Logged text and image blocks suitable for native and nested tool dispatches.
 */
export function inspectionContent(value: VideoInspection): ContentBlock[] {
  const { frames, path, manifest_path, ...summary } = value
  const audioAdvice = value.has_audio
    ? 'Discover audio_transcribe when dialogue or subtitles are required.' : 'No audio track was detected.'
  const content: ContentBlock[] = [{ type: 'text', text: JSON.stringify({ ...summary, frame_count: frames.length })
    + `\nVideo path: ${path}\nInspection manifest: ${manifest_path}`
    + `\nThese are sampled frames, not continuous viewing. Audio has not been transcribed. ${audioAdvice}` }]
  for (const frame of frames) {
    content.push({ type: 'text', text: `Source video ${value.path}; frame timestamp ${frame.timestamp_seconds}s (requested ${frame.requested_seconds}s).` })
    content.push({ type: 'image', attachment: frame.image })
  }
  return content
}

async function imageRoute(ctx: Context, exec: ToolExecution): Promise<void> {
  const config = exec.agent?.session.requestHeader()?.config
  const provider = config?.provider ?? exec.agent?.options.provider, model = config?.model ?? exec.agent?.options.model
  const llm = ctx.get('llm')
  if (!llm || !provider || !model) throw new Error('Video sampling requires a resolved image-capable model route')
  const info = await llm.resolveModelInfo(provider, model, exec.signal)
  if (!info.inputModalities?.includes('image')) throw new Error(`Model "${model}" does not accept images; select an image-capable model before sampling video`)
}

/**
 * Register metadata and sampled-frame inspection with bounded concurrent media work.
 * @param ctx - Media, filesystem, attachment and tool services in one execution world.
 * @param config - Validated media binaries and limits.
 */
export function apply(ctx: Context, config: Config): void {
  if (config.defaultFrames > config.maxFrames) throw new Error('defaultFrames must not exceed maxFrames')
  let disposed = false
  const active = new Map<AbortController, Promise<void>>()
  ctx.effect(() => async () => {
    disposed = true
    for (const owner of active.keys()) owner.abort(new Error('Video inspection disposed'))
    await Promise.all(active.values())
  }, 'video-inspect: cancel inspections')
  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'video_inspect',
    description: 'Inspect local video metadata or view timestamped sampled frames. Returns actual images and a saved inspection manifest. '
      + 'Samples do not cover every moment; inspect additional intervals or explicit timecodes for uncertain actions. '
      + 'strategy=scene_dialogue selects detected scene-cut sides and ASR utterance midpoints, retaining deferred timecodes for later inspection. '
      + 'For dialogue and subtitles, discover audio_transcribe.',
    parameters: {
      file_path: { type: 'string', required: true, description: 'Local video path in the current Session filesystem.' },
      method: { type: 'string', enum: ['metadata', 'sample'], description: 'Default sample returns frames; metadata only probes source facts without image input.' },
      start_seconds: { type: 'number', description: 'Interval start, default 0; source timecode in seconds.' },
      end_seconds: { type: 'number', description: 'Exclusive interval end; default video end or start + '
        + `${Math.min(60, config.maxRangeSeconds)} seconds, whichever is earlier. Maximum sampled interval: ${config.maxRangeSeconds} seconds.` },
      strategy: { type: 'string', enum: ['uniform', 'scene_dialogue'], description: 'Default uniform. scene_dialogue detects scene changes and, when transcript_path is supplied, samples actual ASR utterance midpoints. Deferred observations remain unviewed.' },
      transcript_path: { type: 'string', description: 'Optional actual audio_transcribe JSON array or segments wrapper for scene_dialogue; video and ASR source must describe the same complete clip.' },
      frame_count: { type: 'integer', description: `Uniform samples, default ${config.defaultFrames}; maximum ${config.maxFrames}.` },
      timestamps_seconds: { type: 'array', items: { type: 'number' },
        description: `Optional explicit seek times inside the interval instead of uniform samples; maximum ${config.maxFrames}.` },
      manifest_path: { type: 'string', description: 'Optional new JSON output path inside the current workspace; default .muse/video-inspections/<unique-id>.json. An existing file is never replaced.' },
    },
    output: {
      schema: outputSchema,
      render: (_args, value) => {
        const { transcript_source, ...inspection } = value
        return inspectionContent({ ...inspection, source_version: FsVersion(value.source_version),
          ...transcript_source === undefined ? {} : {
            transcript_source: { ...transcript_source, version: FsVersion(transcript_source.version) },
          },
          frames: value.frames.map(frame => ({
            ...frame, image: { ...frame.image, attachmentId: AttachmentId(frame.image.attachmentId) },
          })),
        })
      },
      presentationMeta: (_args, value) => ({ path: value.path, manifestPath: value.manifest_path,
        frameCount: value.frames.length, interval: value.interval }),
    },
    isConcurrencySafe: () => true,
    async execute(args, exec): Promise<VideoInspection> {
      const method = args.method ?? 'sample'
      const adaptive = args.strategy === 'scene_dialogue'
      if ((adaptive && (method !== 'sample' || args.timestamps_seconds !== undefined)) || (args.transcript_path !== undefined && !adaptive)) throw Error('Adaptive sampling requires sample mode without explicit timestamps; transcript_path requires scene_dialogue')
      if (disposed) throw new Error('Video inspection is unavailable')
      if (active.size >= config.maxConcurrent) throw new Error('Video inspection is busy; retry after another inspection finishes')
      const owner = new AbortController()
      const completion = Promise.withResolvers<void>()
      active.set(owner, completion.promise)
      const signal = AbortSignal.any([owner.signal, exec.signal])
      try {
        if (method === 'sample') await imageRoute(ctx, { ...exec, signal })
        const policy = ctx.sandboxPolicy.resolve(exec.agent ? { session: exec.agent.session } : {})
        const target = await ctx.fs.resolve(args.file_path, { cwd: policy.workspaceRoot, signal })
        const info = await ctx.fs.stat(target, signal)
        if (!info || info.type !== 'file') throw new Error('Video input must be an existing regular file')
        if (info.size === undefined || info.size > config.maxSourceBytes) throw new Error('Video source size is unavailable or exceeds the deployment limit')
        await ctx.fs.readByteRange(target, { offset: 0, length: 1 }, signal)
        const source = ctx.fs.processPath(target)
        const ffprobe = await ctx.subprocess.resolveExecutable(config.ffprobePath, undefined, signal)
        const limits = { timeoutMs: config.commandTimeoutMs, graceMs: config.graceMs, maxBytes: 128 * 1024 }
        const probe = await runMedia(ctx, [ffprobe, '-v', 'error', '-protocol_whitelist', 'file,pipe', '-show_entries',
          'format=duration:stream=index,codec_type,codec_name,width,height', '-of', 'json', source], policy, signal, limits)
        const metadata = parseVideoMetadata(probe.bytes)
        if (metadata.duration_seconds > config.maxDurationSeconds) throw new Error('Video duration exceeds the deployment limit')
        if (metadata.width * metadata.height > config.maxSourcePixels) throw new Error('Encoded video dimensions exceed the deployment limit')
        const start = method === 'metadata' ? 0 : args.start_seconds ?? 0
        const end = method === 'metadata' ? metadata.duration_seconds
          : args.end_seconds ?? Math.min(metadata.duration_seconds, start + Math.min(60, config.maxRangeSeconds))
        let timestamps = method === 'metadata' ? [] : planSamples({ duration: metadata.duration_seconds, start, end,
          count: args.frame_count ?? config.defaultFrames,
          ...args.timestamps_seconds === undefined ? {} : { timestamps: args.timestamps_seconds } }, config)
        let samplingPlan: AdaptivePlan | undefined
        let transcriptSource: VideoInspection['transcript_source']
        if (adaptive) {
          const ffmpeg = await ctx.subprocess.resolveExecutable(config.ffmpegPath, undefined, signal)
          const detected = await runMedia(ctx, [ffmpeg, '-nostdin', '-hide_banner', '-v', 'error', '-protocol_whitelist', 'file,pipe',
            '-ss', String(start), '-copyts', '-i', source, '-t', String(end - start), '-map', '0:v:0', '-an', '-sn', '-dn',
            '-vf', `trim=start=${start}:end=${end},scale=320:-2,select='gt(scene,${config.sceneThreshold})',metadata=print:file=-`, '-f', 'null', '-'], policy, signal,
          { ...limits, maxBytes: config.maxTranscriptBytes })
          let transcript: unknown
          if (args.transcript_path !== undefined) {
            const target = await ctx.fs.resolve(args.transcript_path, { cwd: policy.workspaceRoot, signal })
            const before = await ctx.fs.stat(target, signal)
            if (before?.type !== 'file') throw Error('Adaptive sampling transcript must be an existing file')
            const bytes = await ctx.fs.readBytes(target, signal, config.maxTranscriptBytes)
            transcript = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
            if ((await ctx.fs.stat(target, signal))?.version !== before.version) throw Error('Transcript changed during adaptive planning')
            transcriptSource = { path: target.displayPath, version: before.version }
          }
          samplingPlan = adaptivePlan({ start, end, duration: metadata.duration_seconds, uniform: timestamps,
            cuts: sceneTimecodes(detected.bytes, start, end), ...transcript === undefined ? {} : { transcript } },
          { maxFrames: args.frame_count ?? config.defaultFrames, maxPlanPoints: config.maxPlanPoints,
            scenePaddingSeconds: config.scenePaddingSeconds })
          timestamps = samplingPlan.selected.map(point => point.time)
        }
        const frames: VideoFrame[] = []
        if (timestamps.length) {
          const ffmpeg = await ctx.subprocess.resolveExecutable(config.ffmpegPath, undefined, signal)
          for (const seek of timestamps) {
            const frame = await runMedia(ctx, [ffmpeg, '-nostdin', '-hide_banner', '-loglevel', 'info', '-protocol_whitelist', 'file,pipe',
              '-ss', String(seek), '-copyts', '-i', source, '-map', '0:v:0', '-an', '-sn', '-dn', '-frames:v', '1',
              '-vf', `scale=w='min(${config.frameMaxDimension},iw)':h='min(${config.frameMaxDimension},ih)':force_original_aspect_ratio=decrease,showinfo`,
              '-c:v', 'png', '-f', 'image2pipe', 'pipe:1'], policy, signal, { ...limits, maxBytes: config.maxFrameBytes })
            const match = /\bpts_time:([\d.e+-]+)/.exec(frame.diagnostic)
            const timestamp = match ? Number(match[1]) : NaN
            if (!Number.isFinite(timestamp) || timestamp < 0 || timestamp >= metadata.duration_seconds || !frame.bytes.length) {
              throw new Error('Frame extraction did not return a verifiable source timestamp and image')
            }
            const image = await ctx.attachments.saveImage({ data: frame.bytes, mediaType: 'image/png', name: `video-frame-${timestamp}.png` })
            frames.push({ requested_seconds: seek, timestamp_seconds: timestamp, image })
          }
        }
        if (transcriptSource !== undefined && (await ctx.fs.stat(await ctx.fs.resolve(transcriptSource.path, { signal }), signal))?.version !== transcriptSource.version) throw Error('Transcript changed during inspection')
        if ((await ctx.fs.stat(target, signal))?.version !== info.version) throw new Error('Video changed during inspection; inspect the current source again')
        const manifest = await ctx.fs.resolve(args.manifest_path ?? `.muse/video-inspections/${randomUUID()}.json`, { cwd: policy.workspaceRoot, signal })
        const root = await ctx.fs.resolve(policy.workspaceRoot, { signal })
        if (!ctx.fs.contains(root, manifest)) throw new Error('Inspection manifest must be inside the current workspace')
        const value: VideoInspection = { ...metadata, path: target.displayPath, source_version: info.version,
          inspection: method === 'metadata' ? 'metadata' : 'sampled_frames', interval: { start_seconds: start, end_seconds: end }, frames,
          manifest_path: manifest.displayPath, verified_readback: true,
          ...samplingPlan === undefined ? {} : { sampling_plan: samplingPlan },
          ...transcriptSource === undefined ? {} : { transcript_source: transcriptSource },
          ...method === 'sample' && end < metadata.duration_seconds ? { next_start_seconds: end } : {},
        }
        const serialized = JSON.stringify(value, null, 2) + '\n'
        await ctx.fs.writeText(manifest, serialized, { kind: 'createIfAbsent' }, signal, policy)
        if (await ctx.fs.readText(manifest, signal) !== serialized) throw new Error('Inspection manifest readback did not match')
        ctx.emit('fs/observed', target, { kind: 'present', version: info.version }, exec)
        return value
      } finally { active.delete(owner); completion.resolve() }
    },
  })), 'video-inspect: model tool')
}
