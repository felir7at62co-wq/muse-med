/**
 * Upload planning and execution for one work's source material and scripts:
 * a 红果 drama's videos and transcription materials, or a 番茄/七猫 novel and its
 * screenplay. Remote writes stay under the configured root folder,
 * never replace an existing object with different bytes, and never delete.
 * @module @deepseek-ai/dsh-tool-drama-tos-upload/upload
 */
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { lstat, unlink } from 'node:fs/promises'
import { basename, extname, isAbsolute } from 'node:path'
import { HarnessError } from '@deepseek-ai/dsh-error'

/** Material kinds; each becomes one folder below the work directory. */
export const FILE_KINDS = ['video', 'novel', 'asr', 'ocr', 'observations', 'scripts'] as const

/** One material kind from {@link FILE_KINDS}. */
export type FileKind = typeof FILE_KINDS[number]

/** Platform folders below the root folder: 红果 dramas and 番茄/七猫 novels. */
export const PLATFORMS = ['hongguo', 'fanqie', 'qimao'] as const

/** One platform from {@link PLATFORMS}. */
export type Platform = typeof PLATFORMS[number]

const WORK_ID = /^[0-9]{1,32}$/
const DATE = /^[0-9]{8}$/
const MAX_NAME_BYTES = 200
const MAX_TITLE_CHARS = 200

const CONTENT_TYPES: Readonly<Record<string, string>> = {
  '.mp4': 'video/mp4',
  '.json': 'application/json',
  '.md': 'text/markdown; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.srt': 'application/x-subrip',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
}

/** One local file the caller asks to store. */
export interface UploadFileRequest {
  /** Absolute path of a regular local file. */
  readonly path: string
  /** Folder the file belongs to. */
  readonly kind: FileKind
  /** Object file name; defaults to the local base name. */
  readonly name?: string
}

/** One work's upload as requested by the model. */
export interface UploadRequest {
  /** Platform folder the work belongs to. */
  readonly platform: Platform
  /** Work id on that platform (红果 `series_id`, 番茄/七猫 book id), digits only. */
  readonly workId: string
  /** Work title recorded in the manifest. */
  readonly title?: string
  /** `YYYYMMDD` folder date; defaults to today in the configured time zone. */
  readonly date?: string
  /** Files to store, in manifest order. */
  readonly files: readonly UploadFileRequest[]
  /** Delete the listed local files after every object is verified remotely. */
  readonly removeLocal?: boolean
}

/** Deployment bounds applied before any remote request. */
export interface UploadLimits {
  /** Maximum number of files in one call. */
  readonly maxFiles: number
  /** Maximum size of one file in bytes. */
  readonly maxFileBytes: number
  /** Maximum total size of one call in bytes. */
  readonly maxTotalBytes: number
}

/** Deployment location of the dated folders. */
export interface UploadLocation {
  /** Bucket name, reported in results. */
  readonly bucket: string
  /** Top folder that holds the platform folders, for example `download-video-date`. */
  readonly rootFolder: string
  /** Public `https://` origin of the bucket, without a trailing slash. */
  readonly publicBaseUrl: string
  /** IANA time zone that decides the default folder date. */
  readonly timeZone: string
}

/** Remote object facts used to recognise an earlier identical upload. */
export interface RemoteObject {
  /** Stored object size in bytes. */
  readonly bytes: number
  /** SHA-256 recorded in the object metadata at upload, or null when absent. */
  readonly sha256: string | null
}

/**
 * Remote operations the upload needs. Implementations refuse to replace an
 * existing key and expose no delete operation.
 */
export interface TosUploadClient {
  /**
   * Read object facts without its body.
   * @param key - Object key.
   * @param signal - Caller cancellation.
   * @returns Object facts, or null when the key does not exist.
   */
  head(key: string, signal: AbortSignal): Promise<RemoteObject | null>
  /**
   * Upload one local file to a key that must not exist yet.
   * @param key - Object key.
   * @param path - Absolute local path.
   * @param sha256 - Hex SHA-256 stored in the object metadata.
   * @param contentType - MIME type stored with the object.
   * @param signal - Caller cancellation.
   */
  uploadFile(key: string, path: string, sha256: string, contentType: string, signal: AbortSignal): Promise<void>
  /**
   * Store a small JSON document at a key that must not exist yet.
   * @param key - Object key.
   * @param body - UTF-8 JSON bytes.
   * @param sha256 - Hex SHA-256 of `body`, stored in the object metadata.
   * @param signal - Caller cancellation.
   */
  putJson(key: string, body: Uint8Array, sha256: string, signal: AbortSignal): Promise<void>
}

/** One resolved file with its local facts and destination. */
export interface PlannedFile {
  readonly path: string
  readonly kind: FileKind
  readonly key: string
  readonly bytes: number
  readonly sha256: string
  readonly contentType: string
}

