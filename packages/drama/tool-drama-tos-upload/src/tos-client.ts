/**
 * Volcengine TOS SDK binding for {@link TosUploadClient}: head, no-overwrite
 * upload and no-overwrite JSON put. The binding exposes no delete operation.
 * @module @deepseek-ai/dsh-tool-drama-tos-upload/tos-client
 */
import { HarnessError } from '@deepseek-ai/dsh-error'
import type { RemoteObject, TosUploadClient } from './upload.ts'

/** Access key pair resolved from the Host credential store. */
export interface TosCredentials {
  readonly accessKeyId: string
  readonly secretAccessKey: string
}

/** Connection and transfer settings for one client. */
export interface TosClientSettings {
  readonly bucket: string
  readonly region: string
  /** Endpoint host name without scheme, for example `tos-cn-beijing.volces.com`. */
  readonly endpoint: string
  readonly partSizeBytes: number
  readonly taskNum: number
  readonly maxRetryCount: number
  readonly requestTimeoutMs: number
  readonly connectionTimeoutMs: number
}

/** Cancellation source returned by the SDK's `CancelToken.source()`. */
export interface TosCancelSource {
  readonly token: unknown
  cancel(message?: string): void
}

/** The SDK client methods this binding calls. */
export interface TosSdkClient {
  headObject(input: { bucket: string; key: string }): Promise<{ data: Record<string, unknown> }>
  uploadFile(input: Record<string, unknown>): Promise<unknown>
  putObject(input: Record<string, unknown>): Promise<unknown>
}

/** The SDK client constructor and its cancellation factory. */
export interface TosClientConstructor {
  new (options: Record<string, unknown>): TosSdkClient
  readonly CancelToken: { source(): TosCancelSource }
}

/** Validated SDK module projection. */
export interface TosSdkModule {
  readonly TosClient: TosClientConstructor
}

const META_SHA256 = 'sha256'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function statusCode(error: unknown): number | null {
  return isRecord(error) && typeof error.statusCode === 'number' ? error.statusCode : null
}

function remoteCode(error: unknown): string {
  return isRecord(error) && typeof error.code === 'string' && /^[A-Za-z0-9_.-]{1,64}$/.test(error.code) ? error.code : 'unknown'
}

/**
 * Map an SDK failure to a coded tool failure without echoing request details.
 * @param error - SDK rejection.
 * @param key - Object key the request addressed.
 * @returns The coded failure the tool reports.
 */
export function mapTosError(error: unknown, key: string): HarnessError {
  if (error instanceof HarnessError) return error
  const status = statusCode(error)
  if (status === 409 || status === 412) {
    return new HarnessError(`远端已有同名文件，不会覆盖：${key}`, 'TOS_UPLOAD_CONFLICT', { cause: error })
  }
  if (status === 401 || status === 403) {
    return new HarnessError(`TOS 拒绝访问，请检查密钥权限：${key}`, 'TOS_UPLOAD_DENIED', { cause: error })
  }
  return new HarnessError(`TOS 请求失败（${status ?? '无状态码'}，${remoteCode(error)}）：${key}`, 'TOS_UPLOAD_FAILED', { cause: error })
}

/**
 * Load the pinned SDK and check the members this binding uses.
 * @returns The SDK module.
 */
export async function loadTosSdk(): Promise<TosSdkModule> {
  let loaded: { readonly TosClient?: unknown; readonly default?: unknown }
  try {
    loaded = await import('@volcengine/tos-sdk')
  } catch (error) {
    throw new HarnessError('TOS SDK 不可用', 'TOS_UPLOAD_UNAVAILABLE', { cause: error })
  }
  const fallback = loaded.default
  const TosClient = toClientConstructor(loaded.TosClient)
    ?? toClientConstructor(isRecord(fallback) ? fallback.TosClient : undefined)
  if (TosClient === undefined) throw new HarnessError('TOS SDK 不可用', 'TOS_UPLOAD_UNAVAILABLE')
  return { TosClient }
}

function toClientConstructor(value: unknown): TosClientConstructor | undefined {
  if (typeof value !== 'function') return undefined
  // The SDK's static CancelToken is a class; Object() also turns a missing value into an empty object.
  const source: unknown = Reflect.get(Object(Reflect.get(value, 'CancelToken')), 'source')
  return typeof source === 'function' ? value as TosClientConstructor : undefined
}

function parseRemote(data: Record<string, unknown>): RemoteObject {
  const length = Number(data['content-length'])
  const sha256 = data[`x-tos-meta-${META_SHA256}`]
  return {
    bytes: Number.isSafeInteger(length) && length >= 0 ? length : -1,
    sha256: typeof sha256 === 'string' && /^[0-9a-f]{64}$/.test(sha256) ? sha256 : null,
  }
}

/**
 * Bind the SDK to the upload operations.
 * @param sdk - Loaded SDK module.
 * @param settings - Bucket, endpoint and transfer bounds.
 * @param credentials - Access key pair.
 * @returns Remote operations with overwrite refused by the server.
 */
export function createTosUploadClient(sdk: TosSdkModule, settings: TosClientSettings, credentials: TosCredentials): TosUploadClient {
  const client = new sdk.TosClient({
    accessKeyId: credentials.accessKeyId,
    accessKeySecret: credentials.secretAccessKey,
    region: settings.region,
    endpoint: settings.endpoint,
    secure: true,
    enableCRC: true,
    maxRetryCount: settings.maxRetryCount,
    requestTimeout: settings.requestTimeoutMs,
    connectionTimeout: settings.connectionTimeoutMs,
  })
  const { bucket } = settings
  return {
    async head(key, signal) {
      signal.throwIfAborted()
      try {
        return parseRemote((await client.headObject({ bucket, key })).data)
      } catch (error) {
        if (statusCode(error) === 404) return null
        throw mapTosError(error, key)
      }
    },
    async uploadFile(key, path, sha256, contentType, signal) {
      signal.throwIfAborted()
      const cancel = sdk.TosClient.CancelToken.source()
      const abort = (): void => { cancel.cancel('cancelled') }
      signal.addEventListener('abort', abort, { once: true })
      try {
        await client.uploadFile({
          bucket, key, file: path, contentType, meta: { [META_SHA256]: sha256 },
          forbidOverwrite: true, partSize: settings.partSizeBytes, taskNum: settings.taskNum, cancelToken: cancel.token,
        })
      } catch (error) {
        signal.throwIfAborted()
        throw mapTosError(error, key)
      } finally {
        signal.removeEventListener('abort', abort)
      }
    },
    async putJson(key, body, sha256, signal) {
      signal.throwIfAborted()
      try {
        await client.putObject({
          bucket, key, body: Buffer.from(body), contentType: 'application/json', meta: { [META_SHA256]: sha256 }, forbidOverwrite: true,
        })
      } catch (error) {
        throw mapTosError(error, key)
      }
    },
  }
}
