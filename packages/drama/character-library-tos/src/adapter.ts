/** Bounded, fail-closed adapter over the locked Volcengine TOS SDK. */
import { CharacterLibraryStoreError, type CharacterLibraryObjectGet, type CharacterLibraryObjectHead, type CharacterLibraryObjectListPage, type CharacterLibraryObjectListRequest } from '@deepseek-ai/dsh-character-library'
import type { ResolvedConfig, TosAdapterDependencies, TosCancelSource, TosClientConstructor, TosReadCredentials, TosRequestConfig, TosSdkClient, TosSdkModule } from './types.ts'

/** Public endpoint identity; the SDK receives the hostname plus secure=true. */
export const CHARACTER_LIBRARY_TOS_ENDPOINT = 'https://tos-cn-beijing.volces.com'
/** Fixed Volcengine region for the reviewed historical library. */
export const CHARACTER_LIBRARY_TOS_REGION = 'cn-beijing'
/** Fixed bucket containing the reviewed historical library. */
export const CHARACTER_LIBRARY_TOS_BUCKET = 'muse'
/** Fixed historical ancient reference prefix. */
export const CHARACTER_LIBRARY_ANCIENT_PREFIX =
  'assets/reference/characters/stylized/ancient/ancient/'
/** Fixed historical urban reference prefix. */
export const CHARACTER_LIBRARY_URBAN_PREFIX =
  'assets/reference/characters/stylized/urban/urban/'

