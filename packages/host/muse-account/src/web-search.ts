/** Session-authorized Muse search; supplier credentials remain on the account gateway. */
import type { Context } from '@deepseek-ai/cordis'
import { WebError } from '@deepseek-ai/dsh-web'
import type { WebSearchProvider, WebSearchRequest, WebSearchResult } from '@deepseek-ai/dsh-web'
import { z } from 'zod'
import { museGatewayOrigin } from './gateway.ts'
import { readMuseSession } from './session.ts'

/** Product-owned provider id; personal search providers keep their existing configuration. */
export const MUSE_SEARCH_PROVIDER_ID = 'muse'

/** Private account transport and independent search deadline. */
export interface MuseWebSearchOptions {
  readonly baseUrl: string
  readonly sessionFile: string
  readonly requestTimeoutMs: number
  readonly fetcher?: typeof fetch
}

// The gateway's bounded result protocol contains sources, never page bodies or credentials.
const MAX_REPLY_BYTES = 1024 * 1024
const source = z.object({
  url: z.string().max(8192).refine((value) => {
    try {
      const url = new URL(value)
      return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password
    } catch (_error) { return false }
  }),
  title: z.string().max(2048).optional(),
  snippet: z.string().max(16_384).optional(),
  summary: z.string().max(16_384).optional(),
  date: z.string().max(200).optional(),
})
const reply = z.object({ results: z.array(source).max(100) })

class MuseSearchError extends WebError {}

function failure(message: string, code = 'WEB_PROVIDER_ERROR'): MuseSearchError {
  return new MuseSearchError(message, code)
}

async function readReply(response: Response, signal: AbortSignal): Promise<unknown> {
  const reader = response.body?.getReader()
  if (reader === undefined) throw failure('Muse search returned an invalid response.')
  const chunks: Uint8Array[] = []
  let bytes = 0
  try {
    for (;;) {
      signal.throwIfAborted()
      const next = await reader.read()
      if (next.done) break
      bytes += next.value.byteLength
      if (bytes > MAX_REPLY_BYTES) throw failure('Muse search returned an oversized response.')
      chunks.push(next.value)
    }
    const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, bytes)))
    return value
  } catch (error) {
    try { await reader.cancel() }
    catch (_error) { /* A disconnected body can reject cleanup; preserve the bounded failure. */ }
    throw error
  } finally { reader.releaseLock() }
}

/** Search using the saved Muse session without accessing any supplier API key. */
export class MuseWebSearchProvider implements WebSearchProvider {
  readonly id = MUSE_SEARCH_PROVIDER_ID
  private readonly origin: string
  private readonly stop = new AbortController()
  private readonly pending = new Set<Promise<WebSearchResult>>()

  /** @param options - Product origin, origin-bound private session and search deadline. */
  constructor(private readonly options: MuseWebSearchOptions) {
    this.origin = museGatewayOrigin(options.baseUrl)
  }

  available(): boolean { return !this.stop.signal.aborted }

  async search(request: WebSearchRequest, signal?: AbortSignal): Promise<WebSearchResult> {
    const operation = this.request(request, signal)
    this.pending.add(operation)
    try { return await operation }
    finally { this.pending.delete(operation) }
  }

  /** Cancel active searches and await their settlement before the provider is removed. */
  async dispose(): Promise<void> {
    this.stop.abort()
    await Promise.allSettled([...this.pending])
  }

  private async request(request: WebSearchRequest, caller?: AbortSignal): Promise<WebSearchResult> {
    const timeout = AbortSignal.timeout(this.options.requestTimeoutMs)
    const signal = AbortSignal.any([this.stop.signal, timeout, ...(caller === undefined ? [] : [caller])])
    let response: Response | undefined
    try {
      signal.throwIfAborted()
      const session = await readMuseSession(this.options.sessionFile, this.origin)
      signal.throwIfAborted()
      if (session === null) throw failure('Sign in to Muse before searching the web.', 'WEB_PROVIDER_CREDENTIAL_MISSING')
      response = await (this.options.fetcher ?? fetch)(new URL('/api/web/search', this.origin), {
        method: 'POST', redirect: 'error', signal,
        headers: { cookie: session.cookie, origin: this.origin, 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({ query: request.query, ...(request.maxResults === undefined ? {} : { maxResults: request.maxResults }) }),
      })
      signal.throwIfAborted()
      if (response.status === 401 || response.status === 403) {
        throw failure('Muse search authorization expired or was rejected; sign in again.', 'WEB_PROVIDER_CREDENTIAL_MISSING')
      }
      if (response.status === 429) throw failure('Muse search is busy; try again later.')
      if (response.status === 504) throw failure('Muse web search timed out; try again later.')
      if (response.status === 404 || response.status === 503) throw failure('Muse web search is temporarily unavailable.')
      if (!response.ok) throw failure('Muse web search could not complete the request.')
      const parsed = reply.safeParse(await readReply(response, signal))
      if (!parsed.success) throw failure('Muse search returned an invalid response.')
      const current = await readMuseSession(this.options.sessionFile, this.origin)
      signal.throwIfAborted()
      if (current?.revision !== session.revision) throw failure('Muse account changed during search; try again after signing in.')
      const seen = new Set<string>()
      const sources = parsed.data.results.flatMap((row) => {
        if (seen.has(row.url)) return []
        seen.add(row.url)
        const snippet = row.snippet || row.summary
        return [{ url: row.url,
          ...(row.title === undefined ? {} : { title: row.title }),
          ...(snippet === undefined ? {} : { snippet }),
          ...(row.date === undefined ? {} : { publishedAt: row.date }) }]
      })
      const limit = request.maxResults
      return { sources: limit === undefined ? sources : sources.slice(0, limit),
        truncated: limit !== undefined && sources.length > limit }
    } catch (error) {
      if (caller?.aborted === true || this.stop.signal.aborted) throw failure('Muse web search was cancelled.', 'WEB_ABORTED')
      if (timeout.aborted) throw failure('Muse web search timed out; try again later.')
      if (error instanceof MuseSearchError) throw error
      // Transport errors, rejected JSON and session data never become model-visible diagnostics.
      throw failure('Muse web search could not complete the request.')
    } finally {
      if (response !== undefined && !response.bodyUsed) {
        try { await response.body?.cancel() }
        catch (_error) { /* The request failure remains authoritative after an unread body disconnects. */ }
      }
    }
  }
}

/**
 * Register the account-authorized provider when the optional web service exists.
 * @param ctx - Muse plugin context owning registration and active-request cleanup.
 * @param options - Fixed account transport and search deadline.
 */
export function mountMuseWebSearch(ctx: Context, options: MuseWebSearchOptions): void {
  ctx.inject(['web'], (scope) => {
    const provider = new MuseWebSearchProvider(options)
    scope.web.registerSearchProvider(provider)
    scope.effect(() => () => provider.dispose(), 'muse-account: web search requests')
  })
}