/** Validated upload with every destination key computed. */
export interface UploadPlan {
  readonly platform: Platform
  readonly workId: string
  readonly title: string | null
  readonly date: string
  /** Drama folder key, ending with `/`. */
  readonly directory: string
  readonly files: readonly PlannedFile[]
  readonly removeLocal: boolean
}

/** One stored object in the tool result. */
export interface StoredObject {
  readonly kind: FileKind
  readonly path: string
  readonly key: string
  readonly url: string
  readonly bytes: number
  readonly sha256: string
  /** `uploaded` for a new object; `already_present` when identical bytes were stored earlier. */
  readonly status: 'uploaded' | 'already_present'
}

/** Canonical tool result. */
export interface UploadResult {
  readonly bucket: string
  readonly date: string
  readonly directory: string
  readonly directory_url: string
  readonly objects: StoredObject[]
  readonly manifest: { readonly key: string; readonly url: string }
  /** Local files deleted after verification. */
  readonly removed_local: string[]
  /** Local files that remain, with the reason. */
  readonly kept_local: { readonly path: string; readonly reason: string }[]
}

function invalid(message: string): HarnessError {
  return new HarnessError(message, 'TOS_UPLOAD_INVALID_REQUEST')
}

function today(timeZone: string, now: Date): string {
  // The en-CA calendar date format is YYYY-MM-DD.
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now).replaceAll('-', '')
}

function assertDate(date: string): void {
  const year = Number(date.slice(0, 4))
  const month = Number(date.slice(4, 6))
  const day = Number(date.slice(6, 8))
  const value = new Date(Date.UTC(year, month - 1, day))
  if (!DATE.test(date) || value.getUTCFullYear() !== year || value.getUTCMonth() !== month - 1 || value.getUTCDate() !== day) {
    throw invalid(`date 必须是真实的 YYYYMMDD 日期：${date}`)
  }
}

function hasUnsafeCharacter(name: string): boolean {
  for (let index = 0; index < name.length; index++) {
    const code = name.charCodeAt(index)
    // Control characters, DEL, '/' and '\\'.
    if (code < 0x20 || code === 0x7f || code === 0x2f || code === 0x5c) return true
  }
  return false
}

function assertName(name: string): void {
  if (name.length === 0 || name.startsWith('.') || hasUnsafeCharacter(name)
    || Buffer.byteLength(name, 'utf8') > MAX_NAME_BYTES) {
    throw invalid(`文件名不能为空、以点开头、含斜杠或控制字符，且不超过 ${MAX_NAME_BYTES} 字节：${name}`)
  }
}

function contentType(name: string): string {
  return CONTENT_TYPES[extname(name).toLowerCase()] ?? 'application/octet-stream'
}

/**
 * Build the public URL of one key, percent-encoding each path segment.
 * @param publicBaseUrl - Bucket origin without a trailing slash.
 * @param key - Object key.
 * @returns Absolute public URL.
 */
export function publicUrl(publicBaseUrl: string, key: string): string {
  return `${publicBaseUrl}/${key.split('/').map(encodeURIComponent).join('/')}`
}

async function sha256File(path: string, signal: AbortSignal): Promise<string> {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path, { signal })) hash.update(chunk as Buffer)
  return hash.digest('hex')
}

/**
 * Validate a request and read the local facts of every file.
 * @param request - Model request.
 * @param location - Deployment key prefix, origin and time zone.
 * @param limits - Deployment count and size bounds.
 * @param now - Current time, which decides the default date.
 * @param signal - Caller cancellation.
 * @returns The resolved plan; nothing remote has been touched.
 */
