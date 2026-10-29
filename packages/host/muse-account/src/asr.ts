/** Host-only cloud transcription client using the saved MUSE account session. */
import { openAsBlob } from 'node:fs'
import { readMuseSession } from './session.ts'

/** Transcription use chosen by the caller; the gateway owns the recognition service. */
export type MuseAsrPurpose = 'subtitles' | 'screenplay'

/** Bounded status returned by the account gateway, with optional safe routing metadata. */
export type MuseAsrJob = MuseAsrMetadata & {
  readonly id: string
  readonly status: 'preparing' | 'processing' | 'submitting' | 'uncertain' | 'complete' | 'silent' | 'failed'
  readonly purpose?: MuseAsrPurpose
  readonly retentionExpired?: boolean
  readonly segments?: readonly MuseAsrSegment[]
}

/** Safe gateway recovery instructions; no credential or provider response body is retained. */
export interface MuseAsrMetadata {
  readonly service_version?: 'flash' | 'standard-v1' | 'standard-v2'
  readonly queued?: boolean
  readonly error_code?: 'provider_rejected' | 'provider_unavailable' | 'storage_unavailable' | 'account_channel_blocked'
  readonly provider_diagnostic?: {
    readonly reason?: 'timeout' | 'transport' | 'http' | 'response' | 'json' | 'result' | 'audio'
    readonly operation?: 'submit' | 'query' | 'flash'
    readonly http_status?: number
    readonly provider_code?: string
  }
  readonly recovery?: {
    readonly capability: 'query_original_task' | 'no_query' | 'none'
    readonly next_action: 'poll_original' | 'wait' | 'inspect_receipt' | 'use_result' | 'resume_upload'
    readonly automatic_resubmit: false
    /** The supplier denied the whole credential: retrying cannot resolve it. */
    readonly account_channel_blocked?: true
  }
}

/**
 * Validate and retain only safe routing and recovery fields from a gateway response or receipt.
 * @param row - Parsed JSON object with optional gateway metadata.
 * @returns Validated metadata; unknown response fields are omitted.
 */
export function parseMuseAsrMetadata(row: Record<string, unknown>): MuseAsrMetadata {
  const { service_version, queued, error_code, provider_diagnostic, recovery } = row
  if ((service_version !== undefined && (typeof service_version !== 'string' || !['flash', 'standard-v1', 'standard-v2'].includes(service_version)))
    || (queued !== undefined && typeof queued !== 'boolean')
    || (error_code !== undefined && (typeof error_code !== 'string' || !['provider_rejected', 'provider_unavailable', 'storage_unavailable', 'account_channel_blocked'].includes(error_code)))) {
    throw new MuseAsrError('response-invalid')
  }
  let diagnostic: MuseAsrMetadata['provider_diagnostic']
  if (provider_diagnostic !== undefined) {
    if (typeof provider_diagnostic !== 'object' || provider_diagnostic === null || Array.isArray(provider_diagnostic)) throw new MuseAsrError('response-invalid')
    const { reason, operation, http_status, provider_code } = provider_diagnostic as Record<string, unknown>
    if ((reason !== undefined && (typeof reason !== 'string' || !['timeout', 'transport', 'http', 'response', 'json', 'result', 'audio'].includes(reason)))
      || (operation !== undefined && (typeof operation !== 'string' || !['submit', 'query', 'flash'].includes(operation)))
      || (http_status !== undefined && (typeof http_status !== 'number' || !Number.isInteger(http_status) || http_status < 100 || http_status > 599))
      || (provider_code !== undefined && (typeof provider_code !== 'string' || !/^\d{5,10}$/.test(provider_code)))) throw new MuseAsrError('response-invalid')
    diagnostic = {
      ...(reason === undefined ? {} : { reason: reason as NonNullable<NonNullable<MuseAsrMetadata['provider_diagnostic']>['reason']> }),
      ...(operation === undefined ? {} : { operation: operation as NonNullable<NonNullable<MuseAsrMetadata['provider_diagnostic']>['operation']> }),
      ...(http_status === undefined ? {} : { http_status }),
      ...(provider_code === undefined ? {} : { provider_code }),
    }
  }
  let instruction: MuseAsrMetadata['recovery']
  if (recovery !== undefined) {
    if (typeof recovery !== 'object' || recovery === null || Array.isArray(recovery)) throw new MuseAsrError('response-invalid')
    const { capability, next_action, automatic_resubmit, account_channel_blocked: blocked } = recovery as Record<string, unknown>
    if (typeof capability !== 'string' || !['query_original_task', 'no_query', 'none'].includes(capability)
      || typeof next_action !== 'string' || !['poll_original', 'wait', 'inspect_receipt', 'use_result', 'resume_upload'].includes(next_action)
      || automatic_resubmit !== false
      || (blocked !== undefined && blocked !== true)) throw new MuseAsrError('response-invalid')
    instruction = { capability: capability as NonNullable<MuseAsrMetadata['recovery']>['capability'],
      next_action: next_action as NonNullable<MuseAsrMetadata['recovery']>['next_action'], automatic_resubmit,
      ...(blocked === undefined ? {} : { account_channel_blocked: true as const }) }
  }
  return {
    ...(service_version === undefined ? {} : { service_version: service_version as NonNullable<MuseAsrMetadata['service_version']> }),
    ...(queued === undefined ? {} : { queued }),
    ...(error_code === undefined ? {} : { error_code: error_code as NonNullable<MuseAsrMetadata['error_code']> }),
    ...(diagnostic === undefined ? {} : { provider_diagnostic: diagnostic }),
    ...(instruction === undefined ? {} : { recovery: instruction }),
  }
}

