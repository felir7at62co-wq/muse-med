/** Session-owned video discovery, bounded playback and visual cut detection. */
import { Service, type Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import { AttachmentId, type FileAttachmentRef } from '@deepseek-ai/dsh-attachment'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { FsTarget, FsVersion } from '@deepseek-ai/dsh-fs'
import { downloadMedia } from '@deepseek-ai/dsh-jubian-api'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-query'
import type { ProjectionHandle } from '@deepseek-ai/dsh-session-projection'
import type {} from '@deepseek-ai/dsh-sandbox-policy'
import type {} from '@deepseek-ai/dsh-client-connection'
import { currentSessionMessageProjections } from '@deepseek-ai/dsh-session-format-catalog/message-projections'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import { command, facts, shotRanges } from './media.ts'
import { digest, foldVideoSources, publicJubianVideo, sourceStateSchema, type VideoCandidate, type VideoSourceState } from './sources.ts'
import type { SessionVideoAnalysis, SessionVideoInventory, SessionVideoSource, SessionVideoSourceId } from './types.ts'

export type * from './types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context { /** Video sources and cut ranges owned by one conversation. */ sessionVideo: SessionVideo }
}

/** Deployment-controlled subprocess, source, cache and playback limits. */
export interface Config {
  /** FFmpeg executable name or path in the configured execution world. */
  readonly ffmpegPath: string
  /** FFprobe executable name or path in the configured execution world. */
  readonly ffprobePath: string
  /** Maximum retained sources and unsettled supported calls per Session. */
  readonly maxSources: number
  /** Maximum UTF-8 bytes parsed from one structured tool-result text block. */
  readonly maxResultBytes: number
  /** Maximum local input or downloaded media bytes accepted for processing. */
  readonly maxSourceBytes: number
  /** Maximum probed container duration accepted for detection, in seconds. */
  readonly maxDurationSeconds: number
  /** Maximum video-track width multiplied by height accepted for detection. */
  readonly maxSourcePixels: number
  /** FFmpeg scene-change score above which a frame becomes a cut candidate. */
  readonly sceneThreshold: number
  /** Scaled video width used for scene-change analysis, in pixels. */
  readonly analysisWidth: number
  /** Minimum separation between retained interior cuts and endpoints, in seconds. */
  readonly minShotSeconds: number
  /** Maximum complete shot count; larger results fail instead of truncating. */
  readonly maxShots: number
  /** Deadline for each probe or detection subprocess, in milliseconds. */
  readonly commandTimeoutMs: number
  /** Deadline for a verified provider media download, in milliseconds. */
  readonly downloadTimeoutMs: number
  /** Grace period before forced subprocess termination, in milliseconds. */
  readonly graceMs: number
  /** Maximum complete stdout bytes and retained stderr bytes per subprocess. */
  readonly maxOutputBytes: number
  /** Maximum simultaneous detection operations owned by this plugin. */
  readonly maxConcurrent: number
  /** Maximum process-local successful analyses and downloaded-source lookup entries. */
  readonly maxCachedAnalyses: number
  /** Maximum bytes read for one playback stream chunk. */
  readonly playbackChunkBytes: number
  /** Maximum simultaneously active local playback streams. */
  readonly maxPlaybackStreams: number
}

interface ResolvedSource {
  readonly source: SessionVideoSource
  readonly target: FsTarget | null
  readonly fileVersion: FsVersion | null
}

function trimCache<T>(cache: Map<string, T>, maximum: number): void {
  for (const oldest of cache.keys()) {
    if (cache.size <= maximum) return
    cache.delete(oldest)
  }
}

