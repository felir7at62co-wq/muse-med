/** Timestamp-labelled video overviews; detailed inspection remains a separate frame read. */
import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import sharp, { type OverlayOptions } from 'sharp'
import { AttachmentId, IMAGE_RESULT_SCHEMA, type ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import { FsVersion } from '@deepseek-ai/dsh-fs'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { defineTool, type ToolExecution } from '@deepseek-ai/dsh-tools'
import type { Config, VideoFrame } from './index.ts'
import { ADAPTIVE_PLAN_SCHEMA, SAMPLING_ADVICE, adaptivePlan, sceneTimecodes, type AdaptivePlan } from './adaptive.ts'
import { probeVideo, runMedia, type VideoMetadata } from './media.ts'
import { planSamples } from './sample.ts'

/** Shared inspection ownership, including plugin removal and calling-model image admission. */
export interface ContactRuntime {
  /** Runs media work within the plugin's shared concurrency and cancellation limits. */
  run<T>(exec: ToolExecution, operation: (signal: AbortSignal) => Promise<T>): Promise<T>
  /** Refuses unresolved or text-only routes before image work. */
  imageRoute(exec: ToolExecution): Promise<void>
}

/** One overview page with chronological cells and retained detailed frame references. */
export interface ContactPage {
  page: number
  image: ImageAttachmentRef
  frames: (VideoFrame & { cell: number; index: number })[]
}

/** Saved video overview; no continuous-viewing or trusted acceptance claim. */
export interface VideoContactSheet extends VideoMetadata {
  path: string
  source_version: FsVersion
  manifest_path: string
  interval: { start_seconds: number; end_seconds: number }
  columns: number
  rows: number
  pages: ContactPage[]
  next_start_seconds?: number
  /** Selected and unviewed scene-strategy candidates; a cut does not establish a story scene change. */
  sampling_plan?: AdaptivePlan
}

const schema = { type: 'object', additionalProperties: false, properties: {
  path: { type: 'string', required: true }, source_version: { type: 'string', required: true },
  duration_seconds: { type: 'number', required: true }, width: { type: 'integer', required: true }, height: { type: 'integer', required: true },
  video_codec: { type: 'string', required: true }, has_audio: { type: 'boolean', required: true },
  manifest_path: { type: 'string', required: true }, next_start_seconds: { type: 'number' },
  sampling_plan: ADAPTIVE_PLAN_SCHEMA,
  interval: { type: 'object', additionalProperties: false, required: true, properties: {
    start_seconds: { type: 'number', required: true }, end_seconds: { type: 'number', required: true },
  } },
  columns: { type: 'integer', required: true }, rows: { type: 'integer', required: true },
  pages: { type: 'array', required: true, items: { type: 'object', additionalProperties: false, properties: {
    page: { type: 'integer', required: true }, image: { ...IMAGE_RESULT_SCHEMA, required: true },
    frames: { type: 'array', required: true, items: { type: 'object', additionalProperties: false, properties: {
      cell: { type: 'integer', required: true }, index: { type: 'integer', required: true },
      requested_seconds: { type: 'number', required: true }, timestamp_seconds: { type: 'number', required: true },
      image: { ...IMAGE_RESULT_SCHEMA, required: true },
    } } },
  } } },
} } as const

/**
 * Format a decoded source timestamp without discarding milliseconds.
 * @param seconds - Non-negative source presentation time.
 * @returns Hour, minute, second and millisecond label.
 */
export function contactTimecode(seconds: number): string {
  const ms = Math.round(seconds * 1000)
  return `${String(Math.floor(ms / 3_600_000)).padStart(2, '0')}:${String(Math.floor(ms / 60_000) % 60).padStart(2, '0')}:`
    + `${String(Math.floor(ms / 1000) % 60).padStart(2, '0')}.${String(ms % 1000).padStart(3, '0')}`
}

/**
 * Render overview images and the timecodes needed to request detailed source frames.
 * @param value - Source facts and saved chronological pages.
 * @returns Actual images, compact cell timecodes and a detail instruction.
 */
export function contactContent(value: VideoContactSheet): ContentBlock[] {
  const { pages, ...summary } = value
  const content: ContentBlock[] = [{ type: 'text', text: JSON.stringify({ ...summary,
    frame_count: pages.reduce((sum, page) => sum + page.frames.length, 0), page_count: pages.length })
    + '\nRead cells left to right, then top to bottom. Labels show actual source frame timestamps.'
    + '\nThese are overview thumbnails, not continuous viewing or detailed frame approval. Audio has not been transcribed.'
    + '\nFor a doubtful cell, first obtain successful video_inspect method=metadata for the current file. '
    + 'Then use method=sample with the same file_path, a bounded start_seconds/end_seconds containing the cell time, '
    + 'and timestamps_seconds; inspect its actual larger image.'
    + `\n${SAMPLING_ADVICE}` }]
  for (const page of pages) {
    content.push({ type: 'text', text: JSON.stringify({ page: page.page, cells: page.frames.map(frame => ({
      cell: frame.cell, index: frame.index, requested_seconds: frame.requested_seconds, timestamp_seconds: frame.timestamp_seconds,
    })) }) })
    content.push({ type: 'image', attachment: page.image })
  }
  return content
}

/**
 * Register configurable, paginated video overviews beside detailed video inspection.
 * @param ctx - Session filesystem, bounded media processes and image storage.
 * @param config - Validated deployment media, sampling and sheet limits.
 * @param runtime - Shared invocation ownership and image-route checks.
 */
export function applyContactSheets(ctx: Context, config: Config, runtime: ContactRuntime): void {
  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'video_contact_sheet',
    description: 'View a local video as timestamp-labelled image grids. Defaults to a nine-cell overview; use columns=3, rows=2 for six cells. '
      + 'Returns actual overview images, ordered cell timecodes, unviewed cut candidates and a saved manifest. Extra frames form further pages. '
      + 'Use video_inspect at a doubtful cell timecode for a larger frame. Overview thumbnails do not establish detailed or continuous coverage.',
    parameters: {
      file_path: { type: 'string', required: true, description: 'Local source video in the current Session filesystem.' },
      columns: { type: 'integer', description: `Cells per row; default ${config.contactColumns}.` },
      rows: { type: 'integer', description: `Rows per page; default ${config.contactRows}.` },
      tile_width: { type: 'integer', description: `Cell image width in pixels; default ${config.contactTileWidth}. Height preserves source aspect ratio.` },
      frame_count: { type: 'integer', description: `Default one page of frames; maximum ${config.maxContactFrames}. Additional frames form chronological pages.` },
      start_seconds: { type: 'number', description: 'Inclusive source range start; default 0.' },
      end_seconds: { type: 'number', description: `Exclusive range end; default source end or start + ${config.maxContactRangeSeconds}s. Follow next_start_seconds for remaining ranges.` },
      timestamps_seconds: { type: 'array', items: { type: 'number' }, description: 'Specific source times instead of uniform sampling. Cannot combine with frame_interval_seconds or scene strategy.' },
      frame_interval_seconds: { type: 'number', description: 'Positive spacing from range start. Cannot combine with frame_count, explicit times or scene strategy.' },
      strategy: { type: 'string', enum: ['uniform', 'scene'], description: 'Default uniform. scene prioritizes frames on both sides of detected cuts across the selected range.' },
      manifest_path: { type: 'string', description: 'New JSON manifest inside the workspace. Existing files are never replaced.' },
    },
    output: {
      schema,
      render: (_args, value) => contactContent({ ...value, source_version: FsVersion(value.source_version),
        pages: value.pages.map(page => ({ ...page, image: { ...page.image, attachmentId: AttachmentId(page.image.attachmentId) },
          frames: page.frames.map(frame => ({ ...frame, image: { ...frame.image, attachmentId: AttachmentId(frame.image.attachmentId) } })),
        })),
      }),
      presentationMeta: (_args, value) => ({ path: value.path, manifestPath: value.manifest_path,
        pageCount: value.pages.length, columns: value.columns, rows: value.rows, interval: value.interval }),
    },
    presentCall: args => ({ card: 'generic', title: 'video_contact_sheet', kind: 'read', locations: [{ path: args.file_path }] }),
    isConcurrencySafe: () => true,
    execute: (args, exec): Promise<VideoContactSheet> => runtime.run(exec, async (signal) => {
      const policy = ctx.sandboxPolicy.resolve(exec.agent ? { session: exec.agent.session } : {})
      await runtime.imageRoute({ ...exec, signal })
      const columns = args.columns ?? config.contactColumns, rows = args.rows ?? config.contactRows
      const tileWidth = args.tile_width ?? config.contactTileWidth
      if (![columns, rows].every(n => Number.isSafeInteger(n) && n > 0 && n <= config.maxContactFrames)
        || !Number.isSafeInteger(tileWidth) || tileWidth < 160 || tileWidth > config.frameMaxDimension) throw Error('Use positive bounded columns/rows and tile_width from 160 to frameMaxDimension')
      if (args.frame_interval_seconds !== undefined && (!Number.isFinite(args.frame_interval_seconds) || args.frame_interval_seconds <= 0
        || args.frame_count !== undefined || args.timestamps_seconds !== undefined || args.strategy === 'scene')) throw Error('Positive frame_interval_seconds requires uniform sampling without frame_count or explicit timestamps')
      if (args.strategy === 'scene' && args.timestamps_seconds !== undefined) throw Error('Scene sampling cannot use explicit timestamps')
      const target = await ctx.fs.resolve(args.file_path, { cwd: policy.workspaceRoot, signal })
      const info = await ctx.fs.stat(target, signal)
      if (info?.type !== 'file' || info.size === undefined || info.size > config.maxSourceBytes) throw Error('Video source must be an existing regular file within maxSourceBytes')
      await ctx.fs.readByteRange(target, { offset: 0, length: 1 }, signal)
      const source = ctx.fs.processPath(target)
      const limits = { timeoutMs: config.commandTimeoutMs, graceMs: config.graceMs }
      const metadata = await probeVideo(ctx, config.ffprobePath, source, policy, signal, limits)
      if (metadata.duration_seconds > config.maxDurationSeconds || metadata.width * metadata.height > config.maxSourcePixels) throw Error('Video duration or encoded image area exceeds deployment limits')
      const start = args.start_seconds ?? 0
      const end = args.end_seconds ?? Math.min(metadata.duration_seconds, start + config.maxContactRangeSeconds)
      const count = args.frame_interval_seconds === undefined
        ? args.frame_count ?? Math.min(columns * rows, config.maxContactFrames)
        : Math.ceil((end - start) / args.frame_interval_seconds)
      const interval = args.frame_interval_seconds
      const explicit = args.timestamps_seconds ?? (interval === undefined ? undefined
        : Array.from({ length: Math.min(count, config.maxContactFrames + 1) }, (_, i) => start + i * interval))
      let timestamps = planSamples({ duration: metadata.duration_seconds, start, end, count,
        ...explicit === undefined ? {} : { timestamps: explicit } }, {
        maxRangeSeconds: config.maxContactRangeSeconds, maxFrames: config.maxContactFrames })
      const height = Math.max(1, Math.round(tileWidth * metadata.height / metadata.width))
      const labelHeight = Math.max(20, Math.round(tileWidth / 12))
      const width = columns * tileWidth, pageHeight = rows * (height + labelHeight)
      if (width * pageHeight > config.maxContactPixels || width > ctx.attachments.imageLimits.maxImageDimension
        || pageHeight > ctx.attachments.imageLimits.maxImageDimension || width * pageHeight > ctx.attachments.imageLimits.maxImagePixels) {
        throw Error('Grid dimensions exceed image limits; reduce rows, columns or tile_width')
      }
      const ffmpeg = await ctx.subprocess.resolveExecutable(config.ffmpegPath, undefined, signal)
      let samplingPlan: AdaptivePlan | undefined
      if (args.strategy === 'scene') {
        const detected = await runMedia(ctx, [ffmpeg, '-nostdin', '-hide_banner', '-v', 'error', '-protocol_whitelist', 'file,pipe',
          '-ss', String(start), '-copyts', '-i', source, '-t', String(end - start), '-map', '0:v:0', '-an', '-sn', '-dn',
          '-vf', `trim=start=${start}:end=${end},scale=320:-2,select='gt(scene,${config.sceneThreshold})',metadata=print:file=-`,
          '-f', 'null', '-'], policy, signal,
        { ...limits, maxBytes: config.maxTranscriptBytes })
        samplingPlan = adaptivePlan({ start, end, duration: metadata.duration_seconds, uniform: timestamps,
          cuts: sceneTimecodes(detected.bytes, start, end) },
        { maxFrames: count, maxPlanPoints: config.maxPlanPoints,
          scenePaddingSeconds: config.scenePaddingSeconds, utterancePreviewCharacters: config.utterancePreviewCharacters })
        timestamps = samplingPlan.selected.map(point => point.time)
      }
      const pages: ContactPage[] = []
      let totalBytes = 0
      for (let offset = 0; offset < timestamps.length; offset += columns * rows) {
        const overlays: OverlayOptions[] = [], frames: ContactPage['frames'] = []
        for (const [cell, seek] of timestamps.slice(offset, offset + columns * rows).entries()) {
          signal.throwIfAborted()
          const decoded = await runMedia(ctx, [ffmpeg, '-nostdin', '-hide_banner', '-loglevel', 'info', '-protocol_whitelist', 'file,pipe',
            '-ss', String(seek), '-copyts', '-i', source, '-map', '0:v:0', '-an', '-sn', '-dn', '-frames:v', '1',
            '-vf', `scale=w='min(${config.frameMaxDimension},iw)':h='min(${config.frameMaxDimension},ih)':force_original_aspect_ratio=decrease,showinfo`,
            '-c:v', 'png', '-f', 'image2pipe', 'pipe:1'], policy, signal, { ...limits, maxBytes: config.maxFrameBytes })
          const match = /\bpts_time:([\d.e+-]+)/.exec(decoded.diagnostic), timestamp = match ? Number(match[1]) : NaN
          if (!Number.isFinite(timestamp) || timestamp < start || timestamp >= end || !decoded.bytes.length) throw Error('Frame extraction did not return a verifiable timestamp inside the selected interval')
          const image = await ctx.attachments.saveImage({ data: decoded.bytes, mediaType: 'image/png', name: `video-detail-${timestamp}.png` })
          frames.push({ index: offset + cell + 1, cell: cell + 1, requested_seconds: seek, timestamp_seconds: timestamp, image })
          const left = (cell % columns) * tileWidth, top = Math.floor(cell / columns) * (height + labelHeight)
          const thumbnail = await sharp(decoded.bytes, { limitInputPixels: config.maxSourcePixels }).resize(tileWidth, height, { fit: 'contain', background: '#181818' }).png().toBuffer()
          overlays.push({ input: thumbnail, left, top })
          const label = `<svg width="${tileWidth}" height="${labelHeight}"><rect width="100%" height="100%" fill="#181818"/><text x="8" y="${Math.round(labelHeight * .74)}" fill="white" font-family="sans-serif" font-size="${Math.round(labelHeight * .6)}">#${offset + cell + 1} ${contactTimecode(timestamp)}</text></svg>`
          overlays.push({ input: Buffer.from(label), left, top: top + height })
        }
        signal.throwIfAborted()
        const bytes = await sharp({ create: { width, height: pageHeight, channels: 3, background: '#181818' } }).composite(overlays).png().toBuffer()
        totalBytes += bytes.length
        if (totalBytes > config.maxContactBytes) throw Error('Complete contact-sheet output exceeds maxContactBytes; reduce frame count or tile_width')
        const image = await ctx.attachments.saveImage({ data: bytes, mediaType: 'image/png', name: `video-contact-page-${pages.length + 1}.png` })
        pages.push({ page: pages.length + 1, image, frames })
      }
      if ((await ctx.fs.stat(target, signal))?.version !== info.version) throw Error('Video changed during contact-sheet creation; inspect the current source again')
      const manifest = await ctx.fs.resolve(args.manifest_path ?? `.muse/video-overviews/${randomUUID()}.json`, { cwd: policy.workspaceRoot, signal })
      if (!ctx.fs.contains(await ctx.fs.resolve(policy.workspaceRoot, { signal }), manifest)) throw Error('Contact-sheet manifest must be inside the workspace')
      const value: VideoContactSheet = { ...metadata, path: target.displayPath, source_version: info.version,
        interval: { start_seconds: start, end_seconds: end }, columns, rows, pages, manifest_path: manifest.displayPath,
        ...samplingPlan === undefined ? {} : { sampling_plan: samplingPlan },
        ...end < metadata.duration_seconds ? { next_start_seconds: end } : {} }
      const serialized = JSON.stringify(value, null, 2) + '\n'
      await ctx.fs.writeText(manifest, serialized, { kind: 'createIfAbsent' }, signal, policy)
      if (await ctx.fs.readText(manifest, signal) !== serialized) throw Error('Contact-sheet manifest readback did not match')
      signal.throwIfAborted()
      ctx.emit('fs/observed', target, { kind: 'present', version: info.version }, exec)
      return value
    }),
  })), 'video-inspect: contact sheets')
}
