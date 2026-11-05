/** Request-local Muse diagnostics contain routing and counters, never model content or credentials. */
import { AsyncLocalStorage } from 'node:async_hooks'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import type { GenerateOptions, StreamChunk, TokenUsage } from '@deepseek-ai/dsh-llm'
import type { PiAiRequestHeaderContext } from '@deepseek-ai/dsh-llm-pi-ai'
import { brandString, type Branded } from '@deepseek-ai/dsh-brand'

const clientHeader = 'x-muse-client-request-id'
const responseSchema = z.object({ kind: z.literal('pi-ai'), version: z.literal(2),
  responseId: z.string().optional(), responseModel: z.string().optional(),
  stopReason: z.enum(['stop', 'length', 'toolUse', 'error', 'aborted']).optional() })

/** Content-free receipt for one consumed adapter stream; stop is the Harness-normalized reason. */
export interface MuseModelRequestMetadata {
  event: 'model_client_request_metadata'
  phase: 'start' | 'finish'
  client_request_id: Branded<'MuseClientRequestId'>
  session_id: string | null
  provider: string
  model: string
  purpose: string | null
  outcome?: 'finished' | 'exhausted' | 'consumer_closed' | 'thrown'
  response_id?: string | null
  response_model?: string | null
  response_stop?: string | null
  stop?: string | null
  /** Nonnegative safe integer counters only; malformed provider-derived fields are omitted. */
  usage?: Partial<TokenUsage> | null
}
type RequestIdentity = Pick<MuseModelRequestMetadata, 'client_request_id' | 'session_id' | 'provider' | 'model' | 'purpose'>
interface RequestContext { identity: RequestIdentity; credentials: Set<string> }

function usageMetadata(counts: TokenUsage): Partial<TokenUsage> | undefined {
  const safe: Partial<TokenUsage> = {}
  for (const field of ['inputTokens', 'outputTokens', 'totalTokens', 'cacheReadTokens', 'cacheWriteTokens', 'reasoningTokens'] as const) {
    const value = counts[field]
    if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) safe[field] = value
  }
  return Object.keys(safe).length === 0 ? undefined : safe
}

/** Own async attribution per Muse adapter; no process-global active request is retained. */
export class MuseModelRequestTrace {
  private readonly context = new AsyncLocalStorage<RequestContext>()
  private readonly origin: string
  private readonly active = new Set<RequestContext>()
  private closed = false

  constructor(baseUrl: string, private readonly report: (record: MuseModelRequestMetadata) => void) {
    this.origin = new URL(baseUrl).origin
  }

  /** Enforce relay-only attribution after public contributors have prepared request-owned headers.
   * @param request - Exact prepared adapter route, including its final base URL.
   * @param headers - Request-owned contributed headers; no copy is retained.
   * @returns Same headers with an attributable UUID only for this company's relay route.
   */
  headers(request: PiAiRequestHeaderContext, headers: Headers): Headers {
    headers.delete(clientHeader)
    if (this.closed) return headers
    const identity = this.context.getStore()?.identity
    if (identity !== undefined && request.provider === identity.provider && request.model === identity.model
      && (request.sessionId ?? null) === identity.session_id && (request.purpose ?? null) === identity.purpose
      && new URL(request.baseURL).origin === this.origin
      && new URL(request.baseURL).pathname.startsWith('/api/desktop-models/')) {
      headers.set(clientHeader, identity.client_request_id)
    }
    return headers
  }

  /** Remember the resolved credential only within its active request for reflected-metadata redaction.
   * @param value - Actual adapter credential; never copied into diagnostics or retained after request completion.
   * @returns Same credential for the adapter's existing authentication path.
   */
  credential(value: string): string {
    if (!this.closed) this.context.getStore()?.credentials.add(value)
    return value
  }

