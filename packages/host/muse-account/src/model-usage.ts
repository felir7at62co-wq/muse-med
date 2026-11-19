/** Account-bound, content-free usage receipts for supplier-direct Muse calls. */
import type { MuseModelRequestMetadata } from './model-request-trace.ts'
import { readMuseSession } from './session.ts'

/** Private receipt callback captured with one prepared model route. */
export type MuseModelUsageObserver = (record: MuseModelRequestMetadata) => void

/** Gateway transport and private session location shared with the model catalog. */
export interface MuseModelUsageOptions {
  readonly baseUrl: string
  readonly sessionFile: string
  readonly requestTimeoutMs: number
  readonly fetcher?: typeof fetch
}

/** Own bounded in-flight receipt requests independently of model output and retries. */
export class MuseModelUsageReporter {
  private readonly stop = new AbortController()
  private readonly pending = new Set<Promise<void>>()

  /** @param options - Account transport configuration.
   * @param failed - Content-free notification when a receipt cannot be confirmed.
   */
  constructor(private readonly options: MuseModelUsageOptions, private readonly failed: () => void) {}

  private notifyFailure(): void {
    try { this.failed() }
    catch (_error) { /* Receipt diagnostics have no authority over model work or reporter teardown. */ }
  }

  /**
   * Capture the exact login that authorized a prepared direct route.
   * @param revision - Login revision associated with the prepared supplier credential.
   * @returns Receipt callback, or undefined when that login is no longer saved.
   */
  async prepare(revision: string): Promise<MuseModelUsageObserver | undefined> {
    const session = await readMuseSession(this.options.sessionFile, this.options.baseUrl)
    if (this.stop.signal.aborted || session?.revision !== revision) return undefined
    return (record) => {
      if (this.stop.signal.aborted || record.phase !== 'finish') return
      const operation = this.send(session.cookie, record)
      this.pending.add(operation)
      void operation.finally(() => this.pending.delete(operation))
    }
  }

  private async send(cookie: string, record: MuseModelRequestMetadata): Promise<void> {
    // Supplier SDKs synthesize all-zero counters when a response omits usage.
    const usage = record.usage != null && Object.values(record.usage).every(value => value === 0)
      ? undefined : record.usage
    const input = usage?.inputTokens
    const cacheRead = usage?.cacheReadTokens ?? 0
    const cacheWrite = usage?.cacheWriteTokens ?? 0
    const aggregateInput = input === undefined ? null : input + cacheRead + cacheWrite
    const provider = record.provider.startsWith('muse-cloud-') ? record.provider.slice('muse-cloud-'.length) : record.provider
    const body = { id: record.client_request_id, provider, model: record.model,
      status: record.stop !== null && record.stop !== undefined && !['error', 'aborted'].includes(record.stop) ? 200 : null,
      inputTokens: aggregateInput !== null && Number.isSafeInteger(aggregateInput) ? aggregateInput : null,
      outputTokens: usage?.outputTokens ?? null, totalTokens: usage?.totalTokens ?? null,
      cachedInputTokens: usage?.cacheReadTokens ?? null, reasoningTokens: usage?.reasoningTokens ?? null }
    try {
      const response = await (this.options.fetcher ?? fetch)(new URL('/api/muse.account/usage', this.options.baseUrl), {
        method: 'POST', redirect: 'manual',
        signal: AbortSignal.any([this.stop.signal, AbortSignal.timeout(this.options.requestTimeoutMs)]),
        headers: { cookie, origin: this.options.baseUrl, 'content-type': 'application/json' }, body: JSON.stringify(body),
      })
      await response.body?.cancel()
      if (!response.ok) this.notifyFailure()
    } catch (_error) {
      if (!this.stop.signal.aborted) this.notifyFailure()
    }
  }

  /** Cancel new and in-flight reports and wait until every owned request settles. */
  async dispose(): Promise<void> {
    this.stop.abort()
    await Promise.allSettled([...this.pending])
  }
}