/** Native Host plugin; Remote methods take only Session-bound source identities. */
export default class SessionVideo extends TypertRemoteService {
  static inject = ['sessions', 'sessionQuery', 'sessionProjections', 'fs', 'attachments', 'subprocess', 'sandboxPolicy', 'connection']
  static Config: Schema<Config> = Schema.object({
    ffmpegPath: Schema.string().default('ffmpeg'), ffprobePath: Schema.string().default('ffprobe'),
    maxSources: Schema.number().step(1).min(1).max(10000).default(500),
    maxResultBytes: Schema.number().step(1).min(1024).default(4 * 1024 * 1024),
    maxSourceBytes: Schema.number().step(1).min(1).max(512 * 1024 * 1024).default(512 * 1024 * 1024),
    maxDurationSeconds: Schema.number().min(1).default(3600),
    maxSourcePixels: Schema.number().step(1).min(1).default(7680 * 4320),
    sceneThreshold: Schema.number().min(0.001).max(1).default(0.3),
    analysisWidth: Schema.number().step(1).min(16).max(1920).default(320),
    minShotSeconds: Schema.number().min(0.001).default(0.08), maxShots: Schema.number().step(1).min(1).max(10000).default(500),
    commandTimeoutMs: Schema.number().step(1).min(1).default(180000),
    downloadTimeoutMs: Schema.number().step(1).min(1).max(300000).default(60000),
    graceMs: Schema.number().step(1).min(1).default(1000), maxOutputBytes: Schema.number().step(1).min(1024).default(8 * 1024 * 1024),
    maxConcurrent: Schema.number().step(1).min(1).max(16).default(2),
    maxCachedAnalyses: Schema.number().step(1).min(1).default(128),
    playbackChunkBytes: Schema.number().step(1).min(1).max(8 * 1024 * 1024).default(256 * 1024),
    maxPlaybackStreams: Schema.number().step(1).min(1).max(128).default(8),
  })

  private sources!: ProjectionHandle<VideoSourceState>
  private readonly lifetime = new AbortController()
  private readonly operations = new Set<Promise<unknown>>()
  private readonly reads = new Set<Promise<void>>()
  private readonly streams = new Set<AbortController>()
  private readonly analyses = new Map<string, { value: SessionVideoAnalysis; fileVersion: FsVersion }>()
  private readonly downloads = new Map<string, { version: string; attachment: FileAttachmentRef }>()
  private detecting = 0

  /**
   * Bind the Remote service and authenticated binary route to the plugin lifetime.
   * @param ctx - Session, filesystem, attachment and subprocess services.
   * @param config - Validated deployment policy.
   */
  constructor(ctx: Context, private readonly config: Config) {
    super(ctx, 'sessionVideo')
    ctx.effect(() => ctx.connection.fetch.register({ path: '/api/session-video', methods: ['GET', 'HEAD'], requestBody: 'buffered',
      fetch: request => this.tracked(() => this.playback(request)) }), 'sessionVideo: authenticated playback')
    ctx.effect(() => async () => {
      this.lifetime.abort(new Error('Session video plugin stopped'))
      for (const stream of this.streams) stream.abort()
      await Promise.allSettled([...this.operations, ...this.reads])
      this.analyses.clear()
      this.downloads.clear()
    }, 'sessionVideo: cancel and drain operations')
  }

  protected async [Service.init](): Promise<void> {
    // Fold limits affect persisted state; each configuration must replay incompatible checkpoints.
    const stateVersion = Number.parseInt(digest(JSON.stringify([1, this.config.maxSources, this.config.maxResultBytes])).slice(0, 12), 16)
    this.sources = await this.ctx.sessionProjections.register({ key: 'sessionVideoSources', stateVersion,
      stateSchema: sourceStateSchema, init: () => ({ sources: [], calls: [], complete: true, issues: [] }),
      apply: (state, event) => foldVideoSources(state, event, this.config) })
  }

  /**
   * List only video sources explicitly recorded by this conversation.
   * @param sessionId - Authorized Session identity.
   * @param signal - Caller cancellation.
   * @returns Versioned local or provider sources and explicit coverage diagnostics.
   */
  @Remote({ resources: { session: sessionId => sessionId } })
  async list(sessionId: SessionId, signal: AbortSignal): Promise<SessionVideoInventory> {
    return this.tracked(async () => {
      const operation = AbortSignal.any([signal, this.lifetime.signal])
      const session = await this.session(sessionId, operation)
      const state = this.sources.stateOf(session)
      const sources: SessionVideoSource[] = []
      for (const candidate of state.sources) {
        operation.throwIfAborted()
        sources.push((await this.resolve(session, candidate, operation)).source)
      }
      return { sessionId, sources, complete: state.complete, issues: [...state.issues] }
    })
  }

