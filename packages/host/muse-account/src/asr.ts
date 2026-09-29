/** Host-only cloud transcription client using the saved MUSE account session. */
import { openAsBlob } from 'node:fs'
import { readMuseSession } from './session.ts'

/** Bounded status returned by the account gateway. */
export type MuseAsrJob = { readonly id: string; readonly status: 'preparing' | 'processing' | 'submitting' | 'uncertain' | 'complete' | 'silent' | 'failed'; readonly retentionExpired?: boolean; readonly segments?: readonly MuseAsrSegment[] }

/** A sentence with optional recognized words, timed in seconds from the submitted audio start. */
export interface MuseAsrSegment {
  readonly start: number
  readonly end: number
  readonly text: string
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
  constructor(readonly code: 'sign-in-required' | 'server-unavailable' | 'server-not-configured' | 'job-not-found' | 'request-rejected' | 'response-invalid') {
    super(`MUSE cloud transcription: ${code}`)
  }
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
    if (response.status === 404 || response.status === 405 || response.status === 503) throw new MuseAsrError('server-not-configured')
    if (!response.ok) throw new MuseAsrError('request-rejected')
    let value: unknown
    try { value = await response.json() } catch { throw new MuseAsrError('response-invalid') }
    if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new MuseAsrError('response-invalid')
    const job = value as Record<string, unknown>
    if (typeof job.id !== 'string' || !/^[0-9a-f-]{36}$/i.test(job.id)
      || !['preparing', 'processing', 'submitting', 'uncertain', 'complete', 'silent', 'failed'].includes(String(job.status))
      || (job.retentionExpired !== undefined && typeof job.retentionExpired !== 'boolean')) {
      throw new MuseAsrError('response-invalid')
    }
    if (job.status === 'complete' && !validSegments(job.segments)) throw new MuseAsrError('response-invalid')
    return job as MuseAsrJob
  }

  /**
   * Make one billable attempt under a caller-persisted key.
   * @param file - Staged local audio.
   * @param id - Durable idempotency UUID.
   * @param sha256 - Digest verified by the gateway.
   * @param language - Recognition language.
   * @returns Account-scoped job status.
   */
  async submit(file: string, id: string, sha256: string, language: 'zh' | 'auto'): Promise<MuseAsrJob> {
    const init: RequestInit & { duplex: 'half' } = {
      method: 'POST', headers: { origin: this.options.baseUrl, 'content-type': file.toLowerCase().endsWith('.wav') ? 'audio/wav' : 'audio/mpeg',
        'idempotency-key': id, 'x-audio-sha256': sha256, 'x-audio-language': language },
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