/** A sentence with optional recognized words, timed in seconds from the submitted audio start. */
export interface MuseAsrSegment {
  readonly start: number
  readonly end: number
  readonly text: string
  /** Provider-local speaker identity; it does not establish a screenplay character name. */
  readonly speaker_id?: string
  readonly words?: readonly { readonly start: number; readonly end: number; readonly text: string }[]
}

function validSpan(value: unknown): value is { start: number; end: number; text: string } {
  if (typeof value !== 'object' || value === null) return false
  const span = value as Record<string, unknown>
  return typeof span.start === 'number' && Number.isFinite(span.start) && span.start >= 0
    && typeof span.end === 'number' && Number.isFinite(span.end) && span.end > span.start
    && typeof span.text === 'string'
}

function validSegments(value: unknown): boolean {
  if (!Array.isArray(value) || value.length === 0) return false
  let previous = 0
  return value.every((row: unknown) => {
    if (!validSpan(row) || row.start < previous) return false
    previous = row.start
    const speaker = (row as Record<string, unknown>).speaker_id
    if (speaker !== undefined && (typeof speaker !== 'string' || speaker.trim().length === 0)) return false
    const words = (row as Record<string, unknown>).words
    if (words === undefined) return true
    if (!Array.isArray(words)) return false
    let cursor = row.start
    return words.every((word: unknown) => {
      if (!validSpan(word) || word.start < cursor || word.end > row.end) return false
      cursor = word.start
      return true
    })
  })
}

/** Fixed failure classes without upstream response bodies or signed object URLs. */
export class MuseAsrError extends Error {
  constructor(readonly code: 'sign-in-required' | 'server-unavailable' | 'server-not-configured' | 'job-not-found' | 'request-rejected' | 'response-invalid'
    | 'server_draining' | 'queue_full' | 'upload_busy' | 'request_rate' | 'provider_rate' | 'daily_quota' | 'idempotency_conflict', readonly retryAfterSeconds?: number) {
    super(`MUSE cloud transcription: ${code}`)
  }
}

function retryAfterSeconds(response: Response): number | undefined {
  const seconds = response.headers.get('retry-after')
  return seconds !== null && /^\d+$/.test(seconds) && Number.isSafeInteger(Number(seconds)) ? Number(seconds) : undefined
}

async function rejection(response: Response): Promise<MuseAsrError> {
  let value: unknown
  try { value = await response.json() }
  catch { return new MuseAsrError('request-rejected') }
  const code = typeof value === 'object' && value !== null && 'error_code' in value ? value.error_code : undefined
  if (response.status === 429 && (code === 'queue_full' || code === 'upload_busy' || code === 'request_rate' || code === 'provider_rate' || code === 'daily_quota')) {
    return new MuseAsrError(code, retryAfterSeconds(response))
  }
  if (response.status === 503 && code === 'server_draining') return new MuseAsrError(code, retryAfterSeconds(response))
  if (response.status === 409 && code === 'idempotency_conflict') return new MuseAsrError(code)
  return new MuseAsrError('request-rejected')
}

/** Current gateway origin and the same product-home session used by knowledge-base reads. */
export interface MuseAsrOptions {
  readonly baseUrl: string
  readonly sessionFile: string
  readonly requestTimeoutMs: number
  readonly fetcher?: typeof fetch
}

/** Submit or query by one caller-persisted UUID; no provider credential reaches the Host. */
export class MuseAsrClient {
  constructor(private readonly options: MuseAsrOptions) {}

