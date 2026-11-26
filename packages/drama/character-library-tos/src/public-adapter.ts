/** Anonymous, bounded reads of the reviewed public Muse character objects. */
import { CharacterLibraryStoreError } from '@deepseek-ai/dsh-character-library'
import type { CharacterLibraryObjectGet, CharacterLibraryObjectHead, CharacterLibraryObjectListPage, CharacterLibraryObjectListRequest } from '@deepseek-ai/dsh-character-library'
import { CHARACTER_LIBRARY_ANCIENT_PREFIX, CHARACTER_LIBRARY_URBAN_PREFIX, CHARACTER_LIBRARY_TOS_BUCKET } from './adapter.ts'

const ORIGIN = 'https://muse.tos-cn-beijing.volces.com'
const MAX_BYTES = 20 * 1024 * 1024
const MAX_LIST_BYTES = 1024 * 1024
const UNSAFE_KEY = /[\\?#%:\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u
const ETAG = /^"?[A-Fa-f0-9]{32}(?:-[0-9]+)?"?$/u
const CONTENT_TYPE = /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/iu

function invalid(): never { throw new CharacterLibraryStoreError('INVALID_RESPONSE') }

function objectKey(key: string): void {
  const prefix = key.startsWith(CHARACTER_LIBRARY_ANCIENT_PREFIX) ? CHARACTER_LIBRARY_ANCIENT_PREFIX
    : key.startsWith(CHARACTER_LIBRARY_URBAN_PREFIX) ? CHARACTER_LIBRARY_URBAN_PREFIX : invalid()
  if (key.length > 1024 || UNSAFE_KEY.test(key)) invalid()
  const parts = key.slice(prefix.length).split('/')
  const [directory, name] = parts
  if (parts.length !== 2 || directory === undefined || name === undefined
    || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u.test(directory)) invalid()
  if (name !== 'metadata.json' && (name !== name.trim() || /[*"<>|]/u.test(name)
    || !/\.(?:png|jpe?g|webp)$/iu.test(name))) invalid()
}

function cursor(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 2048
    && !/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(value)
}

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function listedKey(value: unknown, prefix: string): string {
  if (typeof value !== 'string' || value.length > 1024 || !value.startsWith(prefix) || UNSAFE_KEY.test(value)) invalid()
  const suffix = value.slice(prefix.length)
  if (suffix !== '') {
    const parts = (suffix.endsWith('/') ? suffix.slice(0, -1) : suffix).split('/')
    if (parts.some(part => part === '' || part === '.' || part === '..')) invalid()
  }
  return value
}

function listPage(value: unknown, request: CharacterLibraryObjectListRequest): CharacterLibraryObjectListPage {
  if (!object(value)) invalid()
  const contents = value.KeyCount === 0 && (value.Contents === undefined || value.Contents === null) ? [] : value.Contents
  if (!Array.isArray(contents) || contents.length > request.limit
    || typeof value.IsTruncated !== 'boolean'
    || value.Name !== undefined && value.Name !== CHARACTER_LIBRARY_TOS_BUCKET
    || value.Prefix !== undefined && value.Prefix !== request.prefix
    || value.MaxKeys !== undefined && (!Number.isSafeInteger(value.MaxKeys)
      || Number(value.MaxKeys) < 1 || Number(value.MaxKeys) > request.limit)
    || value.KeyCount !== undefined && value.KeyCount !== contents.length) invalid()
  const next = value.NextContinuationToken
  if (value.IsTruncated && (!cursor(next) || next === request.cursor)) invalid()
  if (next !== undefined && next !== '' && !cursor(next)) invalid()
  const seen = new Set<string>()
  const objects: CharacterLibraryObjectListPage['objects'][number][] = []
  for (const item of contents) {
    if (!object(item) || typeof item.Size !== 'number' || !Number.isSafeInteger(item.Size) || item.Size < 0
      || item.ETag !== undefined && item.ETag !== null && (typeof item.ETag !== 'string' || !ETAG.test(item.ETag))) invalid()
    const key = listedKey(item.Key, request.prefix)
    if (seen.has(key)) invalid()
    seen.add(key)
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}\/metadata\.json$/u.test(key.slice(request.prefix.length))) continue
    objects.push({ key, bytes: item.Size, etag: typeof item.ETag === 'string' ? item.ETag : null })
  }
  return { objects, nextCursor: value.IsTruncated && typeof next === 'string' ? next : null }
}

function metadata(key: string, response: Response): CharacterLibraryObjectHead {
  const length = response.headers.get('content-length')
  if (length === null || !/^[0-9]+$/u.test(length)) invalid()
  const bytes = Number(length)
  if (!Number.isSafeInteger(bytes) || bytes < 0) invalid()
  const etag = response.headers.get('etag'), contentType = response.headers.get('content-type')
  return { key, bytes, etag: etag !== null && ETAG.test(etag) ? etag : null,
    contentType: contentType !== null && CONTENT_TYPE.test(contentType) ? contentType.toLowerCase() : null }
}

async function cancel(response: Response): Promise<void> {
  try { await response.body?.cancel() } catch (cancelError) { void cancelError }
}