const SDK_PACKAGE = '@volcengine/tos-sdk'
const MAX_LIST_ITEMS = 128
const MAX_CURSOR_LENGTH = 2048
const MAX_KEY_LENGTH = 1024
const MAX_READ_BYTES = 20 * 1024 * 1024
const INVALID_KEY_CHARACTERS = /[\\?#%:]/u
const CREDENTIAL_WHITESPACE = /\s/u
const UNICODE_DISPLAY_CONTROLS = /[\p{Cf}\p{Zl}\p{Zp}]/u
const SAFE_ETAG = /^"?[A-Fa-f0-9]{32}(?:-[0-9]+)?"?$/
const SAFE_CONTENT_TYPE = /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/i
const NETWORK_CODES = new Set([
  'ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED', 'ECONNRESET',
  'EHOSTUNREACH', 'ENETUNREACH', 'ETIMEDOUT', 'ECONNABORTED',
])
const NOT_FOUND_CODES = new Set(['NoSuchKey', 'NoSuchObject'])
const ALLOWED_PREFIXES = new Set([
  CHARACTER_LIBRARY_ANCIENT_PREFIX,
  CHARACTER_LIBRARY_URBAN_PREFIX,
])

class TosAdapterFault extends Error {
  constructor(readonly kind: 'second_request' | 'cancelled') {
    super(kind)
    this.name = 'TosAdapterFault'
  }
}

function storeError(code: ConstructorParameters<typeof CharacterLibraryStoreError>[0]):
CharacterLibraryStoreError {
  return new CharacterLibraryStoreError(code)
}

function isStoreError(error: unknown): error is CharacterLibraryStoreError {
  try {
    return error instanceof CharacterLibraryStoreError
  } catch (instanceofError) {
    void instanceofError
    return false
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function hasUnsafeControl(value: string): boolean {
  for (const character of value) {
    const code = character.codePointAt(0)
    if (code !== undefined && (code <= 0x1f || code === 0x7f
      || UNICODE_DISPLAY_CONTROLS.test(character))) return true
  }
  return false
}

function field(value: unknown, name: string): unknown {
  if (!isRecord(value)) return undefined
  try {
    return value[name]
  } catch (propertyError) {
    void propertyError
    return undefined
  }
}

function safeInteger(value: unknown): number | null {
  const parsed = typeof value === 'string' && /^[0-9]+$/.test(value)
    ? Number(value)
    : value
  return Number.isSafeInteger(parsed) && (parsed as number) >= 0 ? parsed as number : null
}

function safeText(value: unknown, maximum: number): string | null {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= maximum
    && !hasUnsafeControl(value)
    ? value
    : null
}

function responseStatus(value: unknown): number | null {
  for (const candidate of [
    field(value, 'statusCode'),
    field(value, 'status'),
    field(field(value, 'response'), 'status'),
    field(field(value, '$metadata'), 'httpStatusCode'),
  ]) {
    if (Number.isInteger(candidate) && (candidate as number) >= 100
      && (candidate as number) <= 599) return candidate as number
  }
  return null
}

function errorCode(value: unknown): string | null {
  for (const candidate of [
    field(value, 'code'),
    field(value, 'Code'),
    field(field(value, 'data'), 'Code'),
    field(field(field(value, 'response'), 'data'), 'Code'),
    field(field(value, 'cause'), 'code'),
  ]) {
    const safe = safeText(candidate, 80)
    if (safe !== null) return safe
  }
  return null
}

function mapReadError(error: unknown): CharacterLibraryStoreError {
  if (isStoreError(error)) return error
  if (error instanceof TosAdapterFault) {
    return storeError(error.kind === 'second_request' ? 'INVALID_RESPONSE' : 'READ_FAILED')
  }
  const status = responseStatus(error)
  const code = errorCode(error)
  if (status === 404 || (code !== null && NOT_FOUND_CODES.has(code))) {
    return storeError('NOT_FOUND')
  }
  if (code !== null && NETWORK_CODES.has(code)) return storeError('UNAVAILABLE')
  return storeError('READ_FAILED')
}

function assertPrefix(prefix: string): void {
  if (!ALLOWED_PREFIXES.has(prefix)) throw storeError('INVALID_RESPONSE')
}

function prefixForKey(key: string): string {
  const prefix = [...ALLOWED_PREFIXES].find(candidate => key.startsWith(candidate))
  if (prefix === undefined) throw storeError('INVALID_RESPONSE')
  return prefix
}

function relativeSegments(key: string, prefix: string, allowMarker: boolean): readonly string[] {
  if (typeof key !== 'string' || key.length > MAX_KEY_LENGTH || !key.startsWith(prefix)) {
    throw storeError('INVALID_RESPONSE')
  }
  if (allowMarker && key === prefix) return []
  const relative = key.slice(prefix.length)
  const marker = allowMarker && relative.endsWith('/')
  const candidate = marker ? relative.slice(0, -1) : relative
  if (candidate.length === 0 || INVALID_KEY_CHARACTERS.test(candidate)
    || hasUnsafeControl(candidate)) {
    throw storeError('INVALID_RESPONSE')
  }
  const segments = candidate.split('/')
  if (segments.some(segment => segment.length === 0 || segment === '.' || segment === '..')) {
    throw storeError('INVALID_RESPONSE')
  }
  return segments
}

function assertObjectKey(key: string): string {
  const prefix = prefixForKey(key)
  relativeSegments(key, prefix, false)
  return key
}

function listedObjectKey(value: unknown, prefix: string): string | null {
  if (typeof value !== 'string') throw storeError('INVALID_RESPONSE')
  const segments = relativeSegments(value, prefix, true)
  if (segments.length === 0 || value.endsWith('/')) return null
  return value
}

function assertCursor(value: string | undefined): void {
  if (value === undefined) return
  if (value.length === 0 || value.length > MAX_CURSOR_LENGTH
    || hasUnsafeControl(value)) {
    throw storeError('INVALID_RESPONSE')
  }
}

function isAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true
}

function assertCredentials(credentials: TosReadCredentials | undefined): TosReadCredentials {
  if (credentials === undefined
    || credentials.accessKeyId.length < 8
    || credentials.accessKeyId.length > 256
    || credentials.secretAccessKey.length < 8
    || credentials.secretAccessKey.length > 256
    || CREDENTIAL_WHITESPACE.test(credentials.accessKeyId)
    || CREDENTIAL_WHITESPACE.test(credentials.secretAccessKey)
    || hasUnsafeControl(credentials.accessKeyId)
    || hasUnsafeControl(credentials.secretAccessKey)) {
    throw storeError('UNAVAILABLE')
  }
  return credentials
}

function etag(value: unknown): string | null {
  return typeof value === 'string' && SAFE_ETAG.test(value) ? value : null
}

function header(response: unknown, name: string): unknown {
  const headers = field(response, 'headers')
  if (!isRecord(headers)) return undefined
  return field(headers, name) ?? field(headers, name.toLowerCase())
}

function contentType(response: unknown): string | null {
  const raw = field(field(response, 'data'), 'content-type')
    ?? header(response, 'content-type')
  return typeof raw === 'string' && SAFE_CONTENT_TYPE.test(raw) ? raw.toLowerCase() : null
}

function headResult(key: string, response: unknown): CharacterLibraryObjectHead {
  const status = responseStatus(response)
  if (status === null || status < 200 || status > 299) throw storeError('INVALID_RESPONSE')
  const data = field(response, 'data')
  const bytes = safeInteger(field(data, 'content-length') ?? header(response, 'content-length'))
  if (bytes === null) throw storeError('INVALID_RESPONSE')
  return {
    key,
    bytes,
    etag: etag(field(data, 'etag') ?? header(response, 'etag')),
    contentType: contentType(response),
  }
}

function listPage(request: CharacterLibraryObjectListRequest, response: unknown):
CharacterLibraryObjectListPage {
  const status = responseStatus(response)
  if (status === null || status < 200 || status > 299) throw storeError('INVALID_RESPONSE')
  const data = field(response, 'data')
  const contents = field(data, 'Contents') ?? field(data, 'contents')
  if (!Array.isArray(contents) || contents.length > request.limit) {
    throw storeError('INVALID_RESPONSE')
  }
  const objects: Array<CharacterLibraryObjectListPage['objects'][number]> = []
  const seen = new Set<string>()
  for (const item of contents) {
    const key = listedObjectKey(field(item, 'Key') ?? field(item, 'key'), request.prefix)
    if (key === null) continue
    if (seen.has(key)) throw storeError('INVALID_RESPONSE')
    seen.add(key)
    const bytes = safeInteger(field(item, 'Size') ?? field(item, 'size'))
    if (bytes === null) throw storeError('INVALID_RESPONSE')
    objects.push({
      key,
      bytes,
      etag: etag(field(item, 'ETag') ?? field(item, 'etag')),
    })
  }
  const truncated = field(data, 'IsTruncated') ?? field(data, 'isTruncated')
  if (typeof truncated !== 'boolean') throw storeError('INVALID_RESPONSE')
  const rawCursor = field(data, 'NextContinuationToken') ?? field(data, 'nextContinuationToken')
  const nextCursor = truncated ? safeText(rawCursor, MAX_CURSOR_LENGTH) : null
  if (truncated && nextCursor === null) throw storeError('INVALID_RESPONSE')
  return { objects, nextCursor }
}

function parseContentRange(response: unknown, maxBytes: number): number {
  const raw = header(response, 'content-range')
  const match = typeof raw === 'string'
    ? /^bytes 0-([0-9]+)\/([0-9]+)$/.exec(raw)
    : null
  if (match === null) throw storeError('INVALID_RESPONSE')
  const end = Number(match[1])
  const total = Number(match[2])
  if (!Number.isSafeInteger(end) || !Number.isSafeInteger(total)
    || end < 0 || total < 1 || end !== Math.min(total - 1, maxBytes)) {
    throw storeError('INVALID_RESPONSE')
  }
  if (total > maxBytes) throw storeError('OBJECT_TOO_LARGE')
  const length = safeInteger(header(response, 'content-length'))
  if (length !== total) throw storeError('INVALID_RESPONSE')
  return total
}

interface ReadableBody extends AsyncIterable<unknown> {
  destroy(): void
}

function readableBody(value: unknown): ReadableBody {
  if (value === null || typeof value !== 'object') throw storeError('INVALID_RESPONSE')
  const iterator = (value as AsyncIterable<unknown>)[Symbol.asyncIterator]
  const destroy = field(value, 'destroy')
  if (typeof iterator !== 'function' || typeof destroy !== 'function') {
    throw storeError('INVALID_RESPONSE')
  }
  return value as ReadableBody
}

async function readBounded(body: ReadableBody, expectedBytes: number): Promise<Uint8Array> {
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    for await (const rawChunk of body) {
      if (!(rawChunk instanceof Uint8Array)) throw storeError('INVALID_RESPONSE')
      total += rawChunk.byteLength
      if (total > expectedBytes) throw storeError('OBJECT_TOO_LARGE')
      chunks.push(rawChunk)
    }
  } catch (error) {
    try {
      body.destroy()
    } catch (destroyError) {
      void destroyError
    }
    throw error
  }
  if (total !== expectedBytes) throw storeError('INVALID_RESPONSE')
  const result = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    result.set(chunk, offset)
    offset += chunk.byteLength
  }
  return result
}

