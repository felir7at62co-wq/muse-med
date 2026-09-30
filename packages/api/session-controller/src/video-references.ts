/** Session-scoped, authenticated video byte streams over the composed filesystem. */
import { extname } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import { FsError } from '@deepseek-ai/dsh-fs'
import type {} from '@deepseek-ai/dsh-client-connection'
import type {} from '@deepseek-ai/dsh-session-persistence'
import { SessionId } from '@deepseek-ai/dsh-session'

/** Deployment bounds for one file, buffered window, and concurrent streams. */
export interface VideoPlaybackConfig {
  /** Largest source file served, in bytes. */
  readonly maxFileBytes: number
  /** Largest filesystem window buffered by one stream, in bytes. */
  readonly chunkBytes: number
  /** Largest number of simultaneously open response streams. */
  readonly maxStreams: number
}

/** Validated playback bounds, independent from image attachment limits. */
export const VideoPlaybackConfig: Schema<VideoPlaybackConfig> = Schema.object({
  maxFileBytes: Schema.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER).default(8 * 1024 * 1024 * 1024),
  chunkBytes: Schema.number().step(1).min(1).max(8 * 1024 * 1024).default(256 * 1024),
  maxStreams: Schema.number().step(1).min(1).max(128).default(8),
})

const VIDEO_TYPES: Readonly<Record<string, string>> = { '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime' }
const HEADERS = { 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff', 'Accept-Ranges': 'bytes' }

/** Parse a single HTTP byte range; false denotes a refused range. */
function byteRange(value: string | null, size: number): { start: number; end: number } | false {
  if (value === null) return { start: 0, end: size - 1 }
  const match = /^bytes=(\d*)-(\d*)$/.exec(value)
  if (!match || (!match[1] && !match[2]) || size === 0) return false
  if (!match[1]) {
    const suffix = Number(match[2])
    if (!Number.isSafeInteger(suffix) || suffix <= 0) return false
    return { start: Math.max(0, size - suffix), end: size - 1 }
  }
  const start = Number(match[1]), end = match[2] ? Number(match[2]) : size - 1
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start >= size || end < start) return false
  return { start, end: Math.min(end, size - 1) }
}

