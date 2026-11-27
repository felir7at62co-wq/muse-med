/** Private Muse gateway transport for quoted video post-processing. */
import { brandString, type Branded } from '@deepseek-ai/dsh-brand'
import { HarnessError } from '@deepseek-ai/dsh-llm'
import { z } from 'zod'
import { museGatewayOrigin } from './gateway.ts'
import { readMuseSession } from './session.ts'

/** Opaque processing key issued by a Muse gateway preview. */
export type MuseMediaPostprocessJobKey = Branded<'MuseMediaPostprocessJobKey'>

/** One source and requested operation for a Muse gateway quote. */
export interface MuseMediaPostprocessInput {
  readonly operation: 'upscale' | 'erase_subtitle'
  readonly scriptId: number
  readonly taskId: number
  readonly videoUrl: string
  readonly resolution?: '720p' | '1080p'
}

const jobKey = z.string().regex(/^[a-f0-9]{64}$/u).transform(value => brandString<MuseMediaPostprocessJobKey>(value))
const preview = z.discriminatedUnion('state', [
  z.object({ state: z.literal('ineligible') }),
  z.object({ state: z.literal('ready'), jobKey, unit: z.literal('CNY'),
    amount: z.string().regex(/^(?:0|[1-9]\d{0,12})(?:\.\d{1,2})?$/u).refine(value => Number(value) > 0) }),
])
const gatewayCodes = new Set([
  'MEDIAKIT_INVALID_ARGUMENT', 'MEDIAKIT_AUTHENTICATION_REQUIRED', 'MEDIAKIT_PERMISSION_DENIED',
  'MEDIAKIT_RATE_LIMITED', 'MEDIAKIT_TRANSPORT', 'MEDIAKIT_INVALID_RESPONSE',
  'MEDIAKIT_TASK_CANCELED', 'MEDIAKIT_TASK_FAILED', 'MEDIAKIT_RESULT_ORIGIN_UNAPPROVED',
  'idempotency_conflict', 'submission_unconfirmed', 'query_unconfirmed', 'preview_mismatch',
])
const code = z.unknown().transform(value => typeof value === 'string' && gatewayCodes.has(value) ? value : undefined).optional()
const submission = z.object({ state: z.enum(['accepted', 'rejected', 'unknown', 'conflict']), code })
const fallbackClaim = z.object({ claimed: z.boolean() }).transform(result => result.claimed)
const status = z.discriminatedUnion('state', [
  z.object({ state: z.enum(['pending', 'failed', 'unknown', 'rejected', 'not_found']), code }),
  z.object({ state: z.literal('completed'), videoUrl: z.string().max(8192), downloadOrigin: z.string().max(512) })
    .refine(({ videoUrl, downloadOrigin }) => {
      const url = URL.parse(videoUrl)
      return url !== null && url.protocol === 'https:' && url.username === '' && url.password === ''
        && url.hash === '' && url.origin === downloadOrigin
    }),
])

/** Gateway eligibility and exact positive CNY reservation for one source. */
export type MuseMediaPostprocessPreview = z.output<typeof preview>
/** Acknowledgement of the original submission, without a supplier task ID. */
export type MuseMediaPostprocessSubmission = z.output<typeof submission>
/** Current account's job state. Completed output URLs are private to Host consumers. */
export type MuseMediaPostprocessStatus = z.output<typeof status>

/** Product gateway origin and private session location for one-request operations. */
export interface MuseMediaPostprocessOptions {
  readonly baseUrl: string
  readonly sessionFile: string
  readonly requestTimeoutMs: number
  readonly fetcher?: typeof fetch
}

/** Host request failure without provider text, request data or credentials. */
export class MuseMediaPostprocessError extends HarnessError {
  /** @param code - Stable category safe for caller diagnostics. */
  constructor(code: 'MEDIAKIT_SIGN_IN_REQUIRED' | 'MEDIAKIT_ACCOUNT_CHANGED' | 'MEDIAKIT_UNAVAILABLE' | 'MEDIAKIT_INVALID_RESPONSE') {
    super(`Muse video processing: ${code}`, code)
  }
}

// A job reply contains one bounded metadata record. Video never travels in this response.
const MAX_REPLY_BYTES = 16 * 1024
const MEDIA_POSTPROCESS_PATH = '/api/media-postprocess'

async function readReply(response: Response, signal: AbortSignal, cookie: string): Promise<unknown> {
  const reader = response.body?.getReader()
  if (reader === undefined) throw new MuseMediaPostprocessError('MEDIAKIT_INVALID_RESPONSE')
  const chunks: Uint8Array[] = []
  let bytes = 0
  const cancel = (): void => {
    void reader.cancel().catch((_error: unknown) => { /* A disconnected reader can already be closed. */ })
  }
  try {
    signal.addEventListener('abort', cancel, { once: true })
    signal.throwIfAborted()
    if (response.headers.get('content-type')?.split(';')[0]?.trim() !== 'application/json') {
      throw new MuseMediaPostprocessError('MEDIAKIT_INVALID_RESPONSE')
    }
    for (;;) {
      const chunk = await reader.read()
      signal.throwIfAborted()
      if (chunk.done) break
      bytes += chunk.value.byteLength
      if (bytes > MAX_REPLY_BYTES) throw new MuseMediaPostprocessError('MEDIAKIT_INVALID_RESPONSE')
      chunks.push(chunk.value)
    }
    const text = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, bytes))
    if (text.includes(cookie.slice('__Host-muse='.length))) throw new MuseMediaPostprocessError('MEDIAKIT_INVALID_RESPONSE')
    const value: unknown = JSON.parse(text)
    return value
  } catch (_error) {
    throw new MuseMediaPostprocessError('MEDIAKIT_INVALID_RESPONSE')
  } finally {
    signal.removeEventListener('abort', cancel)
    cancel()
    reader.releaseLock()
  }
}

