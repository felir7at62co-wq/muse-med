import { HarnessError } from '@deepseek-ai/dsh-error'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createTosUploadClient, loadTosSdk, mapTosError, type TosClientSettings, type TosSdkClient, type TosSdkModule } from '../src/tos-client.ts'

const SETTINGS: TosClientSettings = {
  bucket: 'muse',
  region: 'cn-beijing',
  endpoint: 'tos-cn-beijing.volces.com',
  partSizeBytes: 5 * 1024 * 1024,
  taskNum: 2,
  maxRetryCount: 1,
  requestTimeoutMs: 60_000,
  connectionTimeoutMs: 5_000,
}
const CREDENTIALS = { accessKeyId: 'AKLTtest', secretAccessKey: 'secret-test' }
const SHA = 'a'.repeat(64)

function serverError(statusCode: number, code = 'Error'): Error {
  return Object.assign(new Error('server'), { statusCode, code })
}

function fakeSdk(methods: Partial<TosSdkClient>) {
  const created: Record<string, unknown>[] = []
  const cancels: string[] = []
  const calls: { method: string; input: Record<string, unknown> }[] = []
  let cancelHook: () => void = () => {}
  class TosClient implements TosSdkClient {
    static readonly CancelToken = {
      source: () => ({ token: 'cancel-token', cancel: (message?: string) => { cancels.push(String(message)); cancelHook() } }),
    }
    constructor(options: Record<string, unknown>) { created.push(options) }
    headObject(input: { bucket: string; key: string }) {
      calls.push({ method: 'headObject', input })
      return methods.headObject?.(input) ?? Promise.resolve({ data: {} })
    }
    uploadFile(input: Record<string, unknown>) {
      calls.push({ method: 'uploadFile', input })
      return methods.uploadFile?.(input) ?? Promise.resolve({})
    }
    putObject(input: Record<string, unknown>) {
      calls.push({ method: 'putObject', input })
      return methods.putObject?.(input) ?? Promise.resolve({})
    }
  }
  const sdk: TosSdkModule = { TosClient }
  return { sdk, created, cancels, calls, onCancel: (hook: () => void) => { cancelHook = hook } }
}

function signal(): AbortSignal {
  return new AbortController().signal
}

function aborted(): AbortSignal {
  const controller = new AbortController()
  controller.abort(new Error('stopped'))
  return controller.signal
}

describe('createTosUploadClient', () => {
  it('builds a CRC-checked HTTPS client from the settings and credentials', () => {
    const fake = fakeSdk({})
    createTosUploadClient(fake.sdk, SETTINGS, CREDENTIALS)
    expect(fake.created).toEqual([{
      accessKeyId: 'AKLTtest', accessKeySecret: 'secret-test', region: 'cn-beijing', endpoint: 'tos-cn-beijing.volces.com',
      secure: true, enableCRC: true, maxRetryCount: 1, requestTimeout: 60_000, connectionTimeout: 5_000,
    }])
  })

  it('reads size and recorded SHA-256, rejecting malformed values', async () => {
    const responses = [
      { 'content-length': '7', 'x-tos-meta-sha256': SHA },
      { 'content-length': 'seven', 'x-tos-meta-sha256': 'XYZ' },
      { 'content-length': '-3' },
    ]
    const fake = fakeSdk({ headObject: () => Promise.resolve({ data: responses.shift() ?? {} }) })
    const client = createTosUploadClient(fake.sdk, SETTINGS, CREDENTIALS)
    await expect(client.head('k', signal())).resolves.toEqual({ bytes: 7, sha256: SHA })
    await expect(client.head('k', signal())).resolves.toEqual({ bytes: -1, sha256: null })
    await expect(client.head('k', signal())).resolves.toEqual({ bytes: -1, sha256: null })
    expect(fake.calls[0]).toEqual({ method: 'headObject', input: { bucket: 'muse', key: 'k' } })
  })

  it('treats a missing key as absent and maps other head failures', async () => {
    const errors = [serverError(404, 'NoSuchKey'), serverError(403, 'AccessDenied')]
    const fake = fakeSdk({ headObject: () => Promise.reject(errors.shift() ?? new Error('unexpected head')) })
    const client = createTosUploadClient(fake.sdk, SETTINGS, CREDENTIALS)
    await expect(client.head('k', signal())).resolves.toBeNull()
    await expect(client.head('k', signal())).rejects.toMatchObject({ code: 'TOS_UPLOAD_DENIED' })
    await expect(client.head('k', aborted())).rejects.toThrow('stopped')
    expect(fake.calls).toHaveLength(2)
  })

  it('uploads without overwrite and with the SHA-256 in object metadata', async () => {
    const fake = fakeSdk({})
    const client = createTosUploadClient(fake.sdk, SETTINGS, CREDENTIALS)
    await client.uploadFile('dir/video/001.mp4', '/tmp/001.mp4', SHA, 'video/mp4', signal())
    expect(fake.calls).toEqual([{ method: 'uploadFile', input: {
      bucket: 'muse', key: 'dir/video/001.mp4', file: '/tmp/001.mp4', contentType: 'video/mp4', meta: { sha256: SHA },
      forbidOverwrite: true, partSize: 5 * 1024 * 1024, taskNum: 2, cancelToken: 'cancel-token',
    } }])
    expect(fake.cancels).toEqual([])
  })

  it('maps an upload conflict and cancels an upload when the call is aborted', async () => {
    const conflict = fakeSdk({ uploadFile: () => Promise.reject(serverError(409, 'ObjectAlreadyExists')) })
    await expect(createTosUploadClient(conflict.sdk, SETTINGS, CREDENTIALS).uploadFile('k', '/f', SHA, 'video/mp4', signal()))
      .rejects.toMatchObject({ code: 'TOS_UPLOAD_CONFLICT' })

    let reject: (error: Error) => void = () => {}
    const pending = fakeSdk({ uploadFile: () => new Promise((_resolve, rejectUpload) => { reject = rejectUpload }) })
    pending.onCancel(() => { reject(new Error('cancelled by SDK')) })
    const controller = new AbortController()
    const upload = createTosUploadClient(pending.sdk, SETTINGS, CREDENTIALS).uploadFile('k', '/f', SHA, 'video/mp4', controller.signal)
    controller.abort(new Error('stopped'))
    await expect(upload).rejects.toThrow('stopped')
    expect(pending.cancels).toEqual(['cancelled'])

    await expect(createTosUploadClient(pending.sdk, SETTINGS, CREDENTIALS).uploadFile('k', '/f', SHA, 'video/mp4', aborted()))
      .rejects.toThrow('stopped')
  })

  it('puts JSON without overwrite and maps failures', async () => {
    const errors: (Error | undefined)[] = [undefined, serverError(500, 'InternalError')]
    const fake = fakeSdk({ putObject: () => {
      const error = errors.shift()
      return error === undefined ? Promise.resolve({}) : Promise.reject(error)
    } })
    const client = createTosUploadClient(fake.sdk, SETTINGS, CREDENTIALS)
    await client.putJson('dir/manifest.json', new TextEncoder().encode('{}'), SHA, signal())
    expect(fake.calls[0]).toEqual({ method: 'putObject', input: {
      bucket: 'muse', key: 'dir/manifest.json', body: Buffer.from('{}'), contentType: 'application/json', meta: { sha256: SHA }, forbidOverwrite: true,
    } })
    await expect(client.putJson('dir/manifest.json', new Uint8Array(), SHA, signal()))
      .rejects.toThrow('TOS 请求失败（500，InternalError）：dir/manifest.json')
    await expect(client.putJson('dir/manifest.json', new Uint8Array(), SHA, aborted())).rejects.toThrow('stopped')
  })
})

