/**
 * HTTP binding for the data station's transcription job service API
 * (`/api/service/hits`): bounded JSON and multipart requests authenticated by
 * the station service token, with station errors mapped to coded failures.
 * @module @deepseek-ai/dsh-tool-hit-queue/station
 */
import { HarnessError } from '@deepseek-ai/dsh-error'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'

/** Fetch implementation; tests replace the global one. */
export type Fetch = (input: string, init: RequestInit) => Promise<Response>

/** Location and bounds of the station API. */
export interface StationSettings {
  /** Service API root without a trailing slash, for example `http://127.0.0.1:19617/api/service/hits`. */
  readonly baseUrl: string
  /** Per-request timeout in milliseconds. */
  readonly requestTimeoutMs: number
  /** Maximum response body size in bytes. */
  readonly maxResponseBytes: number
}

/** One station request. */
export interface StationRequest {
  readonly method: 'GET' | 'POST' | 'PUT'
  /** Path below `baseUrl`, starting with `/`. */
  readonly path: string
  /** JSON body; mutually exclusive with `form`. */
  readonly json?: unknown
  /** Multipart body; mutually exclusive with `json`. */
  readonly form?: FormData
}

const TOKEN_HEADER = 'X-Muse-Data-Service-Token'
const MAX_ERROR_CHARS = 300

function statusCode(status: number): string {
  switch (status) {
    case 401: return 'HIT_QUEUE_UNAUTHORIZED'
    case 404: return 'HIT_QUEUE_NOT_FOUND'
    case 409: return 'HIT_QUEUE_CONFLICT'
    case 422: return 'HIT_QUEUE_REJECTED'
    default: return 'HIT_QUEUE_FAILED'
  }
}

function stationMessage(body: unknown): string {
  const error: unknown = typeof body === 'object' && body !== null ? Reflect.get(body, 'error') : undefined
  return typeof error === 'string' ? error.slice(0, MAX_ERROR_CHARS) : '无说明'
}

/**
 * Read a response body up to a byte limit and parse it as JSON.
 * @param response - Station or object-store response.
 * @param maxBytes - Largest accepted body.
 * @returns Parsed JSON, or null for an empty body.
 */
export async function readJson(response: Response, maxBytes: number): Promise<JsonValue> {
  const declared = Number(response.headers.get('content-length'))
  if (declared > maxBytes) throw new HarnessError(`响应超过 ${maxBytes} 字节`, 'HIT_QUEUE_RESPONSE_TOO_LARGE')
  const bytes = new Uint8Array(await response.arrayBuffer())
  if (bytes.byteLength > maxBytes) throw new HarnessError(`响应超过 ${maxBytes} 字节`, 'HIT_QUEUE_RESPONSE_TOO_LARGE')
  const text = new TextDecoder().decode(bytes)
  if (text.trim() === '') return null
  try {
    return JSON.parse(text) as JsonValue
  } catch (error) {
    throw new HarnessError('响应不是 JSON', 'HIT_QUEUE_FAILED', { cause: error })
  }
}

/**
 * Send one request to the station service API.
 * @param fetchImpl - Fetch implementation.
 * @param settings - API root, timeout and response bound.
 * @param token - Service token, sent only in the station token header.
 * @param request - Method, path and body.
 * @param signal - Caller cancellation.
 * @returns The parsed JSON response of a 2xx answer.
 */
export async function callStation(fetchImpl: Fetch, settings: StationSettings, token: string, request: StationRequest,
  signal: AbortSignal): Promise<JsonValue> {
  const headers: Record<string, string> = { [TOKEN_HEADER]: token, Accept: 'application/json' }
  let body: string | FormData | undefined
  if (request.form !== undefined) {
    body = request.form
  } else if (request.json !== undefined) {
    headers['Content-Type'] = 'application/json'
    body = JSON.stringify(request.json)
  }
  let response: Response
  try {
    response = await fetchImpl(`${settings.baseUrl}${request.path}`, {
      method: request.method, headers, ...(body === undefined ? {} : { body }), redirect: 'error',
      signal: AbortSignal.any([signal, AbortSignal.timeout(settings.requestTimeoutMs)]),
    })
  } catch (error) {
    signal.throwIfAborted()
    throw new HarnessError(`连不上数据站：${request.method} ${request.path}`, 'HIT_QUEUE_UNAVAILABLE', { cause: error })
  }
  if (!response.ok) {
    let parsed: JsonValue = null
    try {
      parsed = await readJson(response, settings.maxResponseBytes)
    } catch (error) {
      // A proxy error page or an oversized body carries no station message; the status still classifies the failure.
      void error
    }
    throw new HarnessError(`数据站返回 ${response.status}：${stationMessage(parsed)}`, statusCode(response.status))
  }
  return readJson(response, settings.maxResponseBytes)
}