function unconfirmed(error: MuseMediaPostprocessError): { state: 'unknown'; code: string } {
  return { state: 'unknown', code: error.code }
}

function requestFields({ operation, scriptId, taskId, videoUrl, resolution }: MuseMediaPostprocessInput) {
  return { operation, scriptId, taskId, videoUrl, resolution }
}

/** Host-only client for the authenticated Muse video-processing gateway. */
export class MuseMediaPostprocessClient {
  private readonly origin: string

  /** @param options - Gateway origin, private session file and request timeout. */
  constructor(private readonly options: MuseMediaPostprocessOptions) {
    this.origin = museGatewayOrigin(options.baseUrl)
  }

  /**
   * Obtain a free preview for one eligible input. A missing preview endpoint is ineligible.
   * @param input - Original source identities and desired processing.
   * @param signal - Caller cancellation.
   * @returns Eligibility and quote from the current account's gateway.
   */
  async preview(input: MuseMediaPostprocessInput, signal?: AbortSignal): Promise<MuseMediaPostprocessPreview> {
    return await this.request(preview, `${MEDIA_POSTPROCESS_PATH}/preview`, requestFields(input), signal,
      { absent: { state: 'ineligible' } })
  }

  /**
   * Send one approved submission. A transport or protocol failure leaves acceptance unknown.
   * @param input - Previewed source and its gateway job key.
   * @param signal - Cancels this request only.
   * @returns The gateway acknowledgement or a fixed unknown outcome for original-key recovery.
   */
  async submit(input: MuseMediaPostprocessInput & { readonly jobKey: MuseMediaPostprocessJobKey },
    signal?: AbortSignal): Promise<MuseMediaPostprocessSubmission> {
    return await this.request(submission, `${MEDIA_POSTPROCESS_PATH}/jobs`, { ...requestFields(input), jobKey: input.jobKey }, signal,
      { failure: unconfirmed })
  }

  /**
   * Read the current account's original receipt without resubmitting.
   * @param key - Original gateway job key.
   * @param signal - Caller cancellation.
   * @returns Safely projected state and, for completion only, a private exact-origin download.
   */
  async status(key: MuseMediaPostprocessJobKey, signal?: AbortSignal): Promise<MuseMediaPostprocessStatus> {
    return await this.request(status, `${MEDIA_POSTPROCESS_PATH}/jobs/${encodeURIComponent(key)}`, undefined, signal,
      { failure: unconfirmed })
  }

  /**
   * Claim permission for a single backup submission across all Desktop instances.
   * @param key - Key for the confirmed provider rejection.
   * @param signal - Caller cancellation.
   * @returns Whether this request received the only backup claim.
   */
  async claimFallback(key: MuseMediaPostprocessJobKey, signal?: AbortSignal): Promise<boolean> {
    return await this.request(fallbackClaim, `${MEDIA_POSTPROCESS_PATH}/jobs/${encodeURIComponent(key)}/fallback`, {}, signal, {})
  }

  private async request<Schema extends z.ZodType>(schema: Schema, endpoint: string, input: object | undefined,
    signal: AbortSignal | undefined, nonSuccess: {
      readonly absent?: z.output<Schema>
      readonly failure?: (error: MuseMediaPostprocessError) => z.output<Schema>
    }): Promise<z.output<Schema>> {
    const timeout = AbortSignal.timeout(this.options.requestTimeoutMs)
    const requestSignal = signal === undefined ? timeout : AbortSignal.any([timeout, signal])
    let response: Response | undefined
    try {
      requestSignal.throwIfAborted()
      const session = await readMuseSession(this.options.sessionFile, this.origin)
      requestSignal.throwIfAborted()
      if (session === null) throw new MuseMediaPostprocessError('MEDIAKIT_SIGN_IN_REQUIRED')
      response = await (this.options.fetcher ?? fetch)(new URL(endpoint, this.origin), {
        method: input === undefined ? 'GET' : 'POST', redirect: 'manual', signal: requestSignal,
        headers: { cookie: session.cookie, origin: this.origin, accept: 'application/json',
          ...(input === undefined ? {} : { 'content-type': 'application/json' }) },
        ...(input === undefined ? {} : { body: JSON.stringify(input) }),
      })
      const value = response.status === 200 ? await readReply(response, requestSignal, session.cookie) : undefined
      const current = await readMuseSession(this.options.sessionFile, this.origin)
      requestSignal.throwIfAborted()
      if (current?.revision !== session.revision) throw new MuseMediaPostprocessError('MEDIAKIT_ACCOUNT_CHANGED')
      if (response.status === 404 && nonSuccess.absent !== undefined) return nonSuccess.absent
      if (response.status === 401 || response.status === 303) throw new MuseMediaPostprocessError('MEDIAKIT_SIGN_IN_REQUIRED')
      if (response.status !== 200) throw new MuseMediaPostprocessError('MEDIAKIT_UNAVAILABLE')
      const result = schema.safeParse(value)
      if (!result.success) throw new MuseMediaPostprocessError('MEDIAKIT_INVALID_RESPONSE')
      return result.data
    } catch (error) {
      signal?.throwIfAborted()
      const failure = !timeout.aborted && error instanceof MuseMediaPostprocessError
        ? error : new MuseMediaPostprocessError('MEDIAKIT_UNAVAILABLE')
      if (nonSuccess.failure === undefined) throw failure
      return nonSuccess.failure(failure)
    } finally {
      if (!response?.bodyUsed) {
        try { await response?.body?.cancel() }
        catch (_error) { /* An unread body can already be disconnected. */ }
      }
    }
  }
}
