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
import { ADAPTIVE_PLAN_SCHEMA, SAMPLING_ADVICE, adaptivePlan, sceneTimecodes, type AdaptivePlan } from './adaptive.ts'
import { probeVideo, runMedia, type VideoMetadata } from './media.ts'
import { installVideoEvidence } from './evidence.ts'
import { applyContactSheets } from './contact.ts'
import { applyVideoOcr } from './ocr.ts'

export { resolveTrustedVideoEvidence, TRUSTED_VIDEO_INSPECTION_RECEIPT, type TrustedVideoInspectionReceipt } from './evidence.ts'

/** Plugin name for video observations. */
export const name = 'tool-video-inspect'

/** Media reads, process ownership and durable image admission are registered services. */
export const inject = ['tools', 'fs', 'subprocess', 'attachments', 'sandboxPolicy']

/** Deployment-resolved media executables and inspection bounds. */
export interface Config {
  /** Creation-only metadata plans and Host-issued visual evidence; disabled in other deployments. */
  trustedEvidence: boolean
  /** Same-world FFmpeg executable. */
  ffmpegPath: string
  /** Same-world FFprobe executable. */
  ffprobePath: string
  /** Windows PowerShell executable used by the local OCR bridge. */
  powershellPath: string
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
  /** Encoding of extracted observations; original video bytes remain unchanged. */
  frameFormat: 'png' | 'jpeg'
  /** FFmpeg JPEG quantizer, from 1 (highest quality) to 31; ignored for PNG. */
  frameJpegQuality: number
  /** Largest complete image output from one extraction command, in bytes. */
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
  /** Largest original ASR text preview per candidate utterance, in Unicode grapheme clusters. */
  utterancePreviewCharacters: number
  /** Default grid columns for overview pages. */
  contactColumns: number
  /** Default grid rows for overview pages. */
  contactRows: number
  /** Default overview cell width in pixels. */
  contactTileWidth: number
  /** Maximum sampled frames in one overview call, across all pages. */
  maxContactFrames: number
  /** Maximum overview source interval in seconds. */
  maxContactRangeSeconds: number
  /** Maximum pixel area of one overview page. */
  maxContactPixels: number
  /** Maximum complete overview-page bytes per call. */
  maxContactBytes: number
  /** Local OCR engine; the RapidOCR deployment includes its Python runtime and pinned models. */
  ocrEngine: 'windows-native' | 'rapidocr'
  /** Same-world Python interpreter for the RapidOCR bridge. */
  ocrPythonPath: string
  /** CPU threads used by the RapidOCR engine. */
  ocrCpuThreads: number
  /** Default OCR recognition language. */
  ocrLanguage: 'auto' | 'zh-Hans-CN' | 'zh-Hant-TW' | 'en-US'
  /** Default seconds between OCR frame samples. */
  ocrFrameIntervalSeconds: number
  /** Smallest allowed OCR frame spacing. */
  ocrMinFrameIntervalSeconds: number
  /** Largest allowed OCR frame spacing. */
  ocrMaxFrameIntervalSeconds: number
  /** Largest source interval scanned by one OCR call. */
  ocrMaxRangeSeconds: number
  /** Largest planned frame count in one OCR call. */
  ocrMaxFrames: number
  /** Largest frame count sent to one persistent OCR bridge process. */
  ocrBatchFrames: number
  /** Largest decoded OCR frame dimension. */
  ocrFrameMaxDimension: number
  /** FFmpeg JPEG quantizer used for OCR input frames. */
  ocrFrameJpegQuality: number
  /** Largest complete MJPEG extraction batch. */
  maxOcrBatchImageBytes: number
  /** Largest JSON input sent to the OCR bridge. */
  maxOcrBridgeInputBytes: number
  /** Largest JSON output accepted from the OCR bridge. */
  maxOcrOutputBytes: number
  /** Largest diagnostic output retained from OCR subprocesses. */
  maxOcrDiagnosticBytes: number
  /** Deadline for one OCR extraction or bridge batch. */
  ocrCommandTimeoutMs: number
  /** Minimum identical observations before labelling visual text persistence. */
  ocrPersistentTextMinFrames: number
  /** Minimum seconds identical text must persist before labelling. */
  ocrPersistentTextMinSeconds: number
  /** Minimum spatial overlap for identical text evidence. */
  ocrOverlayMinIou: number
  /** Maximum merged segments returned inline; full evidence remains in files. */
  ocrPreviewSegments: number
}

