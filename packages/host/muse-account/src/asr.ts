/** Host-only cloud transcription client using the saved MUSE account session. */
import { openAsBlob } from 'node:fs'
import { readMuseSession } from './session.ts'

/** Transcription use chosen by the caller; the gateway owns the recognition service. */
export type MuseAsrPurpose = 'subtitles' | 'screenplay'

/** Bounded status returned by the account gateway, with optional safe routing metadata. */
export type MuseAsrJob = {
  readonly id: string
  readonly status: 'preparing' | 'processing' | 'submitting' | 'uncertain' | 'complete' | 'silent' | 'failed'
  readonly purpose?: MuseAsrPurpose
  readonly service_version?: 'flash' | 'standard-v1' | 'standard-v2'
  readonly retentionExpired?: boolean
  readonly segments?: readonly MuseAsrSegment[]
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
    | 'queue_full' | 'upload_busy' | 'request_rate' | 'provider_rate' | 'daily_quota' | 'idempotency_conflict', readonly retryAfterSeconds?: number) {
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

  private async request(path: string, init: RequestInit): Promise<MuseAsrJob> {
    const session = await readMuseSession(this.options.sessionFile, this.options.baseUrl)
    if (session === null) throw new MuseAsrError('sign-in-required')
    let response: Response
    try {
      const headers = new Headers(init.headers)
      headers.set('cookie', session.cookie)
      response = await (this.options.fetcher ?? fetch)(new URL(path, this.options.baseUrl), {
        ...init, headers, redirect: 'manual',
        signal: AbortSignal.timeout(this.options.requestTimeoutMs),
      })
    } catch { throw new MuseAsrError('server-unavailable') }
    if (response.status === 303 || response.status === 401) throw new MuseAsrError('sign-in-required')
    if (response.status === 404 && init.method === 'GET') throw new MuseAsrError('job-not-found')
    if (response.status === 503 && retryAfterSeconds(response) !== undefined) throw new MuseAsrError('server-unavailable', retryAfterSeconds(response))
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
    return {
      id: job.id, status: job.status as MuseAsrJob['status'],
      ...(job.purpose === undefined ? {} : { purpose: job.purpose }),
      ...(job.service_version === undefined ? {} : { service_version: job.service_version }),
      ...(job.retentionExpired === undefined ? {} : { retentionExpired: job.retentionExpired }),
      ...(job.status === 'complete' ? { segments: job.segments as readonly MuseAsrSegment[] } : {}),
    }
  }

  /**
   * Make one billable attempt under a caller-persisted key.
   * @param file - Staged local audio.
   * @param id - Durable idempotency UUID.
   * @param sha256 - Digest verified by the gateway.
   * @param language - Recognition language.
   * @param purpose - Persisted transcription use; omission retains legacy gateway routing.
   * @returns Account-scoped job status.
   */
  async submit(file: string, id: string, sha256: string, language: 'zh' | 'auto', purpose?: MuseAsrPurpose): Promise<MuseAsrJob> {
    const init: RequestInit & { duplex: 'half' } = {
      method: 'POST', headers: { origin: this.options.baseUrl, 'content-type': file.toLowerCase().endsWith('.wav') ? 'audio/wav' : 'audio/mpeg',
        'idempotency-key': id, 'x-audio-sha256': sha256, 'x-audio-language': language,
        ...(purpose === undefined ? {} : { 'x-muse-asr-purpose': purpose }) },
      body: await openAsBlob(file), duplex: 'half',
    }
    return await this.request('/api/asr/jobs', init)
  }

  /**
   * Read a previously submitted job; this never starts a new provider request.
   * @param id - Durable idempotency UUID.
   * @returns Account-scoped job status.
   */
  async get(id: string): Promise<MuseAsrJob> {
    return await this.request(`/api/asr/jobs/${encodeURIComponent(id)}`, { method: 'GET' })
  }
}
