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
 * the provider adds never becomes an error here. What it does own is the
 * envelope: which layouts it accepts, which one it actually saw, and a redacted
 * description of the body when it could accept none — the description a tool
 * result carries instead of the payload, so "did not match the expected
 * envelope" says what arrived instead of only that something was wrong.
 */
import { createHash } from 'node:crypto'
import { isUsableBearerToken, trimBearerToken } from './credential.ts'
import { JubianDebugDump } from './debug-dump.ts'
import { describeBodyRejection, describeRejection, describeUnparsed, redactForDump } from './diagnostic.ts'
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
  /** Which envelope layout the body used, so a tolerated one stays visible. */
  envelope_layout: JubianEnvelopeLayout
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

/**
 * Which envelope layout one response body used.
 *
 * The first two are the provider's own documented layouts; the next four are
 * tolerated, because a reader cannot recover a payload the transport rejected,
 * and each is recorded on the response and in the debug dump so a layout
 * observed only in the field can be tightened to its own acceptance rule later.
 * The last two are the layouts this client refuses.
 */
export type JubianEnvelopeLayout =
  /** `{ code, data }`: the single-object layout. */
  | 'object-data'
  /** `{ code, total, rows }`, or any other object without `data`: the list layout. */
  | 'object-flat'
  /** `{ code, data: { code, data } }`: the payload is itself a success envelope. */
  | 'nested-envelope'
  /** `[ { code, data } ]`: one envelope wrapped in a one-element array. */
  | 'array-envelope'
  /** `[ payload ]`: one payload object wrapped in a one-element array. */
  | 'array-single'
  /** `[ … ]`: a bare array payload, with no envelope code to read. */
  | 'array-payload'
  /** A JSON object that carries no integer `code`. */
  | 'object-no-code'
  /** The body never became a JSON value. */
  | 'unparsed'

/** What one response body turned out to be, before any caller sees it. */
interface EnvelopeReading {
  layout: JubianEnvelopeLayout
  /** The application code, or null when the layout carried none. */
  code: number | null
  /** The payload a reader receives. */
  data: unknown
  /** Why this body is not an envelope this client accepts, or null when it is. */
  problem: string | null
}

/** Whether one value is a JSON object, which is what every envelope layout starts from. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** The integer application code of one candidate envelope object, or null. */
function envelopeCode(value: Record<string, unknown>): number | null {
  const code = value.code
  return typeof code === 'number' && Number.isSafeInteger(code) ? code : null
}

/**
 * Read one parsed body as an envelope.
 *
 * A bare top-level array is accepted as a payload because a reader, not this
 * transport, is what knows whether an array is readable; the response records
 * `application_code: null` for it, so a caller that needs the provider's own
 * success code still sees that none was there.
 * @param parsed - The parsed body, or undefined when it never parsed.
 * @param text - The strictly decoded body, or null when it was not valid UTF-8.
 * @param body - The exact response bytes.
 * @returns The layout, the application code when one was present, the payload and any reason it is unusable.
 */
function readEnvelope(parsed: unknown, text: string | null, body: Uint8Array): EnvelopeReading {
  if (isRecord(parsed)) return readEnvelopeObject(parsed, 'object')
  if (Array.isArray(parsed)) {
    const only: unknown = parsed.length === 1 ? parsed[0] : undefined
    if (isRecord(only)) return readEnvelopeObject(only, 'array')
    return { layout: 'array-payload', code: null, data: parsed, problem: null }
  }
  if (parsed === undefined) return { layout: 'unparsed', code: null, data: undefined,
    problem: describeBodyRejection(text, body) }
  return { layout: 'unparsed', code: null, data: undefined,
    problem: `expected a JSON object envelope, ${describeRejection(parsed)}` }
}

/** Read one candidate envelope object, wrapped or not, as an envelope. */
function readEnvelopeObject(candidate: Record<string, unknown>, wrapper: 'object' | 'array'): EnvelopeReading {
  const code = envelopeCode(candidate)
  const hasData = Object.hasOwn(candidate, 'data')
  if (code === null) {
    if (wrapper === 'array') {
      // A one-element array may be the payload itself rather than an envelope;
      // only a candidate that states its own code is read as one.
      return { layout: 'array-single', code: null, data: candidate, problem: null }
    }
    return { layout: 'object-no-code', code: null, data: undefined,
      problem: `envelope carries no integer code, ${describeRejection(candidate)}` }
  }
  // Two envelope shapes are live on this provider: a single-object endpoint
  // nests its payload under `data`, while the list endpoints carry `total` and
  // `rows` at the top level and have no `data` at all. Both are handed to the
  // reader as one object, so a reader never has to know which shape it got.
  if (!hasData) {
    return { layout: wrapper === 'array' ? 'array-envelope' : 'object-flat', code,
      data: Object.fromEntries(Object.entries(candidate).filter(([key]) => key !== 'msg')), problem: null }
  }
  // A payload that is itself a success envelope costs a reader every field it
  // asked for, so the second wrapper is unwrapped too — but only when the inner
  // object states a success code, which is what tells an envelope from a
  // business payload that happens to carry `code` and `data` fields.
  const inner = candidate.data
  const innerCode = isRecord(inner) && Object.hasOwn(inner, 'data') ? envelopeCode(inner) : null
  if (innerCode === 0 || innerCode === 200) {
    return { layout: 'nested-envelope', code, data: (inner as Record<string, unknown>).data, problem: null }
  }
  return { layout: wrapper === 'array' ? 'array-envelope' : 'object-data', code, data: inner, problem: null }
}

