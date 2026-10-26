/** Per-request Zhipu credentials remain in memory and never enter Session events. */
import type { StreamChunk } from '@deepseek-ai/dsh-llm'
import { LlmError } from '@deepseek-ai/dsh-llm'
import { z } from 'zod'
import { brandString, type Branded } from '@deepseek-ai/dsh-brand'
import { readMuseSession } from './session.ts'

const leaseSchema = z.object({
  id: z.uuid().transform(value => brandString<Branded<'MuseModelLeaseId'>>(value)),
  baseURL: z.url().refine((value) => {
    const url = new URL(value)
    return !url.username && !url.password && !url.search && !url.hash
      && (url.protocol === 'https:' || url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname))
  }),
  apiKey: z.string().min(1).max(4096).regex(/^[\x21-\x7e]+$/),
  deadline: z.number().int().positive(), requestMs: z.number().int().min(1000).max(7200000),
  checkMs: z.number().int().min(1000).max(60000),
})

/** Login and transport captured by the prepared model call. */
export interface DirectModelOptions {
  readonly baseUrl: string
  readonly sessionFile: string
  readonly revision: string
  readonly requestTimeoutMs: number
  readonly fetcher?: typeof fetch
}

function interruptedAccess(signal: AbortSignal): LlmError {
  return signal.aborted
    ? new LlmError('Muse model request cancelled', 'ABORTED')
    : new LlmError('Muse model access could not be confirmed', 'MODEL_ACCESS_UNCERTAIN')
}

/** Acquire once, stream directly, check login liveness and release after supplier teardown.
 * @param options - Current gateway and captured login revision.
 * @param model - Catalog-authorized supplier model.
 * @param signal - Caller cancellation and account authorization lifetime.
 * @param stream - Supplier stream factory receiving only this call's temporary credential.
 * @returns Model chunks with distinct non-retryable lease-check and deadline
 *   failures; ambiguous admission failures never enable automatic retry.
 */
export async function* streamWithModelLease(
  options: DirectModelOptions, model: string, signal: AbortSignal,
  stream: (access: { baseURL: string; apiKey: string }, signal: AbortSignal) => AsyncIterable<StreamChunk>,
): AsyncGenerator<StreamChunk> {
  const session = await readMuseSession(options.sessionFile, options.baseUrl)
  if (!session || session.revision !== options.revision) throw new LlmError('Please sign in to Muse', 'MISSING_CREDENTIAL')
  const headers = { cookie: session.cookie, origin: options.baseUrl, 'content-type': 'application/json',
    'x-muse-model-access': 'direct-v1', 'x-muse-provider-routing': 'mixed-v1', 'x-muse-zhipu-direct': 'leased-v1' }
  const path = '/api/desktop-models/zhipu-official/leases'
  const request = async (suffix: string, method: string, requestSignal: AbortSignal, body?: string): Promise<Response> => {
    let response: Response
    try {
      response = await (options.fetcher ?? fetch)(new URL(path + suffix, options.baseUrl), {
        method, headers, redirect: 'error', signal: requestSignal, ...(body === undefined ? {} : { body }),
      })
    } catch (_error) { throw interruptedAccess(requestSignal) }
    if (!response.ok) {
      const status = response.status
      const code = status === 401 || status === 403 ? 'AUTH' : status === 429 ? 'RATE_LIMIT'
        : status >= 500 ? 'SERVER' : 'INVALID_REQUEST'
      const retryAfter = response.headers.get('retry-after')
      const delay = retryAfter === null ? NaN : /^\d+(?:\.\d+)?$/u.test(retryAfter)
        ? Number(retryAfter) * 1000 : Date.parse(retryAfter) - Date.now()
      const failure = new LlmError('Muse model admission rejected', code, { status,
        ...(Number.isFinite(delay) && delay > 0 ? { providerRetryAfterMs: delay } : {}),
      })
      try { await response.body?.cancel() }
      catch (_cleanupError) { /* The HTTP refusal remains authoritative. */ }
      throw failure
    }
    return response
  }
  try { signal.throwIfAborted() }
  catch (_error) { throw interruptedAccess(signal) }
  // Admission may wait for the server's bounded queue; the caller owns cancellation.
  const started = performance.now()
  const acquired = await request('', 'POST', signal, JSON.stringify({ model }))
  let text: string
  try { text = await acquired.text() }
  catch (_error) { throw interruptedAccess(signal) }
  if (text.length > 8192) throw new LlmError('Invalid Muse model access', 'INVALID_CONFIG')
  let value: unknown
  try { value = JSON.parse(text) }
  catch (_error) { throw new LlmError('Invalid Muse model access', 'INVALID_CONFIG') }
  const parsed = leaseSchema.safeParse(value)
  if (!parsed.success) throw new LlmError('Invalid Muse model access', 'INVALID_CONFIG')
  const lease = parsed.data
  const controller = new AbortController()
  const remainingMs = Math.max(1, Math.ceil(lease.requestMs - (performance.now() - started)))
  const deadline = AbortSignal.timeout(remainingMs)
  const combined = AbortSignal.any([signal, controller.signal, deadline])
  let timer: ReturnType<typeof setTimeout> | undefined
  let checking = Promise.resolve()
  let done = false
  let accessFailure: LlmError | undefined
  const interruption = (): LlmError | undefined => signal.aborted ? undefined
    : accessFailure ?? (deadline.aborted
      ? new LlmError('Muse model request reached its access deadline', 'MODEL_REQUEST_DEADLINE') : undefined)
  const check = (): void => {
    timer = setTimeout(() => {
      checking = (async () => {
        try {
          const current = await readMuseSession(options.sessionFile, options.baseUrl)
          if (current?.revision !== options.revision) throw new Error('Muse login changed')
          const response = await request('/' + lease.id, 'GET', AbortSignal.any([combined, AbortSignal.timeout(options.requestTimeoutMs)]))
          await response.arrayBuffer()
        } catch (error) {
          if (!combined.aborted) {
            accessFailure = new LlmError('Muse model access check failed', 'MODEL_ACCESS_CHECK_FAILED',
              error instanceof LlmError ? {
                ...error.failure.status === undefined ? {} : { status: error.failure.status },
                ...error.failure.providerRetryAfterMs === undefined ? {} : { providerRetryAfterMs: error.failure.providerRetryAfterMs },
              } : undefined)
          }
          controller.abort()
        }
        if (!done && !combined.aborted) check()
      })()
    }, lease.checkMs)
    timer.unref()
  }
  try {
    const current = await readMuseSession(options.sessionFile, options.baseUrl)
    if (current?.revision !== options.revision) throw new LlmError('Muse login changed', 'MISSING_CREDENTIAL')
    try { combined.throwIfAborted() }
    catch (error) {
      if (signal.aborted) throw interruptedAccess(signal)
      throw interruption() ?? error
    }
    check()
    for await (const chunk of stream({ baseURL: lease.baseURL, apiKey: lease.apiKey }, combined)) {
      const failure = interruption()
      if (failure !== undefined && chunk.type === 'finish'
        && (chunk.reason.kind === 'error' || chunk.reason.kind === 'aborted')) {
        yield { ...chunk, reason: { kind: 'error', failure: failure.failure } }
      } else yield chunk
    }
  } catch (error) {
    throw interruption() ?? error
  } finally {
    done = true
    clearTimeout(timer)
    controller.abort()
    await checking
    try {
      const response = await request('/' + lease.id, 'DELETE', AbortSignal.timeout(options.requestTimeoutMs))
      await response.arrayBuffer()
    }
    catch (_error) { /* The server retains this reservation until its persisted deadline. */ }
  }
}