function toClientConstructor(value: unknown): TosClientConstructor | undefined {
  return typeof value === 'function' ? value as TosClientConstructor : undefined
}

/**
 * Dynamically load the exact package dependency. Import is deferred until a
 * configured read operation, so an unconfigured deployment performs no SDK work.
 * @returns validated SDK constructor projection.
 */
export async function loadLockedTosSdk(): Promise<TosSdkModule> {
  let raw: unknown
  try {
    raw = await import(SDK_PACKAGE)
  } catch (importError) {
    void importError
    throw storeError('UNAVAILABLE')
  }
  const named = field(raw, 'TosClient')
  const fallback = field(raw, 'default')
  const TosClient = toClientConstructor(named) ?? toClientConstructor(fallback)
  if (TosClient === undefined) throw storeError('UNAVAILABLE')
  return { TosClient }
}

/** Read-only TOS adapter used by the Cordis provider. */
export class TosCharacterLibraryAdapter {
  constructor(
    private readonly config: ResolvedConfig,
    private readonly dependencies: TosAdapterDependencies,
  ) {}

  /**
   * Read one bounded page from a fixed historical prefix.
   * @param request - Reviewed prefix, page limit and optional continuation token.
   * @param signal - Optional cancellation for this one SDK request.
   * @returns Validated object metadata and the next cursor, if any.
   */
  async list(
    request: CharacterLibraryObjectListRequest,
    signal?: AbortSignal,
  ): Promise<CharacterLibraryObjectListPage> {
    assertPrefix(request.prefix)
    assertCursor(request.cursor)
    if (!Number.isSafeInteger(request.limit) || request.limit < 1
      || request.limit > MAX_LIST_ITEMS) throw storeError('INVALID_RESPONSE')
    return this.withReadClient(signal, async (client) => {
      const input: Record<string, unknown> = {
        bucket: CHARACTER_LIBRARY_TOS_BUCKET,
        prefix: request.prefix,
        maxKeys: request.limit,
      }
      if (request.cursor !== undefined) input.continuationToken = request.cursor
      const response = await client.listObjectsType2(input)
      return listPage(request, response)
    })
  }