/** Validated deployment knobs; argument defaults are resolved before media work. */
export const Config: Schema<Partial<Config>, Config> = Schema.object({
  trustedEvidence: Schema.boolean().default(false),
  ffmpegPath: Schema.string().default('ffmpeg'), ffprobePath: Schema.string().default('ffprobe'),
  powershellPath: Schema.string().default('powershell.exe'),
  maxSourceBytes: Schema.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER).default(8 * 1024 * 1024 * 1024),
  maxSourcePixels: Schema.number().step(1).min(1).max(268_435_456).default(33_177_600),
  maxDurationSeconds: Schema.number().min(1).max(86_400).default(18_000),
  maxRangeSeconds: Schema.number().min(1).max(3600).default(120),
  maxFrames: Schema.number().step(1).min(1).max(32).default(12),
  defaultFrames: Schema.number().step(1).min(1).max(32).default(6),
  frameMaxDimension: Schema.number().step(1).min(64).max(4096).default(1280),
  frameFormat: Schema.union(['png', 'jpeg']).default('png'),
  frameJpegQuality: Schema.number().step(1).min(1).max(31).default(2),
  maxFrameBytes: Schema.number().step(1).min(1024).max(32 * 1024 * 1024).default(4 * 1024 * 1024),
  maxConcurrent: Schema.number().step(1).min(1).max(16).default(2),
  commandTimeoutMs: Schema.number().step(1).min(1000).max(600_000).default(60_000),
  graceMs: Schema.number().step(1).min(1).max(10_000).default(1000),
  sceneThreshold: Schema.number().min(0.01).max(1).default(0.25),
  scenePaddingSeconds: Schema.number().min(0.01).max(5).default(0.12),
  maxPlanPoints: Schema.number().step(1).min(1).max(10_000).default(1000),
  maxTranscriptBytes: Schema.number().step(1).min(1).max(16 * 1024 * 1024).default(2 * 1024 * 1024),
  utterancePreviewCharacters: Schema.number().step(1).min(1).max(2000).default(80),
  contactColumns: Schema.number().step(1).min(1).max(32).default(3),
  contactRows: Schema.number().step(1).min(1).max(32).default(3),
  contactTileWidth: Schema.number().step(1).min(160).max(1280).default(320),
  maxContactFrames: Schema.number().step(1).min(1).max(32).default(32),
  maxContactRangeSeconds: Schema.number().min(1).max(3600).default(300),
  maxContactPixels: Schema.number().step(1).min(1).max(33_177_600).default(16_000_000),
  maxContactBytes: Schema.number().step(1).min(1024).max(32 * 1024 * 1024).default(8 * 1024 * 1024),
  ocrEngine: Schema.union(['windows-native', 'rapidocr']).default('windows-native'),
  ocrPythonPath: Schema.string().default('python3'),
  ocrCpuThreads: Schema.number().step(1).min(1).max(16).default(2),
  ocrLanguage: Schema.union(['auto', 'zh-Hans-CN', 'zh-Hant-TW', 'en-US']).default('auto'),
  ocrFrameIntervalSeconds: Schema.number().min(0.1).max(60).default(0.5),
  ocrMinFrameIntervalSeconds: Schema.number().min(0.1).max(60).default(0.25),
  ocrMaxFrameIntervalSeconds: Schema.number().min(0.1).max(300).default(30),
  ocrMaxRangeSeconds: Schema.number().min(1).max(3600).default(120),
  ocrMaxFrames: Schema.number().step(1).min(1).max(1000).default(240),
  ocrBatchFrames: Schema.number().step(1).min(1).max(100).default(24),
  ocrFrameMaxDimension: Schema.number().step(1).min(320).max(4096).default(1280),
  ocrFrameJpegQuality: Schema.number().step(1).min(1).max(31).default(3),
  maxOcrBatchImageBytes: Schema.number().step(1).min(1024).max(256 * 1024 * 1024).default(32 * 1024 * 1024),
  maxOcrBridgeInputBytes: Schema.number().step(1).min(1024).max(384 * 1024 * 1024).default(48 * 1024 * 1024),
  maxOcrOutputBytes: Schema.number().step(1).min(1024).max(64 * 1024 * 1024).default(8 * 1024 * 1024),
  maxOcrDiagnosticBytes: Schema.number().step(1).min(1024).max(4 * 1024 * 1024).default(256 * 1024),
  ocrCommandTimeoutMs: Schema.number().step(1).min(1000).max(600_000).default(120_000),
  ocrPersistentTextMinFrames: Schema.number().step(1).min(2).max(1000).default(12),
  ocrPersistentTextMinSeconds: Schema.number().min(1).max(3600).default(8),
  ocrOverlayMinIou: Schema.number().min(0.1).max(1).default(0.7),
  ocrPreviewSegments: Schema.number().step(1).min(1).max(100).default(12),
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
  /** Complete probed-duration plan in opt-in metadata results; planned windows remain unviewed. */
  window_plan?: { start_seconds: number; end_seconds: number }[]
}