function hash(bytes: Uint8Array): string {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`
}

/** Decode one body as strict UTF-8, or null when it is not valid UTF-8. */
function decodeStrict(bytes: Uint8Array): string | null {
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes) }
  catch { return null }
}

/** Parse one decoded body, or undefined when it is not JSON. */
function parseJson(text: string): unknown {
  try { return JSON.parse(text) }
  catch { return undefined }
}

// Node fetch wraps transport errors in one cause. Never inspect messages or recurse into arbitrary causes.
function transportDetail(error: unknown): string | undefined {
  if (error === null || typeof error !== 'object') return undefined
  if ('name' in error && error.name === 'TimeoutError') return 'request timed out'
  if ('name' in error && error.name === 'AbortError') return 'request aborted'
  if (!('code' in error)) return undefined
  switch (error.code) {
    case 'ENOTFOUND': return 'DNS lookup failed (ENOTFOUND)'
    case 'EAI_AGAIN': return 'DNS lookup failed (EAI_AGAIN)'
    case 'ECONNREFUSED': return 'connection refused (ECONNREFUSED)'
    case 'ECONNRESET': return 'connection reset (ECONNRESET)'
    case 'ETIMEDOUT': return 'request timed out (ETIMEDOUT)'
    case 'UND_ERR_CONNECT_TIMEOUT': return 'connection timed out (UND_ERR_CONNECT_TIMEOUT)'
    case 'UND_ERR_HEADERS_TIMEOUT': return 'response headers timed out (UND_ERR_HEADERS_TIMEOUT)'
    case 'UND_ERR_BODY_TIMEOUT': return 'response body timed out (UND_ERR_BODY_TIMEOUT)'
    case 'ERR_TLS_CERT_ALTNAME_INVALID': return 'TLS certificate rejected (ERR_TLS_CERT_ALTNAME_INVALID)'
    case 'CERT_HAS_EXPIRED': return 'TLS certificate rejected (CERT_HAS_EXPIRED)'
    case 'DEPTH_ZERO_SELF_SIGNED_CERT': return 'TLS certificate rejected (DEPTH_ZERO_SELF_SIGNED_CERT)'
    case 'UNABLE_TO_VERIFY_LEAF_SIGNATURE': return 'TLS certificate rejected (UNABLE_TO_VERIFY_LEAF_SIGNATURE)'
    case 'ABORT_ERR': return 'request aborted'
    default: return undefined
  }
}

function networkFailure(error: unknown, signal: AbortSignal, timeout: AbortSignal): JubianError {
  const detail = signal.aborted
    ? timeout.aborted && signal.reason === timeout.reason ? 'request timed out' : 'request aborted'
    : transportDetail(error) ?? transportDetail(
      error !== null && typeof error === 'object' && 'cause' in error ? error.cause : undefined,
    )
  return new JubianError('NETWORK_ERROR', detail)
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
   * @returns Transport evidence, the response hash, the envelope layout and the envelope's data.
   * @throws {JubianError} With a stable code and either a numeric HTTP status, an allowlisted local
   *   transport detail, or a redacted description of the body's structure. Provider text, URLs,
   *   tokens and original causes are never attached. Failures are not retried.
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
    } catch (error) { throw networkFailure(error, signal, timeout) }
    if (!response.ok) {
      await response.body?.cancel().catch(() => {})
      throw new JubianError(codeForHttpStatus(response.status), `HTTP ${response.status}`)
    }
    const bytes = await this.readBounded(response, signal, timeout)
    const response_sha256 = hash(bytes)
    const text = decodeStrict(bytes)
    const parsed = text === null ? undefined : parseJson(text)
    const reading = readEnvelope(parsed, text, bytes)
    const dump = JubianDebugDump.fromEnvironment()
    if (dump !== null) {
      await dump.record({ method: request.method, path: request.path, http_status: response.status,
        application_code: reading.code, envelope_layout: reading.layout, response_sha256,
        bytes: bytes.byteLength,
        body: parsed === undefined ? describeUnparsed(text, bytes) : redactForDump(parsed) })
    }
    if (reading.problem !== null) throw new JubianError('CONTRACT_CHANGED', reading.problem)
    if (reading.code !== null) {
      const failure = failureForEnvelopeCode(reading.code)
      if (failure !== null) {
        throw new JubianError(failure, failure === 'CONTRACT_CHANGED'
          ? `unmapped envelope code ${reading.code}, ${describeRejection(parsed)}` : undefined)
      }
    }
    return { transport: { http_status: response.status, application_code: reading.code },
      response_sha256, envelope_layout: reading.layout, data: reading.data }
  }

  private async resolveToken(): Promise<string> {
    let stored: string
    try { stored = await this.credential() } catch { throw new JubianError('AUTHENTICATION_REQUIRED') }
    const trimmed = trimBearerToken(stored)
    if (!isUsableBearerToken(trimmed)) throw new JubianError('AUTHENTICATION_REQUIRED')
    return trimmed
  }

  private async readBounded(response: Response, signal: AbortSignal, timeout: AbortSignal): Promise<Uint8Array> {
    const reader = response.body?.getReader()
    if (!reader) throw new JubianError('CONTRACT_CHANGED', 'response body is not readable')
    const chunks: Uint8Array[] = []
    let size = 0
    try {
      for (;;) {
        const chunk = await reader.read()
        if (chunk.done) break
        size += chunk.value.byteLength
        if (size > this.maximum) {
          throw new JubianError('CONTRACT_CHANGED', `response body exceeded the ${this.maximum}-byte cap`)
        }
        chunks.push(chunk.value)
      }
    } catch (error) {
      await reader.cancel().catch(() => {})
      throw error instanceof JubianError ? error : networkFailure(error, signal, timeout)
    } finally { reader.releaseLock() }
    const merged = new Uint8Array(size)
    let offset = 0
    for (const chunk of chunks) { merged.set(chunk, offset); offset += chunk.byteLength }
    return merged
  }
}
