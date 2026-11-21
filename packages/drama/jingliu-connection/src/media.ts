/**
 * Jingliu media in object storage: batch resolution of stored addresses, direct downloads into indexed local folders,
 * and presigned uploads. The Host never holds storage keys; it only follows short-lived links the studio signs.
 * @module
 */
import { createHash, type Hash } from 'node:crypto'
import { createReadStream, createWriteStream, openAsBlob } from 'node:fs'
import { link, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, extname, join } from 'node:path'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { withFileLock, writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import { HarnessError } from '@deepseek-ai/dsh-error'
import { isRecord, WorkbenchHttpError } from '@deepseek-ai/dsh-workbench-connection'
import type { WorkbenchSession } from '@deepseek-ai/dsh-workbench-connection'
import { mediaUrl } from './http.ts'

// The studio answers at most this many addresses per resolve request.
const RESOLVE_BATCH = 200
const INDEX_FILE = '.muse-media.json'
const REDIRECTS = new Set([301, 302, 303, 307, 308])
// Top-level folders of the studio's media root that hold files a client may read.
const MEDIA_DIRS = new Set(['generated', 'uploads', 'outputs', 'character-references', 'exports', 'bgm-library', 'sfx-library', 'voice-library'])
// Media types by file extension: what an upload declares, and the type of a download whose server reported none.
const UPLOAD_TYPES: Readonly<Record<string, string>> = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif', '.avif': 'image/avif',
  '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.m4a': 'audio/mp4', '.aac': 'audio/aac', '.ogg': 'audio/ogg', '.flac': 'audio/flac',
  '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.mov': 'video/quicktime', '.webm': 'video/webm',
}
// Headers a presigned upload may not set: the request carries no credential of the Host or the user.
const FORBIDDEN_UPLOAD_HEADERS = /^(?:authorization|cookie|host|origin|proxy-.*|content-length|transfer-encoding|connection)$/iu

/** Limits and trusted storage hosts for media transfers. */
export interface MediaConfig {
  /** Exact `host[:port]` values of presigned links the Host may read from or upload to; HTTPS, or HTTP on loopback. */
  readonly hosts: readonly string[]
  /** Simultaneous downloads across all folders. */
  readonly downloads: number
  /** Bytes of viewed files one folder keeps before the least recently used ones are removed; kept files never count. */
  readonly cacheBytes: number
  /** Largest file accepted when the studio does not state its size. */
  readonly maxBytes: number
  /** Maximum duration of one download or upload, in milliseconds. */
  readonly timeoutMs: number
  /** Receives one line when the studio links to a host outside `hosts` and those files are read through the Host instead. */
  readonly warn?: ((message: string) => void) | undefined
}

/** How one stored address can be read. */
export type MediaSource =
  /** A presigned object-storage link with the stored object's size and ETag. */
  | { readonly kind: 'object'; readonly path: string; readonly url: URL; readonly size: number; readonly etag: string; readonly contentType: string }
  /** Read through the Host's studio session: the studio still has the file, or does not offer resolution. */
  | { readonly kind: 'host'; readonly path: string }
  /** The studio has no such file. */
  | { readonly kind: 'missing'; readonly path: string; readonly reason: string }

/** One file of a local media folder. */
export interface LocalMedia {
  /** Stored address, `/fw/media/<dir>/<name>`. */
  readonly path: string
  /** Absolute file on this computer, `<folder>/<dir>/<name>`. */
  readonly file: string
  readonly size: number
  /** Media type reported by the studio or storage, lower case without parameters; empty when none was reported. */
  readonly contentType: string
}

/** A file stored by the studio after an upload. */
export interface UploadedMedia {
  /** Permanent address of the uploaded file, `/fw/media/uploads/<id>.<ext>`. */
  readonly path: string
  readonly size: number
}

/** How a batch of downloads treats the folder index. */
export interface FileOptions {
  /** Mark the files as used by a tool or draft; kept files are never removed by cache eviction. */
  readonly keep: boolean
  /** After the batch, remove least recently used files that are not kept until the folder is within `cacheBytes`. */
  readonly evict: boolean
  readonly signal: AbortSignal
}