export async function resolveUpload(request: UploadRequest, location: UploadLocation, limits: UploadLimits,
  now: Date, signal: AbortSignal): Promise<UploadPlan> {
  if (!(PLATFORMS as readonly string[]).includes(request.platform)) throw invalid(`platform 只能是 ${PLATFORMS.join('、')}：${request.platform}`)
  if (!WORK_ID.test(request.workId)) throw invalid('work_id 必须是作品在该平台上的纯数字 ID')
  const title = request.title?.trim() || null
  if (title !== null && title.length > MAX_TITLE_CHARS) throw invalid(`title 不能超过 ${MAX_TITLE_CHARS} 个字符`)
  const date = request.date ?? today(location.timeZone, now)
  assertDate(date)
  if (request.files.length === 0) throw invalid('files 至少要有一个文件')
  if (request.files.length > limits.maxFiles) {
    throw new HarnessError(`一次最多上传 ${limits.maxFiles} 个文件，请分批调用`, 'TOS_UPLOAD_LIMIT')
  }
  const directory = `${location.rootFolder}/${request.platform}/${date}/${request.workId}/`
  const keys = new Set<string>()
  const files: PlannedFile[] = []
  let total = 0
  for (const file of request.files) {
    if (!isAbsolute(file.path)) throw invalid(`path 必须是绝对路径：${file.path}`)
    if (!(FILE_KINDS as readonly string[]).includes(file.kind)) throw invalid(`kind 只能是 ${FILE_KINDS.join('、')}：${file.kind}`)
    const name = file.name ?? basename(file.path)
    assertName(name)
    const key = `${directory}${file.kind}/${name}`
    if (keys.has(key)) throw invalid(`两个文件会写到同一位置：${file.kind}/${name}`)
    keys.add(key)
    const stat = await lstat(file.path)
    if (!stat.isFile()) throw invalid(`只能上传普通文件，不能是目录或符号链接：${file.path}`)
    if (stat.size > limits.maxFileBytes) {
      throw new HarnessError(`单个文件不能超过 ${limits.maxFileBytes} 字节：${file.path}`, 'TOS_UPLOAD_LIMIT')
    }
    total += stat.size
    if (total > limits.maxTotalBytes) {
      throw new HarnessError(`一次上传总量不能超过 ${limits.maxTotalBytes} 字节，请分批调用`, 'TOS_UPLOAD_LIMIT')
    }
    signal.throwIfAborted()
    const sha256 = await sha256File(file.path, signal)
    files.push({ path: file.path, kind: file.kind, key, bytes: stat.size, sha256, contentType: contentType(name) })
  }
  return { platform: request.platform, workId: request.workId, title, date, directory, files, removeLocal: request.removeLocal === true }
}

function verified(remote: RemoteObject | null, file: { bytes: number; sha256: string }): boolean {
  return remote !== null && remote.bytes === file.bytes && remote.sha256 === file.sha256
}

function manifestStamp(now: Date): string {
  return now.toISOString().replace(/[-:]/g, '').replace('.', '')
}

/**
 * Store every planned file, write a manifest, then optionally delete the local copies.
 * @param plan - Result of {@link resolveUpload}.
 * @param client - Remote operations without overwrite or delete.
 * @param location - Bucket name and public origin for the result.
 * @param now - Current time, recorded in the manifest and its key.
 * @param signal - Caller cancellation; stops before the next remote request.
 * @returns Stored objects, the manifest location and the local cleanup outcome.
 */
export async function executeUpload(plan: UploadPlan, client: TosUploadClient, location: UploadLocation,
  now: Date, signal: AbortSignal): Promise<UploadResult> {
  const objects: StoredObject[] = []
  for (const file of plan.files) {
    signal.throwIfAborted()
    const existing = await client.head(file.key, signal)
    let status: StoredObject['status'] = 'already_present'
    if (existing === null) {
      await client.uploadFile(file.key, file.path, file.sha256, file.contentType, signal)
      if (!verified(await client.head(file.key, signal), file)) {
        throw new HarnessError(`上传后核对失败，远端大小或校验值与本地不一致：${file.key}`, 'TOS_UPLOAD_UNVERIFIED')
      }
      status = 'uploaded'
    } else if (!verified(existing, file)) {
      throw new HarnessError(`远端已有同名但内容不同的文件，不会覆盖；请改用新的 name：${file.key}`, 'TOS_UPLOAD_CONFLICT')
    }
    objects.push({ kind: file.kind, path: file.path, key: file.key, url: publicUrl(location.publicBaseUrl, file.key),
      bytes: file.bytes, sha256: file.sha256, status })
  }
  const manifestKey = `${plan.directory}manifest-${manifestStamp(now)}.json`
  const manifest = new TextEncoder().encode(JSON.stringify({
    version: 1,
    platform: plan.platform,
    work_id: plan.workId,
    title: plan.title,
    date: plan.date,
    created_at: now.toISOString(),
    objects: objects.map(({ kind, key, bytes, sha256 }) => ({ kind, key, bytes, sha256 })),
  }, null, 2) + '\n')
  signal.throwIfAborted()
  await client.putJson(manifestKey, manifest, createHash('sha256').update(manifest).digest('hex'), signal)
  const removed: string[] = []
  const kept: { path: string; reason: string }[] = []
  for (const object of objects) {
    if (!plan.removeLocal) {
      kept.push({ path: object.path, reason: 'remove_local 未开启' })
      continue
    }
    try {
      await unlink(object.path)
      removed.push(object.path)
    } catch (error) {
      kept.push({ path: object.path, reason: `删除本地文件失败：${String(error)}` })
    }
  }
  return {
    bucket: location.bucket,
    date: plan.date,
    directory: plan.directory,
    directory_url: publicUrl(location.publicBaseUrl, plan.directory),
    objects,
    manifest: { key: manifestKey, url: publicUrl(location.publicBaseUrl, manifestKey) },
    removed_local: removed,
    kept_local: kept,
  }
}