const imageSchema = IMAGE_RESULT_SCHEMA

const outputSchema = { type: 'object', additionalProperties: false, properties: {
  path: { type: 'string', required: true }, source_version: { type: 'string', required: true },
  duration_seconds: { type: 'number', required: true }, width: { type: 'integer', required: true }, height: { type: 'integer', required: true },
  video_codec: { type: 'string', required: true }, has_audio: { type: 'boolean', required: true },
  inspection: { type: 'string', enum: ['metadata', 'sampled_frames'], required: true },
  interval: { type: 'object', additionalProperties: false, required: true, properties: { start_seconds: { type: 'number', required: true }, end_seconds: { type: 'number', required: true } } },
  frames: { type: 'array', required: true, items: { type: 'object', additionalProperties: false, properties: {
    requested_seconds: { type: 'number', required: true }, timestamp_seconds: { type: 'number', required: true }, image: { ...imageSchema, required: true },
  } } },
  sampling_plan: ADAPTIVE_PLAN_SCHEMA,
  transcript_source: { type: 'object', additionalProperties: false, properties: { path: { type: 'string', required: true }, version: { type: 'string', required: true } } },
  manifest_path: { type: 'string', required: true }, verified_readback: { type: 'boolean', required: true }, next_start_seconds: { type: 'number' },
} } as const

const plannedOutputSchema = { ...outputSchema, properties: { ...outputSchema.properties,
  window_plan: { type: 'array', items: { type: 'object', additionalProperties: false, properties: {
    start_seconds: { type: 'number', required: true }, end_seconds: { type: 'number', required: true },
  } } },
} } as const

/**
 * Render compact metadata followed by real image blocks with adjacent source timecodes.
 * @param value - Published inspection and durable image references.
 * @returns Logged text and image blocks suitable for native and nested tool dispatches.
 */