interface IndexEntry { size: number; etag: string; type: string; used: number; keep: boolean }
interface MediaIndex { version: 1; files: Record<string, IndexEntry> }
interface Downloaded { local: LocalMedia; etag: string }

const invalidMedia = () => new HarnessError('素材地址不属于当前镜流媒体库。', 'JINGLIU_INVALID_MEDIA')
const invalidResult = () => new HarnessError('镜流返回的素材信息无效。', 'JINGLIU_MEDIA_INVALID_RESULT')
const unavailable = (cause?: unknown) => new HarnessError('镜流素材暂时无法读取，请稍后重试。', 'JINGLIU_MEDIA_UNAVAILABLE',
  cause === undefined ? undefined : { cause })
const notFound = (path: string) => new HarnessError('镜流找不到这个素材：' + path, 'JINGLIU_MEDIA_NOT_FOUND')
const damaged = () => new HarnessError('下载的镜流素材与云端记录不一致，请重试。', 'JINGLIU_MEDIA_INTEGRITY')
const leaf = (v: string) => !!v && v.length <= 180 && !/[\\/:*?"<>|\x00-\x1f]/u.test(v) && !/[. ]$/u.test(v)
  && !/^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/iu.test(v)

/**
 * Normalize a stored address.
 * @param value - `/fw/media/...` or `/fwp/media/...` address from a studio result.
 * @returns The `/fw/media/...` form and its path segments below the media root: a known media folder and one or two
 * names, each a valid file name on every platform that is neither hidden nor a partial download.
 */
export function mediaPath(value: string): { path: string; parts: string[] } {
  mediaUrl('https://studio.invalid', value)
  const parts = value.replace(/^\/fwp?\/media\//u, '').split('/')
  if (parts.length < 2 || parts.length > 3 || !MEDIA_DIRS.has(parts[0] ?? '') || !parts.every(leaf)
    || parts.some(part => part.startsWith('.') || /\.part(?:\.json)?$/iu.test(part))) throw invalidMedia()
  return { path: '/fw/media/' + parts.join('/'), parts }
}

/**
 * The local media folder of one production in a workspace.
 * @param workspace - Absolute workspace directory of the conversation.
 * @param projectId - Studio project ID.
 * @returns `<workspace>/jingliu/<projectId>`.
 */
export function projectMediaFolder(workspace: string, projectId: string): string {
  if (!/^[a-zA-Z0-9_-]{1,128}$/u.test(projectId)) throw new HarnessError('镜流项目编号无效。', 'JINGLIU_INVALID_PROJECT')
  return join(workspace, 'jingliu', projectId)
}

/**
 * Accept a link only on a configured storage host.
 * @param value - Link from the studio.
 * @param hosts - Trusted `host[:port]` values.
 * @param code - Error code of a refused link.
 * @returns The parsed link.
 */
function trusted(value: unknown, hosts: readonly string[], code: string): URL {
  const refused = () => new HarnessError('镜流素材链接不在允许的存储地址内。', code)
  if (typeof value !== 'string') throw refused()
  let url: URL
  try { url = new URL(value) } catch (error) { throw new HarnessError('镜流素材链接不在允许的存储地址内。', code, { cause: error }) }
  const loopback = url.protocol === 'http:' && ['127.0.0.1', '[::1]'].includes(url.hostname)
  if ((url.protocol !== 'https:' && !loopback) || url.username || url.password || url.hash || !hosts.includes(url.host)) throw refused()
  return url
}

const etagOf = (value: string | null) => (value ?? '').replace(/^W\//u, '').replaceAll('"', '').trim()
const typeOf = (value: string | null) => (value ?? '').split(';')[0]?.trim().toLowerCase() ?? ''
const typeOfName = (path: string) => UPLOAD_TYPES[extname(path).toLowerCase()] ?? ''

/**
 * The media type of a download: the type the server reported, unless it reported none or only
 * `application/octet-stream`, as object storage does for an object stored without a type.
 * @param reported - Content-Type of the response.
 * @param known - Type the studio resolved for the file, if any; otherwise the type of the file extension is used.
 * @param path - Stored address.
 * @returns A lower-case media type without parameters, or an empty string.
 */
function mediaType(reported: string | null, known: string, path: string): string {
  const type = typeOf(reported)
  return type && type !== 'application/octet-stream' ? type : known || typeOfName(path) || type
}

// A response whose Content-Type is replaced by `mediaType` when the server reported none.
function typed(response: Response, known: string, path: string): Response {
  const type = mediaType(response.headers.get('content-type'), known, path)
  if (!type || type === typeOf(response.headers.get('content-type'))) return response
  const headers = new Headers(response.headers)
  headers.set('content-type', type)
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers })
}

// One resolve item; a link to a host outside `hosts` is read through the Host instead and reported in `refused`.
function parseSource(item: unknown, hosts: readonly string[], refused: string[]): MediaSource | undefined {
  if (!isRecord(item) || typeof item.path !== 'string') return undefined
  const { path } = mediaPath(item.path)
  // A file outside the storage-managed folders, such as `outputs/`, is still served by the studio itself.
  if (item.local === true || item.error === 'not_in_tos') return { kind: 'host', path }
  if (typeof item.error === 'string') return { kind: 'missing', path, reason: item.error }
  if (typeof item.size !== 'number' || !Number.isSafeInteger(item.size) || item.size < 0 || typeof item.etag !== 'string') return undefined
  const contentType = typeof item.content_type === 'string' ? typeOf(item.content_type) : ''
  let url: URL
  try { url = trusted(item.url, hosts, 'JINGLIU_MEDIA_HOST_REFUSED') } catch (_error) {
    let host = 'an invalid link'
    try { host = new URL(String(item.url)).host || host } catch (_invalid) { /* The link is reported without its host. */ }
    refused.push(host)
    return { kind: 'host', path }
  }
  return { kind: 'object', path, url, size: item.size, etag: etagOf(item.etag), contentType }
}

function parseIndex(value: unknown): MediaIndex {
  const index: MediaIndex = { version: 1, files: {} }
  if (!isRecord(value) || value.version !== 1 || !isRecord(value.files)) return index
  for (const [path, entry] of Object.entries(value.files)) {
    if (!isRecord(entry) || typeof entry.size !== 'number' || !Number.isSafeInteger(entry.size) || entry.size < 0 || typeof entry.etag !== 'string'
      || typeof entry.type !== 'string' || typeof entry.used !== 'number' || typeof entry.keep !== 'boolean') continue
    try { if (mediaPath(path).path !== path) continue } catch (_error) { continue /* An address this version cannot store is dropped. */ }
    index.files[path] = { size: entry.size, etag: entry.etag, type: entry.type, used: entry.used, keep: entry.keep }
  }
  return index
}

async function sizeOf(file: string): Promise<number | undefined> {
  try { return (await stat(file)).size }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error }
}