async function readBounded(response: Response, limit: number): Promise<Uint8Array> {
  const reader = response.body?.getReader()
  if (reader === undefined) invalid()
  const chunks: Uint8Array[] = []
  let bytes = 0
  try {
    for (;;) {
      const part = await reader.read()
      if (part.done) break
      bytes += part.value.byteLength
      if (bytes > limit) throw new CharacterLibraryStoreError('OBJECT_TOO_LARGE')
      chunks.push(part.value)
    }
  } finally {
    try { await reader.cancel() } catch (cancelError) { void cancelError }
    reader.releaseLock()
  }
  return Buffer.concat(chunks)
}

/** Anonymous live catalog and object reads restricted to the two reviewed prefixes. */
export class PublicTosCharacterLibraryAdapter {
  constructor(private readonly requestTimeoutMs: number, private readonly fetcher: typeof fetch = globalThis.fetch) {}

  /**
   * Read one live metadata listing page without credentials.
   * @param request - Fixed prefix and bounded page selection.
   * @param signal - Optional caller cancellation.
   * @returns Metadata object descriptors and the provider's opaque continuation cursor.
   */
  async list(request: CharacterLibraryObjectListRequest, signal?: AbortSignal): Promise<CharacterLibraryObjectListPage> {
    if (!Number.isSafeInteger(request.limit) || request.limit < 1 || request.limit > 128) invalid()
    if (request.cursor !== undefined && !cursor(request.cursor)) invalid()
    const url = new URL('/', ORIGIN)
    url.search = new URLSearchParams({ 'list-type': '2', prefix: request.prefix, 'max-keys': String(request.limit),
      ...(request.cursor === undefined ? {} : { 'continuation-token': request.cursor }) }).toString()
    const response = await this.fetch(url, 'GET', undefined, signal)
    try {
      if (response.status !== 200) throw new CharacterLibraryStoreError('READ_FAILED')
      const data = await readBounded(response, MAX_LIST_BYTES)
      let value: unknown
      try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(data)) }
      catch (parseError) { void parseError; invalid() }
      return listPage(value, request)
    } catch (error) {
      if (error instanceof CharacterLibraryStoreError) throw error
      throw new CharacterLibraryStoreError('READ_FAILED')
    } finally { await cancel(response) }
  }

  /**
   * Inspect a reviewed metadata or image object.
   * @param key - Safe character metadata or image key inside either reviewed prefix.
   * @param signal - Optional caller cancellation.
   * @returns Live metadata, or null for a missing object.
   */
  async head(key: string, signal?: AbortSignal): Promise<CharacterLibraryObjectHead | null> {
    objectKey(key)
    const response = await this.request(key, 'HEAD', undefined, signal)
    try {
      if (response.status === 404) return null
      if (response.status !== 200) throw new CharacterLibraryStoreError('READ_FAILED')
      return metadata(key, response)
    } finally { await cancel(response) }
  }

  /**
   * Read a complete reviewed object with a bounded Range request.
   * @param key - Safe character metadata or image key inside either reviewed prefix.
   * @param maxBytes - Maximum accepted size, capped at 20 MiB.
   * @param signal - Optional caller cancellation.
   * @returns Exact bytes and live object metadata.
   */
  async get(key: string, maxBytes: number, signal?: AbortSignal): Promise<CharacterLibraryObjectGet> {
    objectKey(key)
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > MAX_BYTES) {
      throw new CharacterLibraryStoreError('OBJECT_TOO_LARGE')
    }
    const response = await this.request(key, 'GET', maxBytes, signal)
    try {
      if (response.status === 404) throw new CharacterLibraryStoreError('NOT_FOUND')
      if (response.status !== 206) invalid()
      const info = metadata(key, response)
      const match = /^bytes 0-([0-9]+)\/([0-9]+)$/u.exec(response.headers.get('content-range') ?? '')
      if (match === null) invalid()
      const end = Number(match[1]), total = Number(match[2])
      if (!Number.isSafeInteger(total) || total < 1 || !Number.isSafeInteger(end)
        || end !== Math.min(total - 1, maxBytes)) invalid()
      if (total > maxBytes) throw new CharacterLibraryStoreError('OBJECT_TOO_LARGE')
      if (info.bytes !== total) invalid()
      const data = await readBounded(response, total)
      if (data.byteLength !== total) invalid()
      return { ...info, data }
    } catch (error) {
      if (error instanceof CharacterLibraryStoreError) throw error
      throw new CharacterLibraryStoreError('READ_FAILED')
    } finally { await cancel(response) }
  }

  private async request(key: string, method: 'HEAD' | 'GET', maxBytes: number | undefined,
    signal?: AbortSignal): Promise<Response> {
    return this.fetch(new URL('/' + key.split('/').map(encodeURIComponent).join('/'), ORIGIN), method, maxBytes, signal)
  }

  private async fetch(url: URL, method: 'HEAD' | 'GET', maxBytes: number | undefined,
    signal?: AbortSignal): Promise<Response> {
    const timeout = AbortSignal.timeout(this.requestTimeoutMs)
    const combined = signal === undefined ? timeout : AbortSignal.any([signal, timeout])
    try {
      return await this.fetcher(url, {
        method, redirect: 'error', credentials: 'omit', signal: combined,
        ...(maxBytes === undefined ? {} : { headers: { range: `bytes=0-${maxBytes}` } }),
      })
    } catch (networkError) {
      void networkError
      throw new CharacterLibraryStoreError(combined.aborted ? 'READ_FAILED' : 'UNAVAILABLE')
    }
  }
}