  /**
   * Read bounded object metadata without fetching a body.
   * @param key - Object key under a reviewed historical prefix.
   * @param signal - Optional cancellation for this one SDK request.
   * @returns Validated metadata, or null when the object is absent.
   */
  async head(key: string, signal?: AbortSignal): Promise<CharacterLibraryObjectHead | null> {
    assertObjectKey(key)
    try {
      return await this.withReadClient(signal, async client =>
        headResult(key, await client.headObject({
          bucket: CHARACTER_LIBRARY_TOS_BUCKET,
          key,
        })))
    } catch (error) {
      const mapped = mapReadError(error)
      if (mapped.code === 'NOT_FOUND') return null
      throw mapped
    }
  }

  /**
   * Read an object through a Range response and a bounded stream.
   * @param key - Object key under a reviewed historical prefix.
   * @param maxBytes - Maximum accepted image body size.
   * @param signal - Optional cancellation for this one SDK request.
   * @returns Validated metadata and exact bounded object bytes.
   */
  async get(
    key: string,
    maxBytes: number,
    signal?: AbortSignal,
  ): Promise<CharacterLibraryObjectGet> {
    assertObjectKey(key)
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > MAX_READ_BYTES) {
      throw storeError('OBJECT_TOO_LARGE')
    }
    return this.withReadClient(signal, async (client) => {
      const response = await client.getObjectV2({
        bucket: CHARACTER_LIBRARY_TOS_BUCKET,
        key,
        dataType: 'stream',
        rangeStart: 0,
        rangeEnd: maxBytes,
      })
      const bodyValue = field(field(response, 'data'), 'content')
      let body: ReadableBody
      try {
        body = readableBody(bodyValue)
      } catch (error) {
        throw mapReadError(error)
      }
      const status = responseStatus(response)
      if (status !== 206) {
        body.destroy()
        throw storeError('INVALID_RESPONSE')
      }
      let expected: number
      try {
        expected = parseContentRange(response, maxBytes)
      } catch (error) {
        body.destroy()
        throw error
      }
      const data = await readBounded(body, expected)
      const responseData = field(response, 'data')
      return {
        key,
        bytes: data.byteLength,
        etag: etag(field(responseData, 'etag') ?? header(response, 'etag')),
        contentType: contentType(response),
        data,
      }
    })
  }

  private async withReadClient<T>(
    signal: AbortSignal | undefined,
    operation: (client: TosSdkClient) => Promise<T>,
  ): Promise<T> {
    if (isAborted(signal)) throw storeError('READ_FAILED')
    let credentials: TosReadCredentials
    try {
      credentials = assertCredentials(await this.dependencies.resolveReadCredentials())
    } catch (error) {
      if (isStoreError(error)) throw error
      throw storeError('UNAVAILABLE')
    }
    if (isAborted(signal)) throw storeError('READ_FAILED')
    let sdk: TosSdkModule
    try {
      sdk = await this.dependencies.loadSdk()
    } catch (error) {
      if (isStoreError(error)) throw error
      throw storeError('UNAVAILABLE')
    }
    const cancelToken = sdk.TosClient.CancelToken
    if (typeof cancelToken?.source !== 'function') throw storeError('UNAVAILABLE')
    let client: TosSdkClient
    try {
      client = new sdk.TosClient({
        accessKeyId: credentials.accessKeyId,
        accessKeySecret: credentials.secretAccessKey,
        region: CHARACTER_LIBRARY_TOS_REGION,
        endpoint: new URL(CHARACTER_LIBRARY_TOS_ENDPOINT).hostname,
        secure: true,
        enableVerifySSL: true,
        enableCRC: true,
        maxRetryCount: 0,
        requestTimeout: this.config.requestTimeoutMs,
        connectionTimeout: this.config.connectionTimeoutMs,
      })
    } catch (constructorError) {
      void constructorError
      throw storeError('UNAVAILABLE')
    }
    const interceptors = client.axiosInst?.interceptors?.request
    if (interceptors === undefined
      || typeof interceptors.use !== 'function'
      || typeof interceptors.eject !== 'function') throw storeError('UNAVAILABLE')
    let cancel: TosCancelSource
    try {
      cancel = cancelToken.source()
    } catch (cancelError) {
      void cancelError
      throw storeError('UNAVAILABLE')
    }
    let requestCount = 0
    let interceptorId: number
    try {
      interceptorId = interceptors.use((request: TosRequestConfig) => {
        requestCount += 1
        if (requestCount > 1) throw new TosAdapterFault('second_request')
        if (isAborted(signal)) throw new TosAdapterFault('cancelled')
        return { ...request, cancelToken: cancel.token }
      })
    } catch (interceptorError) {
      void interceptorError
      throw storeError('UNAVAILABLE')
    }
    const abort = (): void => { cancel.cancel('character-library read cancelled') }
    signal?.addEventListener('abort', abort, { once: true })
    try {
      return await operation(client)
    } catch (error) {
      throw mapReadError(error)
    } finally {
      signal?.removeEventListener('abort', abort)
      try {
        interceptors.eject(interceptorId)
      } catch (ejectError) {
        void ejectError
      }
    }
  }
}