  /**
   * Detect visual cuts in one exact source version without generating or replacing media.
   * @param sessionId - Authorized Session identity.
   * @param sourceId - Identity returned by this Session's inventory.
   * @param sourceVersion - Inventory version the user selected.
   * @param signal - Cancels download, probe and cut detection.
   * @returns Complete original-video intervals, or a failed result with no invented shots.
   */
  @Remote({ resources: { session: sessionId => sessionId } })
  async detect(sessionId: SessionId, sourceId: SessionVideoSourceId, sourceVersion: string,
    signal: AbortSignal): Promise<SessionVideoAnalysis> {
    return this.tracked(async () => {
      const operation = AbortSignal.any([signal, this.lifetime.signal])
      operation.throwIfAborted()
      const failed = (issue: string): SessionVideoAnalysis => ({ sourceId, sourceVersion, state: 'failed', durationSeconds: null,
        width: null, height: null, shots: [], method: 'ffmpeg-scene', threshold: this.config.sceneThreshold, issue })
      if (this.detecting >= this.config.maxConcurrent) return failed('Video detection is busy; retry after the current operation')
      this.detecting++
      try {
        const session = await this.session(sessionId, operation)
        const candidate = this.candidate(session, sourceId)
        let source = await this.resolve(session, candidate, operation)
        if (source.source.version !== sourceVersion) return failed('Video source changed; reload the video inventory')
        const cacheKey = `${sessionId}:${sourceId}:${sourceVersion}`
        const cached = this.analyses.get(cacheKey)
        if (cached !== undefined && source.fileVersion === cached.fileVersion) return structuredClone(cached.value)
        if (source.target === null && candidate.remoteUrl !== null && publicJubianVideo(candidate.remoteUrl)) {
          const downloaded = await downloadMedia(candidate.remoteUrl, { kind: 'video', maxBytes: this.config.maxSourceBytes,
            timeoutMs: this.config.downloadTimeoutMs, signal: operation })
          operation.throwIfAborted()
          const attachment = await this.ctx.attachments.saveFile({ data: downloaded.bytes, name: `session-video-${sourceId}.mp4` })
          operation.throwIfAborted()
          this.downloads.set(`${sessionId}:${sourceId}`, { version: sourceVersion, attachment })
          trimCache(this.downloads, this.config.maxCachedAnalyses)
          source = await this.resolve(session, candidate, operation)
        }
        if (source.target === null || source.fileVersion === null) return failed(source.source.issue ?? 'Video is not available as a local source')
        const policy = this.ctx.sandboxPolicy.resolve({ session })
        const processPath = this.ctx.fs.processPath(source.target)
        const ffprobe = await this.ctx.subprocess.resolveExecutable(this.config.ffprobePath, undefined, operation)
        const metadata = facts(await command(this.ctx, [ffprobe, '-v', 'error', '-protocol_whitelist', 'file,pipe',
          '-show_entries', 'format=duration:stream=codec_type,width,height', '-of', 'json', processPath], policy, operation, this.config))
        if (metadata.durationSeconds > this.config.maxDurationSeconds || metadata.width * metadata.height > this.config.maxSourcePixels) {
          return failed('Video duration or dimensions exceed the configured detection limit')
        }
        const ffmpeg = await this.ctx.subprocess.resolveExecutable(this.config.ffmpegPath, undefined, operation)
        const cuts = await command(this.ctx, [ffmpeg, '-nostdin', '-hide_banner', '-v', 'error', '-protocol_whitelist', 'file,pipe',
          '-i', processPath, '-map', '0:v:0', '-an', '-sn', '-dn', '-vf',
          `scale=${this.config.analysisWidth}:-2,select='gt(scene,${this.config.sceneThreshold})',metadata=print:file=-`, '-f', 'null', '-'],
        policy, operation, this.config)
        if ((await this.ctx.fs.stat(source.target, operation))?.version !== source.fileVersion) return failed('Video changed during detection; reload it')
        const result: SessionVideoAnalysis = { sourceId, sourceVersion, state: 'ready', ...metadata,
          shots: shotRanges(cuts, metadata.durationSeconds, sourceId, sourceVersion, this.config.minShotSeconds, this.config.maxShots),
          method: 'ffmpeg-scene', threshold: this.config.sceneThreshold, issue: null }
        operation.throwIfAborted()
        this.analyses.set(cacheKey, { value: result, fileVersion: source.fileVersion })
        trimCache(this.analyses, this.config.maxCachedAnalyses)
        return structuredClone(result)
      } catch (error) {
        operation.throwIfAborted()
        return failed(error instanceof Error ? error.message : 'Video detection failed')
      } finally { this.detecting-- }
    })
  }