  private async request(path: string, init: RequestInit, signal?: AbortSignal): Promise<MuseAsrJob> {
    signal?.throwIfAborted()
    const session = await readMuseSession(this.options.sessionFile, this.options.baseUrl)
    signal?.throwIfAborted()
    if (session === null) throw new MuseAsrError('sign-in-required')
    let response: Response
    try {
      const headers = new Headers(init.headers)
      headers.set('cookie', session.cookie)
      response = await (this.options.fetcher ?? fetch)(new URL(path, this.options.baseUrl), {
        ...init, headers, redirect: 'manual',
        signal: signal === undefined ? AbortSignal.timeout(this.options.requestTimeoutMs)
          : AbortSignal.any([signal, AbortSignal.timeout(this.options.requestTimeoutMs)]),
      })
    } catch {
      signal?.throwIfAborted()
      throw new MuseAsrError('server-unavailable')
    }
    try {
      signal?.throwIfAborted()
      if (response.status === 303 || response.status === 401) throw new MuseAsrError('sign-in-required')
      if (response.status === 404 && init.method === 'GET') throw new MuseAsrError('job-not-found')
      if (response.status === 503 && retryAfterSeconds(response) !== undefined) {
        const error = await rejection(response)
        throw error.code === 'server_draining' ? error : new MuseAsrError('server-unavailable', retryAfterSeconds(response))
      }
      if (response.status === 404 || response.status === 405 || response.status === 503) throw new MuseAsrError('server-not-configured')
      if (!response.ok) throw await rejection(response)
      let value: unknown
      try { value = await response.json() } catch { throw new MuseAsrError('response-invalid') }
      if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new MuseAsrError('response-invalid')
      const job = value as Record<string, unknown>
      if (typeof job.id !== 'string' || !/^[0-9a-f-]{36}$/i.test(job.id)
        || !['preparing', 'processing', 'submitting', 'uncertain', 'complete', 'silent', 'failed'].includes(String(job.status))
        || (job.purpose !== undefined && job.purpose !== 'subtitles' && job.purpose !== 'screenplay')
        || (job.service_version !== undefined && job.service_version !== 'flash' && job.service_version !== 'standard-v1' && job.service_version !== 'standard-v2')
        || (job.retentionExpired !== undefined && typeof job.retentionExpired !== 'boolean')) {
        throw new MuseAsrError('response-invalid')
      }
      if (job.status === 'complete' && !validSegments(job.segments)) throw new MuseAsrError('response-invalid')
      signal?.throwIfAborted()
      return {
        id: job.id, status: job.status as MuseAsrJob['status'],
        ...(job.purpose === undefined ? {} : { purpose: job.purpose }),
        ...parseMuseAsrMetadata(job),
        ...(job.retentionExpired === undefined ? {} : { retentionExpired: job.retentionExpired }),
        ...(job.status === 'complete' ? { segments: job.segments as readonly MuseAsrSegment[] } : {}),
      }
    } catch (error) {
      signal?.throwIfAborted()
      throw error
    } finally {
      if (response.body !== null && !response.bodyUsed) {
        try { await response.body.cancel() }
        catch (_error) { /* The transport may have already errored its aborted body. */ }
      }
    }
  }

  /**
   * Make one billable attempt under a caller-persisted key.
   * @param file - Staged local audio.
   * @param id - Durable idempotency UUID.
   * @param sha256 - Digest verified by the gateway.
   * @param language - Recognition language.
   * @param purpose - Persisted transcription use; omission retains legacy gateway routing.
   * @param signal - Caller cancellation; awaited transport/body settlement preserves its reason.
   * @returns Account-scoped job status.
   */
  async submit(file: string, id: string, sha256: string, language: 'zh' | 'auto', purpose?: MuseAsrPurpose, signal?: AbortSignal): Promise<MuseAsrJob> {
    signal?.throwIfAborted()
    const init: RequestInit & { duplex: 'half' } = {
      method: 'POST', headers: { origin: this.options.baseUrl, 'content-type': file.toLowerCase().endsWith('.wav') ? 'audio/wav' : 'audio/mpeg',
        'idempotency-key': id, 'x-audio-sha256': sha256, 'x-audio-language': language,
        ...(purpose === undefined ? {} : { 'x-muse-asr-purpose': purpose }) },
      body: await openAsBlob(file), duplex: 'half',
    }
    return await this.request('/api/asr/jobs', init, signal)
  }

  /**
   * Read a previously submitted job; this never starts a new provider request.
   * @param id - Durable idempotency UUID.
   * @param signal - Caller cancellation; awaited transport/body settlement preserves its reason.
   * @returns Account-scoped job status.
   */
  async get(id: string, signal?: AbortSignal): Promise<MuseAsrJob> {
    return await this.request(`/api/asr/jobs/${encodeURIComponent(id)}`, { method: 'GET' }, signal)
  }
}
