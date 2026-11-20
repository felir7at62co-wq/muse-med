/** Bounded JSON requests to a Muse workbench API and the user-facing names of its failures. */
import { HarnessError } from '@deepseek-ai/dsh-error'

/** How failures of one workbench are named to the user and in error codes. */
export interface WorkbenchLabel {
  /** Product name shown to the user, such as `镜流` or `剧本工坊`. */
  readonly name: string
  /** Uppercase prefix of every error code, such as `JINGLIU` or `WORKSHOP`. */
  readonly code: string
}

/** A failure reported by a workbench API, with its HTTP status. */
export class WorkbenchHttpError extends HarnessError {
  /**
   * @param status - HTTP status of the response.
   * @param code - Structured code from the response or from the workbench label.
   * @param message - User-facing explanation.
   */
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

/** Validate a configured deployment before using credentials with it.
 * @param value - HTTPS or loopback HTTP origin, optionally followed by the workbench's mount path on the Muse gateway.
 * @param mount - Path segment of the workbench on the Muse gateway, such as `jingliu`.
 * @param label - Workbench named in the failure.
 * @returns The normalized deployment without a trailing slash.
 */
export function workbenchOrigin(value: string, mount: string, label: WorkbenchLabel): string {
  const target = new URL(value)
  const localHttp = target.protocol === 'http:' && ['127.0.0.1', '[::1]'].includes(target.hostname)
  if ((!localHttp && target.protocol !== 'https:') || ![target.origin, target.origin + '/' + mount].includes(value.replace(/\/$/u, ''))) {
    throw new HarnessError(label.name + '地址必须是 HTTPS 站点或本机回环地址。', label.code + '_ORIGIN_INVALID')
  }
  return value.replace(/\/$/u, '')
}

/** Options for one call below a workbench API. */
export interface WorkbenchRequest {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'
  body?: unknown
  signal?: AbortSignal
}

/** A request with the session's authorization fields. */
export interface TransportRequest extends WorkbenchRequest {
  headers?: Record<string, string>
  transport?: (url: URL, options: RequestInit) => Promise<Response>
}

/** Send a JSON request and preserve the service's structured error code.
 * @param label - Workbench named in failures.
 * @param base - Absolute API root without a trailing slash, such as `https://studio.example/fwp/v2`.
 * @param path - Absolute path within the API.
 * @param timeoutMs - Maximum round-trip duration.
 * @param options - Request and authorization fields.
 * @returns The decoded upstream result.
 */
export async function requestJson(
  label: WorkbenchLabel, base: string, path: string, timeoutMs: number, options: TransportRequest = {},
): Promise<unknown> {
  const url = new URL(base + path)
  if (!path.startsWith('/') || path.startsWith('//') || path.includes('\\') || url.origin !== new URL(base).origin
    || !url.pathname.startsWith(new URL(base).pathname + '/') || url.hash || /%(?:2e|2f|5c)/iu.test(url.pathname)) {
    throw new HarnessError(label.name + '请求路径无效。', label.code + '_PATH_INVALID')
  }
  const timeout = AbortSignal.timeout(timeoutMs)
  const signal = options.signal === undefined ? timeout : AbortSignal.any([timeout, options.signal])
  const response = await (options.transport ?? fetch)(url, {
    method: options.method ?? 'GET', redirect: 'error', signal,
    headers: { accept: 'application/json', ...(options.body === undefined ? {} : { 'content-type': 'application/json' }), ...options.headers },
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  })
  const bytes = await boundedBytes(response, 16 * 1024 * 1024, label)
  let value: unknown
  try { value = JSON.parse(bytes.toString('utf8')) }
  catch (_error) {
    throw new WorkbenchHttpError(response.status, label.code + '_INVALID_RESPONSE', label.name + '未返回 JSON（HTTP ' + String(response.status) + '）。')
  }
  if (!response.ok) {
    const detail = isRecord(value) ? value.detail : undefined
    const code = isRecord(detail) && typeof detail.code === 'string' ? detail.code : label.code + '_HTTP_ERROR'
    const message = isRecord(detail) && typeof detail.message === 'string' ? detail.message : typeof detail === 'string' ? detail : label.name + '请求失败。'
    throw new WorkbenchHttpError(response.status, code, message.slice(0, 2048))
  }
  return value
}

/**
 * Read a response body up to the caller’s size limit.
 * @param response - Workbench response.
 * @param limit - Maximum decoded bytes.
 * @param label - Workbench named in the failure.
 * @returns The bounded body.
 */
export async function boundedBytes(response: Response, limit: number, label: WorkbenchLabel): Promise<Buffer> {
  const reader = response.body?.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  if (reader) {
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        size += value.byteLength
        if (size > limit) throw new HarnessError(label.name + '响应太大，请缩小查询范围。', label.code + '_RESPONSE_LIMIT')
        chunks.push(value)
      }
    } finally {
      await reader.cancel()
      reader.releaseLock()
    }
  }
  return Buffer.concat(chunks, size)
}