  private async session(id: SessionId, signal: AbortSignal): Promise<Session> {
    signal.throwIfAborted()
    const live = this.ctx.sessions.get(id)
    if (live !== undefined) return live
    const stored = await this.ctx.sessionQuery.readSession(id)
    signal.throwIfAborted()
    return Session.create(id, stored.events, stored.session, stored.inheritedEventCount, currentSessionMessageProjections)
  }

  private candidate(session: Session, id: SessionVideoSourceId): VideoCandidate {
    const found = this.sources.stateOf(session).sources.find(source => digest(`${session.id}:${source.key}`) === id)
    if (!found) throw Error('Video source is not recorded by this conversation')
    return found
  }

  private async resolve(session: Session, candidate: VideoCandidate, signal: AbortSignal): Promise<ResolvedSource> {
    const id = brandString<SessionVideoSourceId>(digest(`${session.id}:${candidate.key}`))
    let source: SessionVideoSource = { id, label: candidate.label, origin: candidate.origin, path: candidate.path,
      eventSeq: candidate.eventSeq, presentedIndex: candidate.presentedIndex, callId: candidate.callId, remoteUrl: candidate.remoteUrl,
      status: 'missing', version: null, playbackUrl: null, issue: null }
    let path = candidate.path
    if (candidate.attachment !== null) {
      const hostPath = this.ctx.attachments.fileHostPath({ ...candidate.attachment,
        attachmentId: AttachmentId(candidate.attachment.attachmentId) })
      if (hostPath !== undefined) path = this.ctx.fs.processPathFromHostPath(hostPath) ?? null
    }
    if (candidate.remoteUrl !== null) {
      source = { ...source, version: `url:${digest(candidate.remoteUrl)}` }
      if (!publicJubianVideo(candidate.remoteUrl)) return { source: { ...source, status: 'unsupported', issue: 'Provider video origin is not supported' }, target: null, fileVersion: null }
      source = { ...source, status: 'remote-only', playbackUrl: candidate.remoteUrl }
      const downloaded = this.downloads.get(`${session.id}:${id}`)
      if (downloaded?.version === source.version) {
        const hostPath = this.ctx.attachments.fileHostPath(downloaded.attachment)
        path = hostPath === undefined ? null : this.ctx.fs.processPathFromHostPath(hostPath) ?? null
      }
      if (path === null) return { source, target: null, fileVersion: null }
    }
    if (path === null) return { source: { ...source, issue: 'Stored video is unavailable in this filesystem' }, target: null, fileVersion: null }
    try {
      const target = await this.ctx.fs.resolve(path, { cwd: session.header.cwd ?? this.ctx.sandboxPolicy.workspaceRoot, signal })
      const info = await this.ctx.fs.stat(target, signal)
      if (info?.type !== 'file') return { source: { ...source, status: 'missing', issue: 'Recorded video file is missing' }, target: null, fileVersion: null }
      if (info.size === undefined || info.size > this.config.maxSourceBytes) return { source: { ...source, status: 'unsupported', issue: 'Recorded video exceeds the configured byte limit' }, target: null, fileVersion: null }
      const version = source.version ?? info.version
      const query = new URLSearchParams({ sessionId: session.id, sourceId: id, version })
      return { source: { ...source, path: target.displayPath, status: 'local', version, playbackUrl: `api/session-video?${query}`, issue: null }, target, fileVersion: info.version }
    } catch (error) {
      signal.throwIfAborted()
      return { source: { ...source, issue: error instanceof Error ? error.message : 'Recorded video is unreadable' }, target: null, fileVersion: null }
    }
  }

  private tracked<T>(run: () => Promise<T>): Promise<T> {
    const pending = run()
    this.operations.add(pending)
    void pending.finally(() => this.operations.delete(pending)).catch(() => {})
    return pending
  }

