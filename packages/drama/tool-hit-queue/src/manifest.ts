/**
 * Reads a `drama_tos_upload` manifest from the public object store and turns
 * it into the `upload` payload of the station's videos endpoint.
 * @module @deepseek-ai/dsh-tool-hit-queue/manifest
 */
import { HarnessError } from '@deepseek-ai/dsh-error'
import { readJson, type Fetch } from './station.ts'

/** One stored object as the station expects it. */
export interface UploadObject {
  readonly kind: string
  readonly key: string
  readonly bytes: number
  readonly sha256: string
  readonly status: 'uploaded' | 'already_present'
}

/** The `upload` value of `PUT /jobs/:workId/videos`. */
export interface VideosUpload {
  readonly bucket: string
  readonly date: string
  readonly directory: string
  readonly objects: UploadObject[]
  readonly manifest: { readonly key: string }
}

/** A validated manifest. */
export interface LoadedManifest {
  /** Work id recorded in the manifest. */
  readonly workId: string
  readonly upload: VideosUpload
}

function invalid(message: string): HarnessError {
  return new HarnessError(`上传清单无效：${message}`, 'HIT_QUEUE_MANIFEST_INVALID')
}

function record(value: unknown, what: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw invalid(`${what} 不是对象`)
  return Object.fromEntries(Object.entries(value))
}

function text(value: unknown, what: string): string {
  if (typeof value !== 'string' || value.length === 0) throw invalid(`缺少 ${what}`)
  return value
}

function uploadObject(value: unknown): UploadObject {
  const item = record(value, 'objects[]')
  const bytes = item.bytes
  if (typeof bytes !== 'number' || !Number.isSafeInteger(bytes) || bytes < 0) throw invalid('objects[].bytes 不是非负整数')
  const status = item.status
  if (status !== 'uploaded' && status !== 'already_present') throw invalid('objects[].status 只能是 uploaded 或 already_present')
  return { kind: text(item.kind, 'objects[].kind'), key: text(item.key, 'objects[].key'), bytes, sha256: text(item.sha256, 'objects[].sha256'), status }
}

/**
 * Fetch and validate one manifest.
 * @param fetchImpl - Fetch implementation.
 * @param url - Public manifest URL returned by `drama_tos_upload`.
 * @param origin - Public object-store origin the URL must start with.
 * @param maxBytes - Largest accepted manifest.
 * @param signal - Caller cancellation.
 * @returns The manifest's work id and the station upload payload.
 */
export async function loadManifest(fetchImpl: Fetch, url: string, origin: string, maxBytes: number,
  signal: AbortSignal): Promise<LoadedManifest> {
  const prefix = `${origin}/`
  if (!url.startsWith(prefix) || url.includes('?') || url.includes('#')) {
    throw new HarnessError(`manifest_url 必须是 ${prefix} 下的上传清单地址`, 'HIT_QUEUE_INVALID_REQUEST')
  }
  const key = url.slice(prefix.length).split('/').map(decodeURIComponent).join('/')
  let response: Response
  try {
    response = await fetchImpl(url, { method: 'GET', redirect: 'error', signal })
  } catch (error) {
    signal.throwIfAborted()
    throw new HarnessError(`读取上传清单失败：${url}`, 'HIT_QUEUE_MANIFEST_UNAVAILABLE', { cause: error })
  }
  if (!response.ok) throw new HarnessError(`读取上传清单失败（HTTP ${response.status}）：${url}`, 'HIT_QUEUE_MANIFEST_UNAVAILABLE')
  const manifest = record(await readJson(response, maxBytes), '清单')
  if (manifest.version !== 1) throw invalid('version 不是 1')
  if (manifest.platform !== 'hongguo') throw invalid('只登记红果作品的上传清单')
  const objects = manifest.objects
  if (!Array.isArray(objects) || objects.length === 0) throw invalid('objects 为空')
  return {
    workId: text(manifest.work_id, 'work_id'),
    upload: {
      bucket: text(manifest.bucket, 'bucket'),
      date: text(manifest.date, 'date'),
      directory: text(manifest.directory, 'directory'),
      objects: objects.map(uploadObject),
      manifest: { key },
    },
  }
}