/** Resolves, downloads and uploads Jingliu media for one connection. */
export class JingliuMedia {
  private readonly unsupported = new WeakSet<WorkbenchSession>()
  private readonly running = new Map<string, Promise<Downloaded>>()
  private readonly waiting: (() => void)[] = []
  private active = 0

  /** @param config - Trusted storage hosts and transfer limits. */
  constructor(private readonly config: MediaConfig) {}

  /**
   * Ask the studio how to read stored addresses, in batches.
   * A studio without the resolve route answers 404; every address is then read through the Host for this session.
   * @param session - Verified studio session.
   * @param paths - Stored addresses.
   * @param signal - Cancellation.
   * @returns One source per normalized address.
   */
  async resolve(session: WorkbenchSession, paths: readonly string[], signal: AbortSignal): Promise<Map<string, MediaSource>> {
    const wanted = [...new Set(paths.map(p => mediaPath(p).path))]
    const sources = new Map<string, MediaSource>()
    const viaHost = () => { for (const path of wanted) if (!sources.has(path)) sources.set(path, { kind: 'host', path }) }
    if (this.unsupported.has(session)) { viaHost(); return sources }
    for (let start = 0; start < wanted.length; start += RESOLVE_BATCH) {
      const batch = wanted.slice(start, start + RESOLVE_BATCH)
      let result: unknown
      try {
        result = await session.request('/media/resolve', { method: 'POST', body: { paths: batch }, signal })
      } catch (error) {
        if (!(error instanceof WorkbenchHttpError && (error.status === 404 || error.status === 405))) throw error
        this.unsupported.add(session)
        viaHost()
        return sources
      }
      if (!isRecord(result) || !Array.isArray(result.items)) throw invalidResult()
      const refused: string[] = []
      for (const item of result.items) {
        const source = parseSource(item, this.config.hosts, refused)
        if (source && batch.includes(source.path)) sources.set(source.path, source)
      }
      if (refused.length) {
        this.config.warn?.(`Jingliu media links point to ${[...new Set(refused)].join(', ')}, which is not in mediaHosts; `
          + `reading ${String(refused.length)} file(s) through the Host instead.`)
      }
      if (batch.some(path => !sources.has(path))) throw invalidResult()
    }
    return sources
  }