  /** Admit a bounded identifier only when it cannot reflect this request's credential.
   * @param value - Provider-supplied response or request identifier.
   * @param kind - Identifier vocabulary; model names also permit slash and at signs.
   * @returns Safe identifier, or null for absent, malformed or credential-containing metadata.
   */
  identifier(value: string | undefined, kind: 'id' | 'model'): string | null {
    const pattern = kind === 'id' ? /^[a-z0-9][a-z0-9._:-]{0,255}$/iu : /^[a-z0-9][a-z0-9._:/@+-]{0,199}$/iu
    if (this.closed || value === undefined || !pattern.test(value)) return null
    const secrets = this.context.getStore()?.credentials
    return secrets !== undefined && [...secrets].some(secret => value.includes(secret)) ? null : value
  }

  private emit(record: MuseModelRequestMetadata): void {
    if (this.closed) return
    try { this.report(record) }
    catch (_error) { /* Diagnostic sinks cannot change model output or expose their thrown diagnostics. */ }
  }

  /** Stop diagnostics and release async storage without cancelling or draining model streams. */
  dispose(): void {
    this.closed = true
    for (const request of this.active) request.credentials.clear()
    this.active.clear()
    this.context.disable()
  }

  /** Wrap every iterator operation in its own async context, including suspended generator resumption.
   * @param options - Exact request routing; messages, tools and credentials are never retained.
   * @param source - Deferred adapter stream, preserving its prepared route and cancellation.
   * @returns Byte-for-byte chunk stream with one UUID per consumed iterator and a bounded terminal receipt.
   */
  stream(options: GenerateOptions<string>, source: () => AsyncIterable<StreamChunk>): AsyncIterable<StreamChunk> {
    const route = { session_id: options.sessionId ?? null, provider: options.provider,
      model: options.model, purpose: options.purpose ?? null }
    return { [Symbol.asyncIterator]: (): AsyncIterator<StreamChunk> => {
      const identity: RequestIdentity = { ...route, client_request_id: brandString<Branded<'MuseClientRequestId'>>(randomUUID()) }
      const context: RequestContext = { identity, credentials: new Set() }
      let iterator: AsyncIterator<StreamChunk> | undefined
      let finished = false
      let usage: Partial<TokenUsage> | null | undefined = null
      let response: z.infer<typeof responseSchema> | undefined
      let stop: string | null = null
      const run = <T>(callback: () => T): T => this.closed ? callback() : this.context.run(context, callback)
      const finish = (outcome: NonNullable<MuseModelRequestMetadata['outcome']>): void => {
        if (finished) return
        finished = true
        run(() => {
          this.emit({ event: 'model_client_request_metadata', phase: 'finish', ...identity, outcome,
            response_id: this.identifier(response?.responseId, 'id'), response_model: this.identifier(response?.responseModel, 'model'),
            response_stop: response?.stopReason ?? null, stop, ...usage === undefined ? {} : { usage } })
        })
        context.credentials.clear()
        this.active.delete(context)
      }
      const invoke = async (operation: 'next' | 'return' | 'throw', value?: unknown): Promise<IteratorResult<StreamChunk>> => {
        try {
          if (iterator === undefined) {
            if (!this.closed) this.active.add(context)
            this.emit({ event: 'model_client_request_metadata', phase: 'start', ...identity })
            iterator = run(() => source()[Symbol.asyncIterator]())
          }
          const active = iterator
          const result = await run(async () => {
            if (operation === 'next') return active.next(value)
            if (operation === 'return') return active.return === undefined ? { done: true as const, value } : active.return(value)
            if (active.throw !== undefined) return active.throw(value)
            await active.return?.()
            throw value
          })
          if (result.done) finish(operation === 'return' ? 'consumer_closed' : 'exhausted')
          else if (result.value.type === 'usage') {
            usage = usageMetadata(result.value.usage)
          } else if (result.value.type === 'finish') {
            stop = result.value.reason.kind
            const parsed = responseSchema.safeParse(result.value.replayState?.response)
            response = parsed.success ? parsed.data : undefined
            finish('finished')
          }
          return result
        } catch (error) { finish('thrown'); throw error }
      }
      return { next: value => invoke('next', value), return: value => invoke('return', value), throw: error => invoke('throw', error) }
    } }
  }
}
