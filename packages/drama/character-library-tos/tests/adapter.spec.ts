import { describe, expect, it, vi } from 'vitest'
import { CharacterLibraryStoreError } from '@deepseek-ai/dsh-character-library'
import { CHARACTER_LIBRARY_ANCIENT_PREFIX, CHARACTER_LIBRARY_TOS_BUCKET, CHARACTER_LIBRARY_URBAN_PREFIX, TosCharacterLibraryAdapter, loadLockedTosSdk } from '../src/adapter.ts'
import type { ResolvedConfig, TosClientConstructor, TosReadCredentials, TosRequestConfig, TosSdkClient, TosSdkModule } from '../src/types.ts'

const CONFIG: ResolvedConfig = {
  readCredentials: null,
  connectionTimeoutMs: 1_000,
  requestTimeoutMs: 2_000,
}
const CREDENTIALS = {
  accessKeyId: 'test-access-key',
  secretAccessKey: 'test-secret-key',
}
const METADATA_KEY = CHARACTER_LIBRARY_ANCIENT_PREFIX + 'char_3d_0004/metadata.json'
const URBAN_KEY = CHARACTER_LIBRARY_URBAN_PREFIX + 'char_urban_male_005/metadata.json'
const ETAG = '"0123456789abcdef0123456789abcdef"'

interface FakeBehavior {
  readonly list?: (request: Readonly<Record<string, unknown>>) => unknown
  readonly head?: (request: Readonly<Record<string, unknown>>) => unknown
  readonly get?: (request: Readonly<Record<string, unknown>>) => unknown
  readonly secondListRequest?: boolean
  readonly beforeRequest?: () => void
  readonly constructorThrows?: boolean
  readonly missingInterceptors?: boolean
  readonly cancelSourceThrows?: boolean
  readonly missingCancelSource?: boolean
  readonly interceptorUseThrows?: boolean
  readonly interceptorEjectThrows?: boolean
  readonly credentials?: TosReadCredentials | undefined
  readonly credentialError?: Error | CharacterLibraryStoreError
  readonly sdkError?: Error | CharacterLibraryStoreError
}

function fixture(behavior: FakeBehavior = {}) {
  let requestHandler: ((config: TosRequestConfig) => TosRequestConfig) | undefined
  let networkRequests = 0
  const constructorOptions: Array<Readonly<Record<string, unknown>>> = []
  const listInputs: Array<Readonly<Record<string, unknown>>> = []
  const headInputs: Array<Readonly<Record<string, unknown>>> = []
  const getInputs: Array<Readonly<Record<string, unknown>>> = []
  const cancel = vi.fn()
  class FakeClient implements TosSdkClient {
    static CancelToken = behavior.missingCancelSource
      ? undefined
      : {
        source: () => {
          if (behavior.cancelSourceThrows) throw new Error('cancel source unavailable')
          return { token: {}, cancel }
        },
      }

    readonly axiosInst = behavior.missingInterceptors
      ? undefined as never
      : {
        interceptors: {
          request: {
            use(handler: (config: TosRequestConfig) => TosRequestConfig) {
              if (behavior.interceptorUseThrows) throw new Error('interceptor unavailable')
              requestHandler = handler
              return 1
            },
            eject(id: number) {
              expect(id).toBe(1)
              if (behavior.interceptorEjectThrows) throw new Error('eject unavailable')
              requestHandler = undefined
            },
          },
        },
      }

    constructor(options: Readonly<Record<string, unknown>>) {
      if (behavior.constructorThrows) throw new Error('constructor unavailable')
      constructorOptions.push(options)
    }

    async listObjectsType2(input: Readonly<Record<string, unknown>>): Promise<unknown> {
      listInputs.push(input)
      behavior.beforeRequest?.()
      requestHandler?.({})
      networkRequests += 1
      if (behavior.secondListRequest) {
        requestHandler?.({})
        networkRequests += 1
      }
      return await behavior.list?.(input) ?? listResponse()
    }

    async headObject(input: Readonly<Record<string, unknown>>): Promise<unknown> {
      headInputs.push(input)
      behavior.beforeRequest?.()
      requestHandler?.({})
      networkRequests += 1
      return await behavior.head?.(input) ?? headResponse()
    }

    async getObjectV2(input: Readonly<Record<string, unknown>>): Promise<unknown> {
      getInputs.push(input)
      behavior.beforeRequest?.()
      requestHandler?.({})
      networkRequests += 1
      return await behavior.get?.(input) ?? getResponse(new Uint8Array([1, 2, 3]))
    }
  }
  const module: TosSdkModule = { TosClient: FakeClient as TosClientConstructor }
  let sdkLoads = 0
  let credentialResolutions = 0
  const adapter = new TosCharacterLibraryAdapter(CONFIG, {
    loadSdk: () => {
      sdkLoads += 1
      if (behavior.sdkError !== undefined) throw behavior.sdkError
      return Promise.resolve(module)
    },
    resolveReadCredentials: () => {
      credentialResolutions += 1
      if (behavior.credentialError !== undefined) throw behavior.credentialError
      return Promise.resolve('credentials' in behavior ? behavior.credentials : CREDENTIALS)
    },
  })
  return {
    adapter,
    cancel,
    constructorOptions,
    getInputs,
    headInputs,
    listInputs,
    counts: () => ({ credentialResolutions, networkRequests, sdkLoads }),
  }
}