export function inspectionContent(value: VideoInspection): ContentBlock[] {
  const { frames, path, manifest_path, ...summary } = value
  const audioAdvice = value.has_audio
    ? 'Use audio_transcribe for spoken dialogue. Use video_ocr for visible or burned-in text.' : 'No audio track was detected; use video_ocr for visible text.'
  const content: ContentBlock[] = [{ type: 'text', text: JSON.stringify({ ...summary, frame_count: frames.length })
    + `\nVideo path: ${path}\nInspection manifest: ${manifest_path}`
    + `\nThese are sampled frames, not continuous viewing. Audio has not been transcribed. ${audioAdvice}`
    + `\n${SAMPLING_ADVICE}`
    + (value.transcript_source === undefined ? '' : '\nASR utterances retain source times, text previews and task-local acoustic speaker_id values; they do not identify characters or verify timbre. Compare the actual speaking interval with the image, including off-screen speech.') }]
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
  if (config.ocrMinFrameIntervalSeconds > config.ocrFrameIntervalSeconds
    || config.ocrFrameIntervalSeconds > config.ocrMaxFrameIntervalSeconds) {
    throw new Error('OCR frame interval bounds must contain ocrFrameIntervalSeconds')
  }
  if (config.ocrBatchFrames > config.ocrMaxFrames) throw new Error('ocrBatchFrames must not exceed ocrMaxFrames')
  const evidence = config.trustedEvidence ? installVideoEvidence(ctx) : undefined
  let disposed = false
  const active = new Map<AbortController, Promise<void>>()
  ctx.effect(() => async () => {
    disposed = true
    for (const owner of active.keys()) owner.abort(new Error('Video inspection disposed'))
    await Promise.all(active.values())
  }, 'video-inspect: cancel inspections')
  const run = async <T>(exec: ToolExecution, operation: (signal: AbortSignal) => Promise<T>): Promise<T> => {
    if (disposed) throw new Error('Video inspection is unavailable')
    if (active.size >= config.maxConcurrent) throw new Error('Video inspection is busy; retry after another inspection finishes')
    const owner = new AbortController()
    const completion = Promise.withResolvers<void>()
    active.set(owner, completion.promise)
    try { return await operation(AbortSignal.any([owner.signal, exec.signal])) }
    finally { active.delete(owner); completion.resolve() }
  }
  applyContactSheets(ctx, config, { run, imageRoute: exec => imageRoute(ctx, exec) })
  applyVideoOcr(ctx, config, { run })
  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'video_inspect',
    description: 'Inspect local video metadata or view timestamped sampled frames. Returns actual images and a saved inspection manifest. '
      + 'Samples do not cover every moment; inspect additional intervals or explicit timecodes for uncertain actions. '
      + 'strategy=scene_dialogue selects visual-cut sides and ASR utterance midpoints with original speech context, retaining deferred timecodes for later inspection. '
      + 'Use audio_transcribe for spoken dialogue and video_ocr for visible or burned-in text.',
    parameters: {
      file_path: { type: 'string', required: true, description: 'Local video path in the current Session filesystem.' },
      method: { type: 'string', enum: ['metadata', 'sample'], description: 'Default sample returns frames; metadata only probes source facts without image input.' },
      start_seconds: { type: 'number', description: 'Interval start, default 0; source timecode in seconds.' },
      end_seconds: { type: 'number', description: 'Exclusive interval end; default video end or start + '
        + `${Math.min(60, config.maxRangeSeconds)} seconds, whichever is earlier. Maximum sampled interval: ${config.maxRangeSeconds} seconds.` },
      strategy: { type: 'string', enum: ['uniform', 'scene_dialogue'], description: 'Default uniform. scene_dialogue detects visual cuts and, when transcript_path is supplied, samples actual ASR utterance midpoints with source times, text previews and optional speaker_id. Deferred observations remain unviewed.' },
      transcript_path: { type: 'string', description: 'Optional actual audio_transcribe JSON array or segments wrapper for scene_dialogue; video and ASR source must describe the same complete clip.' },
      frame_count: { type: 'integer', description: `Uniform samples, default ${config.defaultFrames}; maximum ${config.maxFrames}.` },
      timestamps_seconds: { type: 'array', items: { type: 'number' },
        description: `Optional explicit seek times inside the interval instead of uniform samples; maximum ${config.maxFrames}.` },
      manifest_path: { type: 'string', description: 'Optional new JSON output path inside the current workspace; default .muse/video-inspections/<unique-id>.json. An existing file is never replaced.' },
    },
    output: {
      schema: config.trustedEvidence ? plannedOutputSchema : outputSchema,
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
      return run(exec, async (signal) => {
        if (method === 'sample') await imageRoute(ctx, { ...exec, signal })
        const policy = ctx.sandboxPolicy.resolve(exec.agent ? { session: exec.agent.session } : {})
        const target = await ctx.fs.resolve(args.file_path, { cwd: policy.workspaceRoot, signal })
        const info = await ctx.fs.stat(target, signal)
        if (!info || info.type !== 'file') throw new Error('Video input must be an existing regular file')
        if (info.size === undefined || info.size > config.maxSourceBytes) throw new Error('Video source size is unavailable or exceeds the deployment limit')
        await ctx.fs.readByteRange(target, { offset: 0, length: 1 }, signal)
        const source = ctx.fs.processPath(target)
        const limits = { timeoutMs: config.commandTimeoutMs, graceMs: config.graceMs }
        const metadata = await probeVideo(ctx, config.ffprobePath, source, policy, signal, limits)
        if (metadata.duration_seconds > config.maxDurationSeconds) throw new Error('Video duration exceeds the deployment limit')
        if (metadata.width * metadata.height > config.maxSourcePixels) throw new Error('Encoded video dimensions exceed the deployment limit')
        const priorMetadata = method === 'sample' ? evidence?.metadata(exec, target.displayPath, info.version, metadata.duration_seconds) : undefined
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
            scenePaddingSeconds: config.scenePaddingSeconds, utterancePreviewCharacters: config.utterancePreviewCharacters })
          timestamps = samplingPlan.selected.map(point => point.time)
        }
        const frames: VideoFrame[] = []
        if (timestamps.length) {
          const ffmpeg = await ctx.subprocess.resolveExecutable(config.ffmpegPath, undefined, signal)
          for (const seek of timestamps) {
            const frame = await runMedia(ctx, [ffmpeg, '-nostdin', '-hide_banner', '-loglevel', 'info', '-protocol_whitelist', 'file,pipe',
              '-ss', String(seek), '-copyts', '-i', source, '-map', '0:v:0', '-an', '-sn', '-dn', '-frames:v', '1',
              '-vf', `scale=w='min(${config.frameMaxDimension},iw)':h='min(${config.frameMaxDimension},ih)':force_original_aspect_ratio=decrease,showinfo`,
              '-c:v', config.frameFormat === 'png' ? 'png' : 'mjpeg',
              ...config.frameFormat === 'jpeg' ? ['-q:v', String(config.frameJpegQuality)] : [],
              '-f', 'image2pipe', 'pipe:1'], policy, signal, { ...limits, maxBytes: config.maxFrameBytes })
            const match = /\bpts_time:([\d.e+-]+)/.exec(frame.diagnostic)
            const timestamp = match ? Number(match[1]) : NaN
            if (!Number.isFinite(timestamp) || timestamp < 0 || timestamp >= metadata.duration_seconds || !frame.bytes.length) {
              throw new Error('Frame extraction did not return a verifiable source timestamp and image')
            }
            const image = await ctx.attachments.saveImage({ data: frame.bytes,
              mediaType: config.frameFormat === 'png' ? 'image/png' : 'image/jpeg',
              name: `video-frame-${timestamp}.${config.frameFormat === 'png' ? 'png' : 'jpg'}` })
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
          ...method === 'metadata' && evidence !== undefined ? { window_plan: Array.from({ length: Math.ceil(metadata.duration_seconds / Math.min(60, config.maxRangeSeconds)) },
            (_, index) => ({ start_seconds: index * Math.min(60, config.maxRangeSeconds),
              end_seconds: Math.min(metadata.duration_seconds, (index + 1) * Math.min(60, config.maxRangeSeconds)) })) } : {},
        }
        const serialized = JSON.stringify(value, null, 2) + '\n'
        await ctx.fs.writeText(manifest, serialized, { kind: 'createIfAbsent' }, signal, policy)
        if (await ctx.fs.readText(manifest, signal) !== serialized) throw new Error('Inspection manifest readback did not match')
        signal.throwIfAborted()
        evidence?.issue(exec, value, serialized, priorMetadata)
        ctx.emit('fs/observed', target, { kind: 'present', version: info.version }, exec)
        return value
      })
    },
  })), 'video-inspect: model tool')
}
