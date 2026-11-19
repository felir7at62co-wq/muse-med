/** Bounded requests to the configured ShotFlow V2 gateway. */
import { HarnessError } from '@deepseek-ai/dsh-error'

/** A failure reported by the Jingliu API. */
export class JingliuHttpError extends HarnessError {
  constructor(readonly status: number, code: string, message: string) {
    super(message, code)
  }
}

/** Identify a JSON object at the HTTP or credential boundary.
 * @param value - Untrusted decoded value.
 * @returns Whether fields can be read from the value.
 */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Validate the configured deployment before using its credentials.
 * @param value - Deployment origin with no route or credentials.
 * @returns Normalized origin.
 */
export function studioOrigin(value: string): string {
  const target = new URL(value)
  const localHttp = target.protocol === 'http:' && ['127.0.0.1', '[::1]'].includes(target.hostname)
  if ((!localHttp && target.protocol !== 'https:') || ![target.origin, target.origin + '/jingliu'].includes(value.replace(/\/$/u, ''))) {
    throw new HarnessError('镜流地址必须是 HTTPS 站点或本机回环地址。', 'JINGLIU_ORIGIN_INVALID')
  }
  return value.replace(/\/$/u, '')
}

/** Options for one call below the deployment's V2 API. */
export interface JingliuRequest {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'
  body?: unknown
  signal?: AbortSignal
}

interface TransportRequest extends JingliuRequest {
  headers?: Record<string, string>
  transport?: (url: URL, options: RequestInit) => Promise<Response>
}

/**
 * Resolve a studio-relative file under its authenticated media mount.
 * @param deployment - Configured studio.
 * @param media - Native media path.
 * @returns An address confined to this studio's media mount.
 */
export function mediaUrl(deployment: string, media: string): URL {
  if (!/^\/fw(?:p)?\/media\//u.test(media) || /[?#\\]|%(?:25|2e|2f|5c)/iu.test(media) || media.split('/').some(s => s === '.' || s === '..')) {
    throw new HarnessError('素材地址不属于当前镜流媒体库。', 'JINGLIU_INVALID_MEDIA')
  }
  return new URL(deployment + media.replace(/^\/fwp?\//u, '/fwp/'))
}

/** Send a JSON request and preserve the service's structured error code.
 * @param origin - Validated deployment origin.
 * @param path - Absolute path within the V2 API.
 * @param timeoutMs - Maximum round-trip duration.
 * @param options - Request and authorization fields.
 * @returns The decoded upstream result.
 */
export async function requestJson(origin: string, path: string, timeoutMs: number, options: TransportRequest = {}): Promise<unknown> {
  const base = origin + '/fwp/v2'
  const url = new URL(base + path)
  if (!path.startsWith('/') || path.startsWith('//') || path.includes('\\') || url.origin !== new URL(origin).origin
    || !url.pathname.startsWith(new URL(base).pathname + '/') || url.hash || /%(?:2e|2f|5c)/iu.test(url.pathname)) {
    throw new HarnessError('镜流请求路径无效。', 'JINGLIU_PATH_INVALID')
  }
  const timeout = AbortSignal.timeout(timeoutMs)
  const signal = options.signal === undefined ? timeout : AbortSignal.any([timeout, options.signal])
  const response = await (options.transport ?? fetch)(url, {
    method: options.method ?? 'GET', redirect: 'error', signal,
    headers: { accept: 'application/json', ...(options.body === undefined ? {} : { 'content-type': 'application/json' }), ...options.headers },
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  })
  const bytes = await boundedBytes(response, 16 * 1024 * 1024)
  let value: unknown
  try { value = JSON.parse(bytes.toString('utf8')) }
  catch (_error) {
    throw new JingliuHttpError(response.status, 'JINGLIU_INVALID_RESPONSE', '镜流未返回 JSON（HTTP ' + String(response.status) + '）。')
  }
  if (!response.ok) {
    const detail = isRecord(value) ? value.detail : undefined
    const code = isRecord(detail) && typeof detail.code === 'string' ? detail.code : 'JINGLIU_HTTP_ERROR'
    const message = isRecord(detail) && typeof detail.message === 'string' ? detail.message : typeof detail === 'string' ? detail : '镜流请求失败。'
    throw new JingliuHttpError(response.status, code, message.slice(0, 2048))
  }
  return value
}

/**
 * Read a response body up to the caller’s size limit.
 * @param response - Studio response.
 * @param limit - Maximum decoded bytes.
 * @returns The bounded body.
 */
export async function boundedBytes(response: Response, limit: number): Promise<Buffer> {
  const reader = response.body?.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  if (reader) {
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        size += value.byteLength
        if (size > limit) throw new HarnessError('镜流响应太大，请缩小查询范围。', 'JINGLIU_RESPONSE_LIMIT')
        chunks.push(value)
      }
    } finally {
      await reader.cancel()
      reader.releaseLock()
    }
  }
  return Buffer.concat(chunks, size)
}