  private async playback(request: Request): Promise<Response> {
    const signal = AbortSignal.any([request.signal, this.lifetime.signal])
    const headers = { 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff', 'Accept-Ranges': 'bytes' }
    const fail = (status: number, message: string, extra: Record<string, string> = {}): Response => new Response(request.method === 'HEAD' ? null : message, { status, headers: { ...headers, ...extra } })
    try {
      const query = new URL(request.url).searchParams
      const rawId = query.get('sessionId'), rawSource = query.get('sourceId'), version = query.get('version')
      if (!rawId || !rawSource || !/^[a-f0-9]{64}$/u.test(rawSource) || !version || query.has('path') || query.has('url')
        || ['sessionId', 'sourceId', 'version'].some(key => query.getAll(key).length !== 1)) return fail(400, 'Session, recorded source and version required')
      const session = await this.session(SessionId(rawId), signal)
      const resolved = await this.resolve(session, this.candidate(session, brandString<SessionVideoSourceId>(rawSource)), signal)
      if (resolved.source.version !== version) return fail(409, 'Video source changed; reload it')
      if (resolved.target === null || resolved.fileVersion === null) return fail(404, 'Local video unavailable')
      const target = resolved.target, fileVersion = resolved.fileVersion
      const info = await this.ctx.fs.stat(target, signal)
      if (info?.version !== fileVersion) return fail(409, 'Video source changed; reload it')
      const size = info.size
      if (size === undefined || !Number.isSafeInteger(size) || size <= 0) return fail(404, 'Video has no readable bytes')
      const range = request.headers.get('range')
      let start = 0, end = size - 1
      if (range !== null) {
        const match = /^bytes=(\d*)-(\d*)$/.exec(range)
        if (!match || (!match[1] && !match[2])) return fail(416, 'Invalid video range', { 'Content-Range': `bytes */${size}` })
        if (match[1]) { start = Number(match[1]); end = match[2] ? Math.min(Number(match[2]), end) : end }
        else start = Math.max(0, size - Number(match[2]))
        if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start > end || start >= size) return fail(416, 'Invalid video range', { 'Content-Range': `bytes */${size}` })
      }
      const type = target.displayPath.toLowerCase().endsWith('.webm') ? 'video/webm' : target.displayPath.toLowerCase().endsWith('.mov') ? 'video/quicktime' : 'video/mp4'
      const responseHeaders = { ...headers, 'Content-Type': type, 'Content-Length': String(end - start + 1),
        ...range === null ? {} : { 'Content-Range': `bytes ${start}-${end}/${size}` } }
      const status = range === null ? 200 : 206
      if (request.method === 'HEAD') return new Response(null, { status, headers: responseHeaders })
      if (this.streams.size >= this.config.maxPlaybackStreams) return fail(429, 'Video playback is busy')
      const owner = new AbortController()
      this.streams.add(owner)
      const operation = AbortSignal.any([signal, owner.signal])
      let offset = start, pending: Promise<void> | undefined, closed = false
      let controller: ReadableStreamDefaultController<Uint8Array>
      const release = (): void => { closed = true; if (pending === undefined) this.streams.delete(owner); operation.removeEventListener('abort', abort) }
      const abort = (): void => { if (!closed) { release(); controller.error(operation.reason) } }
      const body = new ReadableStream<Uint8Array>({
        start(value) { controller = value; operation.addEventListener('abort', abort, { once: true }); if (operation.aborted) abort() },
        pull: (output) => {
          const reading = (async () => {
            try {
              operation.throwIfAborted()
              if (offset > end) { release(); output.close(); return }
              if ((await this.ctx.fs.stat(target, operation))?.version !== fileVersion) throw Error('Video changed during playback')
              const bytes = await this.ctx.fs.readByteRange(target,
                { offset, length: Math.min(this.config.playbackChunkBytes, end - offset + 1) }, operation)
              if (bytes.length === 0 || (await this.ctx.fs.stat(target, operation))?.version !== fileVersion) throw Error('Video changed during playback')
              operation.throwIfAborted()
              offset += bytes.length
              output.enqueue(bytes)
            } catch (error) { if (!closed) { release(); output.error(error) } }
          })()
          pending = reading
          this.reads.add(reading)
          void reading.finally(() => { pending = undefined; this.reads.delete(reading); if (closed) this.streams.delete(owner) })
          return reading
        },
        cancel: async () => { release(); owner.abort(); await pending },
      })
      return new Response(body, { status, headers: responseHeaders })
    } catch (error) {
      return fail(signal.aborted ? 499 : 404, error instanceof Error ? error.message : 'Video unavailable')
    }
  }
}