function listResponse(
  contents: readonly unknown[] = [
    { Key: CHARACTER_LIBRARY_ANCIENT_PREFIX, Size: 0, ETag: ETAG },
    { Key: CHARACTER_LIBRARY_ANCIENT_PREFIX + 'char_3d_0004/', Size: 0, ETag: ETAG },
    { Key: METADATA_KEY, Size: 778, ETag: ETAG },
  ],
  truncated = false,
  nextCursor?: string,
): unknown {
  return {
    statusCode: 200,
    data: {
      Contents: contents,
      IsTruncated: truncated,
      ...nextCursor === undefined ? {} : { NextContinuationToken: nextCursor },
    },
  }
}

function headResponse(bytes = 3): unknown {
  return {
    statusCode: 200,
    data: {
      'content-length': String(bytes),
      'content-type': 'application/json',
      etag: ETAG,
    },
  }
}

function body(bytes: Uint8Array) {
  let destroyed = false
  return {
    destroy: vi.fn(() => { destroyed = true }),
    async *[Symbol.asyncIterator]() {
      if (!destroyed) yield bytes
    },
  }
}

function getResponse(bytes: Uint8Array, total = bytes.byteLength): unknown {
  return {
    statusCode: 206,
    headers: {
      'content-length': String(bytes.byteLength),
      'content-range': 'bytes 0-' + String(bytes.byteLength - 1) + '/' + String(total),
      'content-type': 'application/json',
    },
    data: {
      content: body(bytes),
      etag: ETAG,
    },
  }
}

function expectCode(code: string): unknown {
  return expect.objectContaining({ code, message: code })
}

function adapterWith(
  TosClient: TosClientConstructor,
  resolveReadCredentials: () => Promise<TosReadCredentials | undefined> = () =>
    Promise.resolve(CREDENTIALS),
  loadSdk: () => Promise<TosSdkModule> = () => Promise.resolve({ TosClient }),
) {
  return new TosCharacterLibraryAdapter(CONFIG, { loadSdk, resolveReadCredentials })
}