/** Connection authentication precedes this contribution; a Session and its workspace scope every read. */
export const SessionVideoReferences = {
  name: 'session-video-references',
  inject: ['connection', 'fs', 'sessionPersistence'],
  Config: VideoPlaybackConfig,
  /**
   * Register bounded video streams; disposal cancels and awaits metadata lookups and byte reads.
   * @param ctx - Authenticated connection, Session persistence and filesystem.
   * @param config - Validated per-deployment playback limits.
   */
  apply(ctx: Context, config: VideoPlaybackConfig): void {
    const live = new Set<AbortController>()
    const reads = new Set<Promise<void>>()
    const requests = new Set<Promise<void>>()
    const lifetime = new AbortController()
    let disposed = false
    ctx.effect(() => ctx.connection.fetch.register({
      path: '/api/video', methods: ['GET', 'HEAD'], requestBody: 'buffered',
      fetch: async (request) => {
        const completion = Promise.withResolvers<void>()
        requests.add(completion.promise)
        const requestSignal = AbortSignal.any([request.signal, lifetime.signal])
        const cancelled = (): boolean => requestSignal.aborted
        try {
          const fail = (status: number, message: string, extra: Record<string, string> = {}): Response =>
            new Response(request.method === 'HEAD' ? null : message, { status, headers: { ...HEADERS, ...extra } })
          if (disposed || cancelled()) return fail(499, 'request cancelled')
          const url = new URL(request.url), path = url.searchParams.get('path'), id = url.searchParams.get('sessionId')
          if (!id || id.length > 256 || !path || path.includes('\0')) return fail(400, 'sessionId and video path required')
          try {
            const session = await ctx.sessionPersistence.stat(SessionId(id), { signal: requestSignal })
            if (cancelled()) return fail(499, 'request cancelled')
            if (!session) return fail(404, 'session not found')
            const cwd = session.header.cwd
            if (!cwd) return fail(403, 'session has no workspace')
            const root = await ctx.fs.resolve(cwd, { signal: requestSignal })
            const target = await ctx.fs.resolve(path, { cwd, signal: requestSignal })
            if (!ctx.fs.contains(root, target)) return fail(403, 'video is outside this workspace')
            const info = await ctx.fs.stat(target, requestSignal)
            if (cancelled()) return fail(499, 'request cancelled')
            if (!info) return fail(404, 'not found')
            if (url.searchParams.has('version') && url.searchParams.get('version') !== info.version) {
              return fail(409, 'video changed; reload it')
            }
            if (info.type !== 'file') return fail(403, 'not a regular file')
            const type = VIDEO_TYPES[extname(target.displayPath).toLowerCase()]
            if (!type) return fail(415, 'unsupported video container')
            const size = info.size
            if (size === undefined || !Number.isSafeInteger(size) || size < 0) return fail(500, 'video size unavailable')
            if (size > config.maxFileBytes) return fail(413, 'video exceeds byte limit')
            // Without a strong content validator, If-Range requests receive a fresh complete response.
            const rangeHeader = request.headers.has('if-range') ? null : request.headers.get('range')
            const range = byteRange(rangeHeader, size)
            if (range === false) return fail(416, 'range not satisfiable', { 'Content-Range': `bytes */${size}` })
            const length = Math.max(0, range.end - range.start + 1)
            const headers = { ...HEADERS, 'Content-Type': type, 'Content-Length': String(length),
              ...rangeHeader === null ? {} : { 'Content-Range': `bytes ${range.start}-${range.end}/${size}` },
            }
            const status = rangeHeader === null ? 200 : 206
            if (request.method === 'HEAD') return new Response(null, { status, headers })
            if (live.size >= config.maxStreams) return fail(429, 'video playback is busy', { 'Retry-After': '1' })
            const owner = new AbortController()
            live.add(owner)
            const signal = AbortSignal.any([owner.signal, requestSignal])
            let offset = range.start, ended = false
            let pendingRead: Promise<void> | undefined
            let streamController: ReadableStreamDefaultController<Uint8Array> | undefined
            const release = (): void => {
              ended = true
              if (!pendingRead) live.delete(owner)
              signal.removeEventListener('abort', abort)
            }
            const abort = (): void => {
              if (ended) return
              release()
              streamController?.error(signal.reason)
            }
            signal.addEventListener('abort', abort, { once: true })
            const body = new ReadableStream<Uint8Array>({
              start(controller) { streamController = controller; if (signal.aborted) abort() },
              pull(controller) {
                const reading = (async () => {
                  if (ended) return
                  try {
                    signal.throwIfAborted()
                    if (offset > range.end) { release(); controller.close(); return }
                    const before = await ctx.fs.stat(target, signal)
                    if (before?.version !== info.version) throw new Error('Video changed during playback; reload it')
                    const readLength = Math.min(config.chunkBytes, range.end - offset + 1)
                    const bytes = await ctx.fs.readByteRange(target, { offset, length: readLength }, signal)
                    signal.throwIfAborted()
                    if (!bytes.length || (await ctx.fs.stat(target, signal))?.version !== info.version) {
                      throw new Error('Video changed during playback; reload it')
                    }
                    offset += bytes.length
                    controller.enqueue(bytes)
                  } catch (error) {
                    if (signal.aborted) abort()
                    else { release(); controller.error(error) }
                  }
                })()
                pendingRead = reading
                reads.add(reading)
                void reading.finally(() => {
                  pendingRead = undefined
                  reads.delete(reading)
                  if (ended) live.delete(owner)
                })
                return reading
              },
              async cancel() { release(); owner.abort(); await pendingRead },
            })
            return new Response(body, { status, headers })
          } catch (error) {
            if (cancelled()) return fail(499, 'request cancelled')
            if (!(error instanceof FsError)) throw error
            const statuses: Partial<Record<FsError['code'], number>> = { FS_NOT_FOUND: 404, FS_NOT_REGULAR_FILE: 403,
              FS_PERMISSION_DENIED: 403, FS_SANDBOX_DENIED: 403, FS_TOO_LARGE: 413, FS_ABORTED: 499 }
            return fail(statuses[error.code] ?? 500, error.code)
          }
        } finally { requests.delete(completion.promise); completion.resolve() }
      },
    }), 'session-controller: /api/video')
    ctx.effect(() => async () => {
      disposed = true
      lifetime.abort(new Error('Video playback disposed'))
      for (const owner of live) owner.abort(new Error('Video playback disposed'))
      await Promise.all([...requests, ...reads])
    })
  },
}
