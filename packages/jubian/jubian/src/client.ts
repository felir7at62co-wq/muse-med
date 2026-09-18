/**
 * The one HTTP path to Jubian.
 *
 * Every rule the product's four adapters each implemented separately lives here
 * once: a fixed origin, no redirect following, a single attempt with no retry,
 * a byte bound on the response, strict UTF-8 decoding, an envelope check that
 * accepts both observed success codes, and a failure vocabulary that never
 * carries a provider body or the token.
 *
 * This module knows nothing about business fields. It returns the envelope's
 * `data` untouched; parsing belongs to the reader that asked for it, so a field
 * the provider adds never becomes an error here.
 */
import { createHash } from 'node:crypto'
import { isUsableBearerToken, trimBearerToken } from './credential.ts'
import { JubianError, codeForHttpStatus, failureForEnvelopeCode } from './error.ts'

/** Default provider origin; the path after it is the caller's. */
export const JUBIAN_DEFAULT_BASE_URL = 'https://web.jubianai.net/prod-api'

const DEFAULT_TIMEOUT_MS = 30000
const MAX_TIMEOUT_MS = 60000
const DEFAULT_MAX_RESPONSE_BYTES = 2 * 1024 * 1024
const MAX_RESPONSE_BYTES = 32 * 1024 * 1024

/** One request as a caller states it. */
export interface JubianRequest {
  method: 'GET' | 'POST' | 'PUT' | 'DELETE'
  /** Path including its query string, e.g. `/aigc/asset/123`. */
  path: string
  /** JSON body; omitted for a GET and for a POST that carries no body. */
  body?: Record<string, unknown>
  /** Caller cancellation, combined with the client's own timeout. */
  signal?: AbortSignal
}

/** What one completed request yields. */
export interface JubianResponse {
  /** Status and application code, for evidence and for the ledger. */
  transport: { http_status: number | null; application_code: number | null }
  /** Hash of the exact response bytes. */
  response_sha256: string | null
  /** The envelope's `data`, already proven to sit behind a success code. */
  data: unknown
}

/** How one client resolves its credential, its origin and its byte budget. */
export interface JubianClientOptions {
  /** Resolves the bearer token; the client repairs its boundary and never logs it. */
  credential: () => Promise<string>
  /** Origin override; defaults to {@link JUBIAN_DEFAULT_BASE_URL}. */
  baseUrl?: string
  /** Abort a call after this many milliseconds. */
  timeoutMs?: number
  /** Refuse a response body larger than this many bytes. */
  maxResponseBytes?: number
  /** Transport override, used by tests. */
  fetch?: typeof fetch
}

function hash(bytes: Uint8Array): string {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`
}

/** Fixed-origin, single-attempt, byte-bounded Jubian transport. */
export class JubianClient {
  private readonly credential: () => Promise<string>
  private readonly baseUrl: string
  private readonly timeoutMs: number
  private readonly maximum: number
  private readonly transport: typeof fetch

  constructor(options: JubianClientOptions) {
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
    const maximum = options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES
    if (typeof options.credential !== 'function') throw new TypeError('Jubian credential resolver must be a function')
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_TIMEOUT_MS) {
      throw new TypeError(`Jubian timeoutMs must be an integer within 1..${MAX_TIMEOUT_MS}`)
    }
    if (!Number.isSafeInteger(maximum) || maximum < 1 || maximum > MAX_RESPONSE_BYTES) {
      throw new TypeError(`Jubian maxResponseBytes must be an integer within 1..${MAX_RESPONSE_BYTES}`)
    }
    this.credential = options.credential
    this.baseUrl = options.baseUrl ?? JUBIAN_DEFAULT_BASE_URL
    this.timeoutMs = timeoutMs
    this.maximum = maximum
    this.transport = options.fetch ?? fetch
  }

  /**
   * Send one request and return its envelope `data`.
   * @param request - Method, path, optional body and cancellation.
   * @returns Transport evidence, the response hash and the envelope's data.
   * @throws {JubianError} With one of the five stable codes.
   */
  async request(request: JubianRequest): Promise<JubianResponse> {
    const token = await this.resolveToken()
    const body = request.body === undefined ? undefined : JSON.stringify(request.body)
    const timeout = AbortSignal.timeout(this.timeoutMs)
    const signal = request.signal === undefined ? timeout : AbortSignal.any([request.signal, timeout])
    let response: Response
    try {
      response = await this.transport(`${this.baseUrl}${request.path}`, {
        method: request.method,
        headers: { Accept: 'application/json', Authorization: `Bearer ${token}`,
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
        redirect: 'error',
        signal,
        ...(body === undefined ? {} : { body }),
      })
    } catch { throw new JubianError('NETWORK_ERROR') }
    if (!response.ok) {
      await response.body?.cancel().catch(() => {})
      throw new JubianError(codeForHttpStatus(response.status))
    }
    const bytes = await this.readBounded(response)
    const response_sha256 = hash(bytes)
    let parsed: unknown
    try { parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) }
    catch { throw new JubianError('CONTRACT_CHANGED') }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new JubianError('CONTRACT_CHANGED')
    const envelope = parsed as Record<string, unknown>
    const code = envelope.code
    if (typeof code !== 'number' || !Number.isSafeInteger(code)) throw new JubianError('CONTRACT_CHANGED')
    const failure = failureForEnvelopeCode(code)
    if (failure !== null) throw new JubianError(failure)
    // Two envelope shapes are live on this provider: a single-object endpoint
    // nests its payload under `data`, while the list endpoints carry `total` and
    // `rows` at the top level and have no `data` at all. Both are handed to the
    // reader as one object, so a reader never has to know which shape it got.
    const envelopeData = Object.hasOwn(envelope, 'data')
      ? envelope.data
      : Object.fromEntries(Object.entries(envelope).filter(([key]) => key !== 'msg'))
    return { transport: { http_status: response.status, application_code: code }, response_sha256, data: envelopeData }
  }

  private async resolveToken(): Promise<string> {
    let stored: string
    try { stored = await this.credential() } catch { throw new JubianError('AUTHENTICATION_REQUIRED') }
    const trimmed = trimBearerToken(stored)
    if (!isUsableBearerToken(trimmed)) throw new JubianError('AUTHENTICATION_REQUIRED')
    return trimmed
  }

  private async readBounded(response: Response): Promise<Uint8Array> {
    const reader = response.body?.getReader()
    if (!reader) throw new JubianError('CONTRACT_CHANGED')
    const chunks: Uint8Array[] = []
    let size = 0
    try {
      for (;;) {
        const chunk = await reader.read()
        if (chunk.done) break
        size += chunk.value.byteLength
        if (size > this.maximum) throw new JubianError('CONTRACT_CHANGED')
        chunks.push(chunk.value)
      }
    } catch (error) {
      await reader.cancel().catch(() => {})
      throw error instanceof JubianError ? error : new JubianError('NETWORK_ERROR')
    } finally { reader.releaseLock() }
    const merged = new Uint8Array(size)
    let offset = 0
    for (const chunk of chunks) { merged.set(chunk, offset); offset += chunk.byteLength }
    return merged
  }
}