  /**
   * Open one stored file for reading: from object storage when resolved there, otherwise through the Host,
   * following a redirect only to a trusted storage host and without the session's credentials.
   * @param session - Verified studio session.
   * @param path - Stored address.
   * @param signal - Cancellation.
   * @returns A successful response whose body the caller consumes or cancels.
   */
  async open(session: WorkbenchSession, path: string, signal: AbortSignal): Promise<Response> {
    const canonical = mediaPath(path).path
    const source = (await this.resolve(session, [canonical], signal)).get(canonical)
    if (!source || source.kind === 'missing') throw notFound(canonical)
    if (source.kind === 'object') return typed(await this.direct(canonical, source.url, signal), source.contentType, canonical)
    return typed(await this.viaHost(session, canonical, signal), '', canonical)
  }

  /**
   * Make stored files available in a local folder, downloading each one at most once.
   * A file listed in the folder index with its recorded size is used without contacting the studio.
   * @param session - Verified studio session.
   * @param paths - Stored addresses.
   * @param folder - Absolute media folder; files go to `<folder>/<dir>/<name>` and the index to `<folder>/.muse-media.json`.
   * @param options - Whether the files are kept and whether the folder is trimmed afterwards.
   * @returns The local file of each normalized address; the first failure rejects after the successful downloads are indexed.
   */
  async files(session: WorkbenchSession, paths: readonly string[], folder: string, options: FileOptions): Promise<Map<string, LocalMedia>> {
    const wanted = [...new Set(paths.map(p => mediaPath(p).path))]
    const index = await this.readIndex(folder)
    const found = new Map<string, LocalMedia>()
    const missing: string[] = []
    for (const path of wanted) {
      const entry = index.files[path]
      const file = join(folder, ...mediaPath(path).parts)
      if (entry && await sizeOf(file) === entry.size) found.set(path, { path, file, size: entry.size, contentType: entry.type })
      else missing.push(path)
    }
    const sources = missing.length ? await this.resolve(session, missing, options.signal) : new Map<string, MediaSource>()
    const settled = await Promise.allSettled(missing.map(async (path) => {
      const source = sources.get(path)
      if (!source) throw invalidResult()
      return await this.download(session, folder, source, options.signal)
    }))
    const added = settled.flatMap(outcome => outcome.status === 'fulfilled' ? [outcome.value] : [])
    for (const { local } of added) found.set(local.path, local)
    await this.commit(folder, [...found.values()], added, options)
    const failed = settled.find(outcome => outcome.status === 'rejected')
    if (failed) throw failed.reason
    return found
  }

