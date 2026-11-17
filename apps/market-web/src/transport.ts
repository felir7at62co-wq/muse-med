/** Bounded same-origin requests using the browser's existing Muse login. */
import { marketRecord } from '@deepseek-ai/dsh-muse-market/src/format-values.ts'
import { HarnessError } from '@deepseek-ai/dsh-error'
import type { MarketLimits } from '@deepseek-ai/dsh-muse-market/types'

/** Resolved public deployment policy; contains no credentials or private paths. */
export interface MarketWebConfig {
  readonly limits: MarketLimits
  readonly requestTimeoutMs: number
  readonly metadataBytes: number
  readonly catalogLimit: number
}

/** Carrier error with the same safe outcome fields consumed by the shared market UI. */
export class MarketWebError extends HarnessError {
  readonly details: { readonly code: string; readonly status: number }
  constructor(code: string, status = 400) { super(code, 'muse-market/cloud-failed'); this.details = { code, status } }
}

/** Resolve public resource bounds before creating a request carrier.
 * @param input - Untrusted public configuration JSON.
 * @returns Explicit archive, catalog and transport limits.
 */
export function marketWebConfig(input: unknown): MarketWebConfig {
  if (!marketRecord(input) || !marketRecord(input.limits)) throw new MarketWebError('invalid-config')
  const bound = (value: unknown, low: number, high: number): number => {
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < low || value > high) {
      throw new MarketWebError('invalid-config')
    }
    return value
  }
  return {
    limits: {
      archiveBytes: bound(input.limits.archiveBytes, 1024, 64 * 1024 * 1024),
      expandedBytes: bound(input.limits.expandedBytes, 1024, 256 * 1024 * 1024),
      fileCount: bound(input.limits.fileCount, 1, 4096),
      recordBytes: bound(input.limits.recordBytes ?? 4 * 1024 * 1024, 1024, 16 * 1024 * 1024),
    },
    requestTimeoutMs: bound(input.requestTimeoutMs, 1000, 300000),
    metadataBytes: bound(input.metadataBytes, 1024, 64 * 1024 * 1024),
    catalogLimit: bound(input.catalogLimit ?? 100, 1, 100),
  }
}

/** Read a complete response under a declared and measured byte limit.
 * @param response - Response whose body is owned by the caller.
 * @param maximum - Maximum admitted response size.
 * @returns Exact body bytes; the reader is released on every outcome.
 */
export async function readMarketBody(response: Response, maximum: number): Promise<Uint8Array> {
  const length = response.headers.get('content-length')
  if (length !== null && (!/^\d+$/u.test(length) || Number(length) > maximum)) {
    await response.body?.cancel(); throw new MarketWebError('response-too-large', 413)
  }
  const reader = response.body?.getReader()
  if (!reader) throw new MarketWebError('invalid-response', 502)
  const chunks: Uint8Array[] = []; let size = 0
  try {
    while (true) {
      const part = await reader.read()
      if (part.done) break
      size += part.value.byteLength
      if (size > maximum) throw new MarketWebError('response-too-large', 413)
      chunks.push(part.value)
    }
  } finally {
    try { await reader.cancel() } finally { reader.releaseLock() }
  }
  const result = new Uint8Array(size); let offset = 0
  for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.length }
  return result
}

/** Create a carrier whose close method aborts and settles its owned requests.
 * @param config - Validated public limits.
 * @param fetcher - Browser fetch or a test HTTP carrier.
 * @returns Bounded byte and JSON requests plus teardown.
 */
export function createMarketTransport(config: MarketWebConfig, fetcher: typeof fetch = fetch) {
  const lifetime = new AbortController(), pending = new Set<Promise<Uint8Array>>()
  const request = async (path: string, init: RequestInit = {}, maximum = config.metadataBytes): Promise<Uint8Array> => {
    if (!/^\/(?:api\/(?:market\/v1\/|muse\.account$)|market\/(?:catalog\.json$|downloads\/))/u.test(path)
      || /[\\\r\n]/u.test(path)) throw new MarketWebError('invalid-cloud-path')
    const work = (async () => {
      lifetime.signal.throwIfAborted()
      const signal = AbortSignal.any([lifetime.signal, AbortSignal.timeout(config.requestTimeoutMs)])
      try {
        const response = await fetcher(path, { ...init, credentials: init.credentials === 'omit' ? 'omit' : 'same-origin', mode: 'same-origin',
          cache: 'no-store', redirect: 'manual', signal })
        if (!response.ok || response.type === 'opaqueredirect') {
          await response.body?.cancel()
          const status = response.status
          throw new MarketWebError(status === 401 || status >= 300 && status < 400 || response.type === 'opaqueredirect'
            ? 'login-required' : status === 403 ? 'permission-denied' : status === 409 ? 'cloud-conflict'
              : status === 413 ? 'archive-too-large' : status === 429 ? 'rate-limited' : 'cloud-unavailable', status || 401)
        }
        return await readMarketBody(response, maximum)
      } catch (error) {
        if (error instanceof MarketWebError) throw error
        throw new MarketWebError(signal.aborted ? 'cloud-timeout' : 'cloud-unavailable', 503)
      }
    })()
    pending.add(work)
    try { return await work } finally { pending.delete(work) }
  }
  return {
    request,
    json: async (path: string, init?: RequestInit): Promise<unknown> => {
      const bytes = await request(path, init)
      try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) }
      catch (_error) { throw new MarketWebError('invalid-response', 502) }
    },
    close: async (): Promise<void> => { lifetime.abort(); await Promise.allSettled(pending) },
  }
}