describe('mapTosError', () => {
  it('keeps coded failures and classifies server responses without echoing unsafe codes', () => {
    const coded = new HarnessError('x', 'TOS_UPLOAD_LIMIT')
    expect(mapTosError(coded, 'k')).toBe(coded)
    expect(mapTosError(serverError(412), 'k').code).toBe('TOS_UPLOAD_CONFLICT')
    expect(mapTosError(serverError(401), 'k').code).toBe('TOS_UPLOAD_DENIED')
    expect(mapTosError(serverError(502, 'bad code!'), 'k').message).toBe('TOS 请求失败（502，unknown）：k')
    expect(mapTosError({ statusCode: '500' }, 'k').message).toBe('TOS 请求失败（无状态码，unknown）：k')
    expect(mapTosError('boom', 'k')).toMatchObject({ code: 'TOS_UPLOAD_FAILED', message: 'TOS 请求失败（无状态码，unknown）：k' })
  })
})

describe('loadTosSdk', () => {
  afterEach(() => {
    vi.doUnmock('@volcengine/tos-sdk')
    vi.resetModules()
  })

  async function loadWith(module: () => object) {
    vi.resetModules()
    vi.doMock('@volcengine/tos-sdk', module)
    const { loadTosSdk: load } = await import('../src/tos-client.ts')
    return load()
  }

  function constructor(cancelToken: unknown) {
    return Object.assign(function TosClient() {}, { CancelToken: cancelToken })
  }

  it('loads the pinned SDK', async () => {
    const sdk = await loadTosSdk()
    expect(typeof sdk.TosClient).toBe('function')
    expect(typeof sdk.TosClient.CancelToken.source).toBe('function')
  })

  it('accepts a client exported only through the default export', async () => {
    const TosClient = constructor({ source: () => ({}) })
    await expect(loadWith(() => ({ TosClient: undefined, default: { TosClient } }))).resolves.toEqual({ TosClient })
  })

  it.each([
    ['a non-object default export', () => ({ TosClient: 'client', default: 1 })],
    ['a client without a cancellation factory', () => ({ TosClient: constructor(undefined), default: undefined })],
    ['a cancellation factory without source()', () => ({ TosClient: constructor({ source: 1 }), default: undefined })],
  ])('rejects %s', async (_label, module) => {
    await expect(loadWith(module)).rejects.toMatchObject({ code: 'TOS_UPLOAD_UNAVAILABLE' })
  })

  it('reports an SDK that cannot be imported', async () => {
    await expect(loadWith(() => { throw new Error('missing') })).rejects.toMatchObject({ code: 'TOS_UPLOAD_UNAVAILABLE' })
  })
})