  /**
   * Place a local media file at a second path without another download: a hard link when the filesystem allows one,
   * otherwise a copy.
   * @param source - File returned by `files`.
   * @param target - New path; it must not exist.
   */
  async place(source: LocalMedia, target: string): Promise<void> {
    try { await link(source.file, target) }
    catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code !== 'EXDEV' && code !== 'EPERM' && code !== 'ENOTSUP' && code !== 'EMLINK') throw error
      await pipeline(createReadStream(source.file), createWriteStream(target, { flags: 'wx' }))
    }
    if (await sizeOf(target) !== source.size) throw damaged()
  }

  /**
   * Upload one local file: the studio signs a PUT link, the file goes straight to object storage, and the studio
   * verifies and records it.
   * @param session - Verified studio session.
   * @param file - Absolute path of an image, audio or video file.
   * @param options - Optional project the upload belongs to, and cancellation.
   * @returns The uploaded file's permanent address and size.
   */
  async upload(
    session: WorkbenchSession, file: string, options: { projectId?: string | undefined; signal: AbortSignal },
  ): Promise<UploadedMedia> {
    const info = await stat(file).catch((error: unknown) => {
      throw new HarnessError('找不到要上传的文件：' + file, 'JINGLIU_UPLOAD_FILE_MISSING', { cause: error })
    })
    const type = UPLOAD_TYPES[extname(file).toLowerCase()]
    if (!info.isFile() || info.size < 1 || !type) throw new HarnessError('只能上传非空的图片、音频或视频文件。', 'JINGLIU_UPLOAD_INVALID')
    let ticket: unknown
    try {
      ticket = await session.request('/media/upload-url', { method: 'POST', signal: options.signal, body: {
        filename: basename(file), content_type: type, size: info.size,
        ...(options.projectId === undefined ? {} : { project_id: options.projectId }),
      } })
    } catch (error) {
      if (error instanceof WorkbenchHttpError && (error.status === 404 || error.status === 405)) {
        throw new HarnessError('当前镜流服务还不支持从 Muse 上传文件。', 'JINGLIU_UPLOAD_UNSUPPORTED', { cause: error })
      }
      throw error
    }
    if (!isRecord(ticket) || typeof ticket.path !== 'string' || typeof ticket.token !== 'string' || !ticket.token
      || (ticket.headers !== undefined && !isRecord(ticket.headers))) throw invalidResult()
    const target = mediaPath(ticket.path)
    if (target.parts.length !== 2 || target.parts[0] !== 'uploads') throw invalidResult()
    const url = trusted(ticket.upload_url, this.config.hosts, 'JINGLIU_MEDIA_HOST_REFUSED')
    const headers = new Headers()
    for (const [name, value] of Object.entries(ticket.headers ?? {})) {
      if (typeof value !== 'string' || FORBIDDEN_UPLOAD_HEADERS.test(name)) throw invalidResult()
      headers.set(name, value)
    }
    if (!headers.has('content-type')) headers.set('content-type', type)
    const body = await openAsBlob(file, { type })
    if (body.size !== info.size) throw new HarnessError('上传过程中文件发生了变化，请重试。', 'JINGLIU_UPLOAD_CHANGED')
    const lifetime = AbortSignal.any([options.signal, AbortSignal.timeout(this.config.timeoutMs)])
    let response: Response
    try {
      response = await fetch(url, { method: 'PUT', body, headers, redirect: 'error', credentials: 'omit', signal: lifetime })
    } catch (error) {
      if (options.signal.aborted) throw error
      throw new HarnessError('文件没有传到镜流存储，请重试。', 'JINGLIU_UPLOAD_FAILED', { cause: error })
    }
    await response.body?.cancel()
    if (!response.ok) throw new HarnessError('文件没有传到镜流存储（HTTP ' + String(response.status) + '），请重试。', 'JINGLIU_UPLOAD_FAILED')
    const done = await session.request('/media/upload-complete', { method: 'POST', body: { path: target.path, token: ticket.token }, signal: options.signal })
    if (!isRecord(done) || typeof done.path !== 'string' || mediaPath(done.path).path !== target.path || done.size !== info.size) {
      throw new HarnessError('镜流没有确认这次上传，请核对后重试。', 'JINGLIU_UPLOAD_UNCONFIRMED')
    }
    return { path: target.path, size: info.size }
  }

  private async direct(path: string, url: URL, signal: AbortSignal, range?: string): Promise<Response> {
    let response: Response
    try {
      response = await fetch(url, { method: 'GET', redirect: 'error', credentials: 'omit', signal, ...(range === undefined ? {} : { headers: { range } }) })
    } catch (error) {
      if (signal.aborted) throw error
      throw unavailable(error)
    }
    if (response.ok) return response
    await response.body?.cancel()
    throw response.status === 404 ? notFound(path) : unavailable()
  }

  private async viaHost(session: WorkbenchSession, path: string, signal: AbortSignal): Promise<Response> {
    const address = mediaUrl(session.origin, path)
    await session.check()
    let response: Response
    try {
      response = await session.fetch(address, { method: 'GET', signal, redirect: 'manual' })
    } catch (error) {
      if (signal.aborted) throw error
      throw unavailable(error)
    }
    if (REDIRECTS.has(response.status)) {
      const location = response.headers.get('location')
      await response.body?.cancel()
      const target = trusted(location === null ? undefined : new URL(location, address).href, this.config.hosts, 'JINGLIU_MEDIA_REDIRECT_REFUSED')
      return await this.direct(path, target, signal)
    }
    if (response.ok) return response
    await response.body?.cancel()
    throw response.status === 404 ? notFound(path) : unavailable()
  }

  private async slot<T>(signal: AbortSignal, work: () => Promise<T>): Promise<T> {
    while (this.active >= this.config.downloads) {
      await new Promise<void>((resolve) => { this.waiting.push(resolve) })
      // A cancelled waiter passes its turn on before leaving.
      if (signal.aborted) { this.waiting.shift()?.(); signal.throwIfAborted() }
    }
    this.active += 1
    try { return await work() } finally { this.active -= 1; this.waiting.shift()?.() }
  }

  private async download(session: WorkbenchSession, folder: string, source: MediaSource, signal: AbortSignal): Promise<Downloaded> {
    const key = folder + '\0' + source.path
    const pending = this.running.get(key)
    if (pending) return await pending
    const started = this.slot(signal, async () => {
      if (source.kind === 'missing') throw notFound(source.path)
      const file = join(folder, ...mediaPath(source.path).parts)
      await mkdir(dirname(file), { recursive: true })
      const lifetime = AbortSignal.any([signal, AbortSignal.timeout(this.config.timeoutMs)])
      if (source.kind === 'host') return await this.saveFromHost(session, source.path, file, lifetime)
      try {
        return await this.saveObject(source, file, lifetime)
      } catch (error) {
        // A presigned link can expire while the download waits; one fresh link is tried before failing.
        if (!(error instanceof HarnessError && error.code === 'JINGLIU_MEDIA_UNAVAILABLE')) throw error
        const fresh = (await this.resolve(session, [source.path], signal)).get(source.path)
        if (!fresh || fresh.kind === 'missing') throw notFound(source.path)
        if (fresh.kind === 'host') return await this.saveFromHost(session, source.path, file, lifetime)
        return await this.saveObject(fresh, file, lifetime)
      }
    })
    this.running.set(key, started)
    try { return await started } finally { this.running.delete(key) }
  }

  private async saveObject(source: MediaSource & { kind: 'object' }, file: string, signal: AbortSignal): Promise<Downloaded> {
    const part = file + '.part'
    const record = file + '.part.json'
    let offset = 0
    try {
      const saved: unknown = JSON.parse(await readFile(record, 'utf8'))
      const size = await sizeOf(part)
      const matches = isRecord(saved) && saved.etag === source.etag && saved.size === source.size
      if (matches && size !== undefined && size < source.size) offset = size
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error
    }
    if (offset === 0) await writeFile(record, JSON.stringify({ etag: source.etag, size: source.size }))
    let response = await this.direct(source.path, source.url, signal, offset > 0 ? 'bytes=' + String(offset) + '-' : undefined)
    if (offset > 0 && response.status !== 206) offset = 0
    if (response.status === 206 && response.headers.get('content-range') !== 'bytes ' + String(offset) + '-' + String(source.size - 1) + '/' + String(source.size)) {
      await response.body?.cancel()
      response = await this.direct(source.path, source.url, signal)
      offset = 0
    }
    // An ETag of 32 hex digits is the MD5 of a single-part object; a multipart ETag carries a part count and is not checked.
    const hash = /^[a-f0-9]{32}$/iu.test(source.etag) ? createHash('md5') : undefined
    const received = await this.write(response, part, offset, source.size, hash, signal)
    if (received !== source.size) throw damaged()
    if (hash && hash.digest('hex') !== source.etag.toLowerCase()) {
      await rm(part, { force: true })
      await rm(record, { force: true })
      throw damaged()
    }
    await rename(part, file)
    await rm(record, { force: true })
    const contentType = source.contentType || mediaType(response.headers.get('content-type'), '', source.path)
    return { local: { path: source.path, file, size: source.size, contentType }, etag: source.etag }
  }

  private async saveFromHost(session: WorkbenchSession, path: string, file: string, signal: AbortSignal): Promise<Downloaded> {
    const response = await this.viaHost(session, path, signal)
    const declared = response.headers.get('content-length')
    const size = declared !== null && /^\d+$/u.test(declared) ? Number(declared) : undefined
    if (size !== undefined && size > this.config.maxBytes) { await response.body?.cancel(); throw new HarnessError('镜流素材超过可下载的大小。', 'JINGLIU_MEDIA_TOO_LARGE') }
    const part = file + '.part'
    const received = await this.write(response, part, 0, size ?? this.config.maxBytes, undefined, signal)
    if (size !== undefined && received !== size) throw damaged()
    await rename(part, file)
    await session.check()
    const contentType = mediaType(response.headers.get('content-type'), '', path)
    return { local: { path, file, size: received, contentType }, etag: etagOf(response.headers.get('etag')) }
  }

  private async write(
    response: Response, part: string, offset: number, limit: number, hash: Hash | undefined, signal: AbortSignal,
  ): Promise<number> {
    if (!response.body) throw unavailable()
    if (hash && offset > 0) for await (const chunk of createReadStream(part, { end: offset - 1 })) hash.update(chunk as Buffer)
    let received = offset
    const meter = new Transform({ transform(chunk: Buffer, _encoding, next) {
      received += chunk.length
      if (received > limit) { next(damaged()); return }
      hash?.update(chunk)
      next(null, chunk)
    } })
    try {
      await pipeline(Readable.from(response.body), meter, createWriteStream(part, { flags: offset > 0 ? 'a' : 'w' }), { signal })
    } catch (error) {
      if (signal.aborted || (error instanceof HarnessError)) throw error
      throw unavailable(error)
    }
    return received
  }

  private async readIndex(folder: string): Promise<MediaIndex> {
    let text: string
    try { text = await readFile(join(folder, INDEX_FILE), 'utf8') }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { version: 1, files: {} }; throw error }
    try { return parseIndex(JSON.parse(text)) }
    catch (error) {
      if (!(error instanceof SyntaxError)) throw error
      // A damaged index only loses download records; files are checked again by size before reuse.
      return { version: 1, files: {} }
    }
  }

  private async commit(folder: string, used: readonly LocalMedia[], added: readonly Downloaded[], options: FileOptions): Promise<void> {
    if (!used.length) return
    await mkdir(folder, { recursive: true })
    const indexFile = join(folder, INDEX_FILE)
    await withFileLock(indexFile, async () => {
      const index = await this.readIndex(folder)
      const now = Date.now()
      for (const { local, etag } of added) {
        const keep = options.keep || index.files[local.path]?.keep === true
        index.files[local.path] = { size: local.size, etag, type: local.contentType, used: now, keep }
      }
      for (const local of used) {
        const entry = index.files[local.path]
        if (entry) { entry.used = now; entry.keep ||= options.keep }
      }
      if (options.evict) await this.evict(folder, index, new Set(used.map(local => local.path)))
      await writeFileAtomic(indexFile, JSON.stringify(index), { mode: 0o600 })
    }, { waitMs: 10_000 })
  }

  private async evict(folder: string, index: MediaIndex, current: ReadonlySet<string>): Promise<void> {
    const viewed = Object.entries(index.files).filter(([, entry]) => !entry.keep).sort(([, a], [, b]) => a.used - b.used)
    let total = viewed.reduce((sum, [, entry]) => sum + entry.size, 0)
    for (const [path, entry] of viewed) {
      if (total <= this.config.cacheBytes) break
      if (current.has(path) || this.running.has(folder + '\0' + path)) continue
      await rm(join(folder, ...mediaPath(path).parts), { force: true })
      Reflect.deleteProperty(index.files, path)
      total -= entry.size
    }
  }
}