describe('TosCharacterLibraryAdapter', () => {
  it('lists one bounded historical-prefix page and ignores safe folder markers', async () => {
    const f = fixture({
      list: () => listResponse([
        { Key: CHARACTER_LIBRARY_ANCIENT_PREFIX, Size: 0, ETag: ETAG },
        { Key: CHARACTER_LIBRARY_ANCIENT_PREFIX + 'char_3d_0004/', Size: 0, ETag: ETAG },
        { Key: METADATA_KEY, Size: 778, ETag: ETAG },
      ], true, 'next-safe-cursor'),
    })

    await expect(f.adapter.list({
      prefix: CHARACTER_LIBRARY_ANCIENT_PREFIX,
      cursor: 'current-safe-cursor',
      limit: 3,
    })).resolves.toEqual({
      objects: [{ key: METADATA_KEY, bytes: 778, etag: ETAG }],
      nextCursor: 'next-safe-cursor',
    })
    expect(f.listInputs).toEqual([{
      bucket: CHARACTER_LIBRARY_TOS_BUCKET,
      prefix: CHARACTER_LIBRARY_ANCIENT_PREFIX,
      maxKeys: 3,
      continuationToken: 'current-safe-cursor',
    }])
    expect(f.constructorOptions[0]).toMatchObject({
      endpoint: 'tos-cn-beijing.volces.com',
      secure: true,
      region: 'cn-beijing',
      maxRetryCount: 0,
      connectionTimeout: 1_000,
      requestTimeout: 2_000,
    })
    expect(f.counts()).toEqual({ credentialResolutions: 1, networkRequests: 1, sdkLoads: 1 })
  })

  it('blocks an SDK pagination request before a second transport call', async () => {
    const f = fixture({ secondListRequest: true })

    await expect(f.adapter.list({
      prefix: CHARACTER_LIBRARY_ANCIENT_PREFIX,
      limit: 3,
    })).rejects.toEqual(expectCode('INVALID_RESPONSE'))
    expect(f.counts().networkRequests).toBe(1)
  })

  it('rejects a returned key outside the requested fixed prefix', async () => {
    const f = fixture({
      list: () => listResponse([{ Key: URBAN_KEY, Size: 1, ETag: ETAG }]),
    })

    await expect(f.adapter.list({
      prefix: CHARACTER_LIBRARY_ANCIENT_PREFIX,
      limit: 3,
    })).rejects.toEqual(expectCode('INVALID_RESPONSE'))
  })

  it('rejects an unreviewed prefix before credentials or SDK loading', async () => {
    const f = fixture()

    await expect(f.adapter.list({
      prefix: 'assets/reference/characters/' as typeof CHARACTER_LIBRARY_ANCIENT_PREFIX,
      limit: 3,
    })).rejects.toEqual(expectCode('INVALID_RESPONSE'))
    expect(f.counts()).toEqual({ credentialResolutions: 0, networkRequests: 0, sdkLoads: 0 })
  })

  it('fails closed without read credentials and performs no SDK work', async () => {
    let loads = 0
    const adapter = new TosCharacterLibraryAdapter(CONFIG, {
      loadSdk: () => {
        loads += 1
        throw new Error('must not load')
      },
      resolveReadCredentials: () => Promise.resolve(undefined),
    })

    await expect(adapter.head(METADATA_KEY)).rejects.toEqual(expectCode('UNAVAILABLE'))
    expect(loads).toBe(0)
  })

  it('returns null only for a typed not-found response', async () => {
    const missing = Object.assign(new Error('secret-response-body'), {
      statusCode: 404,
      response: { headers: { authorization: 'SECRET' } },
    })
    const f = fixture({ head: () => { throw missing } })

    await expect(f.adapter.head(METADATA_KEY)).resolves.toBeNull()
    expect(f.counts().networkRequests).toBe(1)
  })

  it('uses a bounded Range stream and returns only safe object metadata', async () => {
    const f = fixture()

    await expect(f.adapter.get(METADATA_KEY, 3)).resolves.toEqual({
      key: METADATA_KEY,
      bytes: 3,
      etag: ETAG,
      contentType: 'application/json',
      data: new Uint8Array([1, 2, 3]),
    })
    expect(f.getInputs).toEqual([{
      bucket: CHARACTER_LIBRARY_TOS_BUCKET,
      key: METADATA_KEY,
      dataType: 'stream',
      rangeStart: 0,
      rangeEnd: 3,
    }])
  })

  it('rejects an oversized Range response before consuming its body', async () => {
    const oversized = body(new Uint8Array([1, 2, 3, 4]))
    const f = fixture({
      get: () => ({
        statusCode: 206,
        headers: {
          'content-length': '4',
          'content-range': 'bytes 0-3/9',
        },
        data: { content: oversized, etag: ETAG },
      }),
    })

    await expect(f.adapter.get(METADATA_KEY, 3))
      .rejects.toEqual(expectCode('OBJECT_TOO_LARGE'))
    expect(oversized.destroy).toHaveBeenCalledOnce()
  })

  it('maps hostile SDK failures without serializing secrets', async () => {
    const secret = 'UNIQUE-TOS-SECRET-MARKER'
    const hostile = Object.assign(new Error(secret), {
      config: { accessKeyId: secret },
      response: {
        status: 500,
        headers: { authorization: secret },
        data: { message: secret },
      },
    })
    const f = fixture({ list: () => { throw hostile } })

    let result: unknown
    try {
      await f.adapter.list({ prefix: CHARACTER_LIBRARY_ANCIENT_PREFIX, limit: 3 })
    } catch (error) {
      result = error
    }
    expect(result).toEqual(expectCode('READ_FAILED'))
    expect(JSON.stringify(result)).not.toContain(secret)
  })

  it.each([
    { cursor: '', limit: 1 },
    { cursor: 'x'.repeat(2049), limit: 1 },
    { cursor: 'cursor\u2028break', limit: 1 },
    { limit: 0 },
    { limit: 129 },
    { limit: 1.5 },
  ])('rejects invalid list bounds before resolving credentials: %j', async (request) => {
    const f = fixture()
    await expect(f.adapter.list({
      prefix: CHARACTER_LIBRARY_ANCIENT_PREFIX,
      ...request,
    })).rejects.toEqual(expectCode('INVALID_RESPONSE'))
    expect(f.counts()).toEqual({ credentialResolutions: 0, networkRequests: 0, sdkLoads: 0 })
  })

  it.each([
    'outside/metadata.json',
    CHARACTER_LIBRARY_ANCIENT_PREFIX,
    CHARACTER_LIBRARY_ANCIENT_PREFIX + 'char//metadata.json',
    CHARACTER_LIBRARY_ANCIENT_PREFIX + './metadata.json',
    CHARACTER_LIBRARY_ANCIENT_PREFIX + '../metadata.json',
    CHARACTER_LIBRARY_ANCIENT_PREFIX + 'char\\metadata.json',
    CHARACTER_LIBRARY_ANCIENT_PREFIX + 'char/control\u2029.json',
    CHARACTER_LIBRARY_ANCIENT_PREFIX + 'x'.repeat(1025),
  ])('rejects an unsafe object key before resolving credentials: %s', async (key) => {
    const f = fixture()
    await expect(f.adapter.head(key)).rejects.toEqual(expectCode('INVALID_RESPONSE'))
    expect(f.counts()).toEqual({ credentialResolutions: 0, networkRequests: 0, sdkLoads: 0 })
  })

  it('accepts lowercase SDK fields and sanitizes untrusted optional metadata', async () => {
    const f = fixture({
      list: () => ({
        status: 200,
        data: {
          contents: [{ key: METADATA_KEY, size: 12, etag: 'not-an-etag' }],
          isTruncated: false,
          nextContinuationToken: 'ignored-while-complete',
        },
      }),
      head: () => ({
        response: { status: 200 },
        headers: {
          'content-length': '12',
          'content-type': 'INVALID CONTENT TYPE',
          etag: 'not-an-etag',
        },
      }),
    })

    await expect(f.adapter.list({
      prefix: CHARACTER_LIBRARY_ANCIENT_PREFIX,
      limit: 1,
    })).resolves.toEqual({
      objects: [{ key: METADATA_KEY, bytes: 12, etag: null }],
      nextCursor: null,
    })
    await expect(f.adapter.head(METADATA_KEY)).resolves.toEqual({
      key: METADATA_KEY,
      bytes: 12,
      etag: null,
      contentType: null,
    })
  })

  it('accepts metadata status and safe header metadata on Head', async () => {
    const f = fixture({
      head: () => ({
        $metadata: { httpStatusCode: 204 },
        headers: {
          'content-length': '0',
          'content-type': 'IMAGE/JPEG',
          etag: ETAG,
        },
      }),
    })

    await expect(f.adapter.head(METADATA_KEY)).resolves.toEqual({
      key: METADATA_KEY,
      bytes: 0,
      etag: ETAG,
      contentType: 'image/jpeg',
    })
    expect(f.headInputs).toEqual([{ bucket: CHARACTER_LIBRARY_TOS_BUCKET, key: METADATA_KEY }])
  })

  it.each([
    undefined,
    { statusCode: 199, data: { Contents: [], IsTruncated: false } },
    { statusCode: 300, data: { Contents: [], IsTruncated: false } },
    { statusCode: 200, data: {} },
    { statusCode: 200, data: { Contents: [
      { Key: METADATA_KEY, Size: 1 }, { Key: URBAN_KEY, Size: 1 },
    ], IsTruncated: false } },
    { statusCode: 200, data: { Contents: [{ Key: 3, Size: 1 }], IsTruncated: false } },
    { statusCode: 200, data: { Contents: [
      { Key: METADATA_KEY, Size: 1 }, { Key: METADATA_KEY, Size: 1 },
    ], IsTruncated: false } },
    { statusCode: 200, data: { Contents: [{ Key: METADATA_KEY, Size: -1 }], IsTruncated: false } },
    { statusCode: 200, data: { Contents: [], IsTruncated: 'false' } },
    { statusCode: 200, data: { Contents: [], IsTruncated: true } },
    { statusCode: 200, data: { Contents: [], IsTruncated: true, NextContinuationToken: '' } },
  ])('rejects malformed list response %#', async (response) => {
    const f = fixture({ list: () => response })
    await expect(f.adapter.list({
      prefix: CHARACTER_LIBRARY_ANCIENT_PREFIX,
      limit: 1,
    })).rejects.toEqual(expectCode('INVALID_RESPONSE'))
  })

  it('contains throwing response properties without exposing their errors', async () => {
    const secret = 'SECRET-GETTER-VALUE'
    const response = new Proxy({ statusCode: 200 }, {
      get(target, property) {
        if (property === 'data') throw new Error(secret)
        return property === 'statusCode' ? target.statusCode : undefined
      },
    })
    const f = fixture({ list: () => response })

    let failure: unknown
    try {
      await f.adapter.list({ prefix: CHARACTER_LIBRARY_ANCIENT_PREFIX, limit: 1 })
    } catch (error) {
      failure = error
    }
    expect(failure).toEqual(expectCode('INVALID_RESPONSE'))
    expect(JSON.stringify(failure)).not.toContain(secret)
  })

  it('contains a hostile Symbol.hasInstance implementation while mapping errors', async () => {
    const descriptor = Object.getOwnPropertyDescriptor(CharacterLibraryStoreError, Symbol.hasInstance)
    Object.defineProperty(CharacterLibraryStoreError, Symbol.hasInstance, {
      configurable: true,
      value() { throw new Error('hostile-instance-check') },
    })
    try {
      const f = fixture({ list: () => { throw new Error('transport-secret') } })
      await expect(f.adapter.list({
        prefix: CHARACTER_LIBRARY_ANCIENT_PREFIX,
        limit: 1,
      })).rejects.toMatchObject({ code: 'READ_FAILED' })
    } finally {
      if (descriptor === undefined) Reflect.deleteProperty(CharacterLibraryStoreError, Symbol.hasInstance)
      else Object.defineProperty(CharacterLibraryStoreError, Symbol.hasInstance, descriptor)
    }
  })

  it.each([
    { statusCode: 199, data: { 'content-length': '1' } },
    { statusCode: 300, data: { 'content-length': '1' } },
    { statusCode: 200, data: { 'content-length': '-1' } },
    { statusCode: 200, data: { 'content-length': 'not-a-number' } },
  ])('rejects malformed Head response %#', async (response) => {
    const f = fixture({ head: () => response })
    await expect(f.adapter.head(METADATA_KEY)).rejects.toEqual(expectCode('INVALID_RESPONSE'))
  })

  it('returns null optional metadata when a valid Head has no headers', async () => {
    const f = fixture({
      head: () => ({ statusCode: 200, data: { 'content-length': 1 } }),
    })
    await expect(f.adapter.head(METADATA_KEY)).resolves.toEqual({
      key: METADATA_KEY,
      bytes: 1,
      etag: null,
      contentType: null,
    })
  })

  it('rejects duplicate listed keys even when they fit the page bound', async () => {
    const f = fixture({
      list: () => listResponse([
        { Key: METADATA_KEY, Size: 1 },
        { Key: METADATA_KEY, Size: 1 },
      ]),
    })
    await expect(f.adapter.list({
      prefix: CHARACTER_LIBRARY_ANCIENT_PREFIX,
      limit: 2,
    })).rejects.toEqual(expectCode('INVALID_RESPONSE'))
  })

  it('maps not-found and network codes from all reviewed error locations', async () => {
    const byServiceCode = fixture({ head: () => { throw { Code: 'NoSuchKey' } } })
    const byDataCode = fixture({ head: () => { throw { data: { Code: 'NoSuchObject' } } } })
    const byResponseCode = fixture({
      list: () => { throw { response: { data: { Code: 'ENOTFOUND' } } } },
    })
    const byCauseCode = fixture({ list: () => { throw { cause: { code: 'ETIMEDOUT' } } } })

    await expect(byServiceCode.adapter.head(METADATA_KEY)).resolves.toBeNull()
    await expect(byDataCode.adapter.head(METADATA_KEY)).resolves.toBeNull()
    await expect(byResponseCode.adapter.list({
      prefix: CHARACTER_LIBRARY_ANCIENT_PREFIX,
      limit: 1,
    })).rejects.toEqual(expectCode('UNAVAILABLE'))
    await expect(byCauseCode.adapter.list({
      prefix: CHARACTER_LIBRARY_ANCIENT_PREFIX,
      limit: 1,
    })).rejects.toEqual(expectCode('UNAVAILABLE'))
  })

  it('maps a missing Get to NOT_FOUND rather than Head null', async () => {
    const f = fixture({ get: () => { throw { status: 404 } } })
    await expect(f.adapter.get(METADATA_KEY, 3)).rejects.toEqual(expectCode('NOT_FOUND'))
  })

  it.each([0, 20 * 1024 * 1024 + 1, 1.5])(
    'rejects invalid maximum read bytes before resolving credentials: %s',
    async (maxBytes) => {
      const f = fixture()
      await expect(f.adapter.get(METADATA_KEY, maxBytes))
        .rejects.toEqual(expectCode('OBJECT_TOO_LARGE'))
      expect(f.counts()).toEqual({ credentialResolutions: 0, networkRequests: 0, sdkLoads: 0 })
    },
  )

  it.each([
    null,
    {},
    { destroy() {} },
    { [Symbol.asyncIterator]: 3, destroy() {} },
  ])('rejects a non-readable Get body %#', async (content) => {
    const f = fixture({
      get: () => ({
        statusCode: 206,
        headers: { 'content-length': '1', 'content-range': 'bytes 0-0/1' },
        data: { content },
      }),
    })
    await expect(f.adapter.get(METADATA_KEY, 1)).rejects.toEqual(expectCode('INVALID_RESPONSE'))
  })

  it('destroys a valid body when the SDK does not return Partial Content', async () => {
    const responseBody = body(new Uint8Array([1]))
    const f = fixture({
      get: () => ({ statusCode: 200, data: { content: responseBody } }),
    })
    await expect(f.adapter.get(METADATA_KEY, 1)).rejects.toEqual(expectCode('INVALID_RESPONSE'))
    expect(responseBody.destroy).toHaveBeenCalledOnce()
  })

  it.each([
    {},
    { 'content-range': 'invalid', 'content-length': '1' },
    { 'content-range': 'bytes 0-999999999999999999999/1', 'content-length': '1' },
    { 'content-range': 'bytes 0-0/0', 'content-length': '0' },
    { 'content-range': 'bytes 0-0/2', 'content-length': '2' },
    { 'content-range': 'bytes 0-0/1', 'content-length': '2' },
  ])('destroys the body for an invalid Content-Range %#', async (headers) => {
    const responseBody = body(new Uint8Array([1]))
    const f = fixture({
      get: () => ({ statusCode: 206, headers, data: { content: responseBody } }),
    })
    await expect(f.adapter.get(METADATA_KEY, 1)).rejects.toEqual(expectCode('INVALID_RESPONSE'))
    expect(responseBody.destroy).toHaveBeenCalledOnce()
  })

  it('joins multiple bounded stream chunks and uses safe response headers', async () => {
    const responseBody = {
      destroy: vi.fn(),
      async *[Symbol.asyncIterator]() {
        yield new Uint8Array([1])
        yield new Uint8Array([2, 3])
      },
    }
    const f = fixture({
      get: () => ({
        statusCode: 206,
        headers: {
          'content-length': '3',
          'content-range': 'bytes 0-2/3',
          'content-type': 'image/png',
          etag: ETAG,
        },
        data: { content: responseBody },
      }),
    })
    await expect(f.adapter.get(METADATA_KEY, 3)).resolves.toEqual({
      key: METADATA_KEY,
      bytes: 3,
      etag: ETAG,
      contentType: 'image/png',
      data: new Uint8Array([1, 2, 3]),
    })
  })

  it.each([
    async function* () { yield 'not-bytes' },
    async function* () { yield new Uint8Array([1, 2]); yield new Uint8Array([3, 4]) },
    async function* () { yield new Uint8Array([1]) },
  ])('rejects invalid bounded stream contents %#', async (chunks) => {
    const responseBody = { destroy: vi.fn(), [Symbol.asyncIterator]: chunks }
    const f = fixture({
      get: () => ({
        statusCode: 206,
        headers: { 'content-length': '3', 'content-range': 'bytes 0-2/3' },
        data: { content: responseBody },
      }),
    })
    await expect(f.adapter.get(METADATA_KEY, 3)).rejects.toSatisfy((error: unknown) =>
      error instanceof Error
      && ['INVALID_RESPONSE', 'OBJECT_TOO_LARGE'].includes(String(Reflect.get(error, 'code'))))
    if (chunks.name !== '') expect(responseBody.destroy).toHaveBeenCalled()
  })

  it('preserves an iterator failure even when body destruction also fails', async () => {
    const responseBody = {
      destroy() { throw new Error('destroy-secret') },
      async *[Symbol.asyncIterator]() { throw new Error('stream-secret') },
    }
    const f = fixture({
      get: () => ({
        statusCode: 206,
        headers: { 'content-length': '1', 'content-range': 'bytes 0-0/1' },
        data: { content: responseBody },
      }),
    })
    await expect(f.adapter.get(METADATA_KEY, 1)).rejects.toEqual(expectCode('READ_FAILED'))
  })

  it.each([
    { credentials: { accessKeyId: 'short', secretAccessKey: 'long-enough-secret' } },
    { credentials: { accessKeyId: 'long-enough-access', secretAccessKey: 'short' } },
    { credentials: { accessKeyId: 'x'.repeat(257), secretAccessKey: 'long-enough-secret' } },
    { credentials: { accessKeyId: 'long-enough-access', secretAccessKey: 'x'.repeat(257) } },
    { credentials: { accessKeyId: 'access key', secretAccessKey: 'long-enough-secret' } },
    { credentials: { accessKeyId: 'long-enough-access', secretAccessKey: 'secret\u2028key' } },
  ])('rejects unsafe credentials before loading the SDK %#', async (behavior) => {
    const f = fixture(behavior)
    await expect(f.adapter.head(METADATA_KEY)).rejects.toEqual(expectCode('UNAVAILABLE'))
    expect(f.counts().sdkLoads).toBe(0)
  })

  it('contains dependency setup failures and preserves safe store failures', async () => {
    const credentialFailure = fixture({ credentialError: new Error('credential-secret') })
    const credentialStoreFailure = fixture({
      credentialError: new CharacterLibraryStoreError('INVALID_RESPONSE'),
    })
    const sdkFailure = fixture({ sdkError: new Error('sdk-secret') })
    const sdkStoreFailure = fixture({
      sdkError: new CharacterLibraryStoreError('INVALID_RESPONSE'),
    })

    await expect(credentialFailure.adapter.head(METADATA_KEY)).rejects.toEqual(expectCode('UNAVAILABLE'))
    await expect(credentialStoreFailure.adapter.head(METADATA_KEY))
      .rejects.toEqual(expectCode('INVALID_RESPONSE'))
    await expect(sdkFailure.adapter.head(METADATA_KEY)).rejects.toEqual(expectCode('UNAVAILABLE'))
    await expect(sdkStoreFailure.adapter.head(METADATA_KEY))
      .rejects.toEqual(expectCode('INVALID_RESPONSE'))
  })

  it.each([
    { missingCancelSource: true },
    { constructorThrows: true },
    { missingInterceptors: true },
    { cancelSourceThrows: true },
    { interceptorUseThrows: true },
  ])('fails closed when an SDK setup capability is unavailable %#', async (behavior) => {
    const f = fixture(behavior)
    await expect(f.adapter.head(METADATA_KEY)).rejects.toEqual(expectCode('UNAVAILABLE'))
    expect(f.counts().networkRequests).toBe(0)
  })

  it('handles cancellation before and during a request without a second request', async () => {
    const alreadyAborted = new AbortController()
    alreadyAborted.abort()
    const first = fixture()
    await expect(first.adapter.head(METADATA_KEY, alreadyAborted.signal))
      .rejects.toEqual(expectCode('READ_FAILED'))
    expect(first.counts()).toEqual({ credentialResolutions: 0, networkRequests: 0, sdkLoads: 0 })

    const duringResolve = new AbortController()
    const adapter = new TosCharacterLibraryAdapter(CONFIG, {
      resolveReadCredentials: () => {
        duringResolve.abort()
        return Promise.resolve(CREDENTIALS)
      },
      loadSdk: () => { throw new Error('must not load') },
    })
    await expect(adapter.head(METADATA_KEY, duringResolve.signal))
      .rejects.toEqual(expectCode('READ_FAILED'))

    const duringRequest = new AbortController()
    const third = fixture({ beforeRequest: () => { duringRequest.abort() } })
    await expect(third.adapter.head(METADATA_KEY, duringRequest.signal))
      .rejects.toEqual(expectCode('READ_FAILED'))
    expect(third.cancel).toHaveBeenCalledOnce()
    expect(third.counts().networkRequests).toBe(0)
  })

  it('cancels an in-flight operation and contains interceptor cleanup failure', async () => {
    const controller = new AbortController()
    const f = fixture({
      interceptorEjectThrows: true,
      list: () => {
        controller.abort()
        return listResponse([], false)
      },
    })
    await expect(f.adapter.list({
      prefix: CHARACTER_LIBRARY_ANCIENT_PREFIX,
      limit: 1,
    }, controller.signal)).resolves.toEqual({ objects: [], nextCursor: null })
    expect(f.cancel).toHaveBeenCalledOnce()
  })

  it('loads the locked SDK without constructing a client or issuing a request', async () => {
    vi.doUnmock('@volcengine/tos-sdk')
    const sdk = await loadLockedTosSdk()
    expect(typeof sdk.TosClient).toBe('function')
    expect(typeof sdk.TosClient.CancelToken?.source).toBe('function')
  })

  it('uses the real locked SDK signing and List parser through an in-memory adapter', async () => {
    vi.doUnmock('@volcengine/tos-sdk')
    const sdk = await import('@volcengine/tos-sdk')
    const requests: Array<{
      readonly method?: string
      readonly params?: unknown
      readonly signed: boolean
    }> = []
    class OfflineTosClient extends sdk.TosClient {
      constructor(options: ConstructorParameters<typeof sdk.TosClient>[0]) {
        super(options)
        this.opts.requestAdapter = async (request) => {
          const rawHeaders: unknown = request.headers
          const authorization: unknown = rawHeaders !== null && typeof rawHeaders === 'object'
            ? Reflect.get(rawHeaders, 'authorization')
            : undefined
          requests.push({
            ...request.method === undefined ? {} : { method: request.method },
            params: request.params,
            signed: typeof authorization === 'string'
              && authorization.startsWith('TOS4-HMAC-SHA256'),
          })
          return {
            status: 200,
            statusText: 'OK',
            headers: { 'content-type': 'application/json', 'x-tos-request-id': 'offline-request' },
            config: request,
            data: JSON.stringify({
              Contents: { Key: METADATA_KEY, Size: 778, ETag: ETAG },
              CommonPrefixes: [],
              KeyCount: 1,
              IsTruncated: false,
            }),
          }
        }
      }
    }
    class ProviderTosClient implements TosSdkClient {
      static CancelToken = {
        source() {
          const source = sdk.TosClient.CancelToken.source()
          return {
            token: source.token,
            cancel: (reason?: string) => { source.cancel(reason) },
          }
        },
      }

      private readonly inner: OfflineTosClient
      readonly axiosInst: NonNullable<TosSdkClient['axiosInst']>

      constructor(options: Readonly<Record<string, unknown>>) {
        const accessKeyId = options.accessKeyId
        const accessKeySecret = options.accessKeySecret
        const region = options.region
        if (typeof accessKeyId !== 'string'
          || typeof accessKeySecret !== 'string'
          || typeof region !== 'string') {
          throw new TypeError('Invalid offline SDK options')
        }
        this.inner = new OfflineTosClient({
          accessKeyId,
          accessKeySecret,
          region,
          ...typeof options.bucket === 'string' ? { bucket: options.bucket } : {},
          ...typeof options.endpoint === 'string' ? { endpoint: options.endpoint } : {},
          ...typeof options.secure === 'boolean' ? { secure: options.secure } : {},
          ...typeof options.enableVerifySSL === 'boolean'
            ? { enableVerifySSL: options.enableVerifySSL }
            : {},
          ...typeof options.maxRetryCount === 'number'
            ? { maxRetryCount: options.maxRetryCount }
            : {},
          ...typeof options.requestTimeout === 'number'
            ? { requestTimeout: options.requestTimeout }
            : {},
          ...typeof options.connectionTimeout === 'number'
            ? { connectionTimeout: options.connectionTimeout }
            : {},
          ...typeof options.enableCRC === 'boolean' ? { enableCRC: options.enableCRC } : {},
        })
        this.axiosInst = {
          interceptors: {
            request: {
              use: handler => this.inner.axiosInst.interceptors.request.use((request) => {
                handler({})
                return request
              }),
              eject: (id) => { this.inner.axiosInst.interceptors.request.eject(id) },
            },
          },
        }
      }

      listObjectsType2(input: Readonly<Record<string, unknown>>): Promise<unknown> {
        const bucket = input.bucket
        const prefix = input.prefix
        const maxKeys = input.maxKeys
        const continuationToken = input.continuationToken
        if (bucket !== CHARACTER_LIBRARY_TOS_BUCKET
          || typeof prefix !== 'string'
          || typeof maxKeys !== 'number'
          || (continuationToken !== undefined && typeof continuationToken !== 'string')) {
          return Promise.reject(new TypeError('Invalid offline List input'))
        }
        return this.inner.listObjectsType2({
          bucket,
          prefix,
          maxKeys,
          ...continuationToken === undefined ? {} : { continuationToken },
        })
      }

      headObject(): Promise<unknown> {
        return Promise.reject(new Error('Head is outside this offline SDK List test'))
      }

      getObjectV2(): Promise<unknown> {
        return Promise.reject(new Error('Get is outside this offline SDK List test'))
      }
    }
    const adapter = adapterWith(ProviderTosClient)

    await expect(adapter.list({
      prefix: CHARACTER_LIBRARY_ANCIENT_PREFIX,
      limit: 1,
    })).resolves.toEqual({
      objects: [{ key: METADATA_KEY, bytes: 778, etag: ETAG }],
      nextCursor: null,
    })
    expect(requests).toHaveLength(1)
    expect(requests[0]).toEqual({
      method: 'get',
      params: {
        'list-type': 2,
        prefix: CHARACTER_LIBRARY_ANCIENT_PREFIX,
        'max-keys': 1,
      },
      signed: true,
    })
  })

  it('accepts the CommonJS default constructor fallback', async () => {
    class DefaultClient implements TosSdkClient {
      static CancelToken = { source: () => ({ token: {}, cancel() {} }) }
      readonly axiosInst = {
        interceptors: {
          request: {
            use() { return 1 },
            eject() {},
          },
        },
      }
      listObjectsType2(): Promise<unknown> { return Promise.resolve(undefined) }
      headObject(): Promise<unknown> { return Promise.resolve(undefined) }
      getObjectV2(): Promise<unknown> { return Promise.resolve(undefined) }
    }
    vi.doMock('@volcengine/tos-sdk', () => ({ default: DefaultClient }))
    await expect(loadLockedTosSdk()).resolves.toEqual({ TosClient: DefaultClient })
    vi.doUnmock('@volcengine/tos-sdk')
  })

  it('fails closed when the locked SDK import or exports are unavailable', async () => {
    vi.doMock('@volcengine/tos-sdk', () => { throw new Error('import-secret') })
    await expect(loadLockedTosSdk()).rejects.toEqual(expectCode('UNAVAILABLE'))
    vi.doMock('@volcengine/tos-sdk', () => ({ default: {} }))
    await expect(loadLockedTosSdk()).rejects.toEqual(expectCode('UNAVAILABLE'))
    vi.doUnmock('@volcengine/tos-sdk')
  })
})
