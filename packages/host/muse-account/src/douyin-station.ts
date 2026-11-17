/** Data-station Douyin downloads authorized by the signed-in Muse account. */
import { setTimeout as delay } from 'node:timers/promises'
import { z } from 'zod'
import { museGatewayOrigin } from './gateway.ts'
import { readMuseSession } from './session.ts'
import type { MuseStoredSession } from './session.ts'

/** One Douyin work or one complete Douyin series. */
export type MuseDouyinTarget =
  | { readonly kind: 'work'; readonly awemeId: string }
  | { readonly kind: 'mix'; readonly mixId: string }

/** A recognized target, or a `v.douyin.com` share link whose single redirect names the target. */
export type MuseDouyinLink = MuseDouyinTarget | { readonly kind: 'short'; readonly url: string }

/** Fixed failures; station response bodies and the account token are never retained. */
export type MuseDouyinFailure =
  | 'sign-in-required' | 'team-access-required' | 'daily-limit' | 'station-unavailable' | 'account-changed'
  | 'invalid-input' | 'link-unresolved' | 'invalid-response' | 'unconfirmed' | 'timeout' | 'cancelled' | 'unavailable'

/** Coded station failure. */
export class MuseDouyinError extends Error {
  /** @param code - Fixed failure category reported to the model. */
  constructor(readonly code: MuseDouyinFailure) {
    super(`Muse Douyin download: ${code}`)
  }
}

/** Product origin, private session file, station route prefix and validated limits. */
export interface MuseDouyinStationOptions {
  readonly baseUrl: string
  readonly sessionFile: string
  /** Absolute route prefix joined to the account gateway origin. */
  readonly path: string
  readonly requestTimeoutMs: number
  readonly linkTimeoutMs: number
  readonly maxReplyBytes: number
  /** Records requested by one query, at most the station's 500-record page. */
  readonly listLimit: number
  readonly fetcher?: typeof fetch
}

const digits = z.string().regex(/^\d{1,32}$/u)
const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
const publicUrl = z.string().max(8192).refine((value) => {
  if (!URL.canParse(value)) return false
  const url = new URL(value)
  return url.protocol === 'https:' && url.username === '' && url.password === ''
})
const record = z.object({
  id: z.string().min(1).max(128), awemeId: digits, mixId: digits.nullable().optional(),
  mixName: z.string().max(4096).nullable().optional(), episode: count.nullable().optional(), title: z.string().max(8192).optional(),
  state: z.enum(['queued', 'downloading', 'uploading', 'done', 'failed']),
  url: publicUrl.nullable().optional(), error: z.string().max(8192).nullable().optional(),
})
const records = z.array(record).max(1000)
const status = z.object({
  enabled: z.boolean(), reason: z.string().max(4096).optional(), dailyLimit: count, usedToday: count,
  unlimited: z.boolean().optional(), maxMixEpisodes: count,
})
const submission = z.object({ queued: records, existing: records, skipped: count })
const link = z.object({ url: publicUrl, expiresAt: z.string().max(64).nullable() })
const file = z.object({ download: record, file: link.nullable() })

/** One station download record. */
export type MuseDouyinRecord = z.output<typeof record>
/** Availability and the member's daily allowance shared with the station's web page. */
export type MuseDouyinStatus = z.output<typeof status>
/** Newly queued and already known records, plus series episodes left out by the daily allowance. */
export type MuseDouyinSubmission = z.output<typeof submission>
/** Downloadable address of a saved file; `expiresAt` is null for a public address. */
export type MuseDouyinFileLink = z.output<typeof link>

/** Station operations bound to the login captured when the operation started. */
export interface MuseDouyinStation {
  /** @returns Availability and the member's daily allowance. */
  status(): Promise<MuseDouyinStatus>
  /**
   * Queue one work or every episode of one series.
   * @param target - Work or series.
   * @returns Station submission result.
   */
  submit(target: MuseDouyinTarget): Promise<MuseDouyinSubmission>
  /**
   * Read the current records of one work or series without submitting.
   * @param target - Work or series.
   * @returns Station records, possibly empty.
   */
  list(target: MuseDouyinTarget): Promise<MuseDouyinRecord[]>
  /**
   * Read one record's file address.
   * @param id - Station record ID.
   * @returns Address of a saved file, or null while it is not saved.
   */
  file(id: string): Promise<MuseDouyinFileLink | null>
  /**
   * Read one share link's redirect without its body or any account credential.
   * @param url - Validated `https://v.douyin.com/<code>/` link.
   * @returns The redirect target.
   */
  resolve(url: string): Promise<URL>
  /**
   * Pause between polls; operation cancellation ends the pause.
   * @param ms - Pause in milliseconds.
   */
  wait(ms: number): Promise<void>
}

const linkPattern = /(?:https?:\/\/)?(?:[a-z0-9-]+\.)*(?:douyin|iesdouyin)\.com(?:\/[^\s"'<>，。！？；、）】]*)?/giu

/**
 * Recognize a Douyin work, series or share link in a URL.
 * @param url - Parsed URL.
 * @returns Recognized target or short link; undefined for other pages.
 */
export function douyinTarget(url: URL): MuseDouyinLink | undefined {
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return undefined
  if (!/^(?:[a-z0-9-]+\.)*(?:douyin|iesdouyin)\.com$/u.test(url.hostname)) return undefined
  if (url.hostname === 'v.douyin.com') {
    return /^\/[A-Za-z0-9_-]+\/?$/u.test(url.pathname) ? { kind: 'short', url: `https://v.douyin.com${url.pathname}` } : undefined
  }
  const modal = url.searchParams.get('modal_id')
  if (modal !== null && digits.safeParse(modal).success) return { kind: 'work', awemeId: modal }
  const awemeId = /\/video\/(\d{1,32})(?:\/|$)/u.exec(url.pathname)?.[1]
  if (awemeId !== undefined) return { kind: 'work', awemeId }
  const mixId = /\/(?:collection|mix\/detail)\/(\d{1,32})(?:\/|$)/u.exec(url.pathname)?.[1]
  return mixId === undefined ? undefined : { kind: 'mix', mixId }
}

/**
 * Find the first Douyin work, series or share link in a URL or pasted share text.
 * @param text - URL or share text.
 * @returns First recognized target or short link.
 */
export function parseDouyinLink(text: string): MuseDouyinLink | undefined {
  // The pattern admits only ASCII host labels and an unrestricted path, which WHATWG URL parsing always accepts.
  for (const [match] of text.matchAll(linkPattern)) {
    const target = douyinTarget(new URL(/^https?:\/\//iu.test(match) ? match : `https://${match}`))
    if (target !== undefined) return target
  }
  return undefined
}

function failure(code: number, write: boolean): MuseDouyinFailure {
  switch (code) {
    case 400: return 'invalid-input'
    case 401: return 'sign-in-required'
    case 403: return 'team-access-required'
    case 429: return 'daily-limit'
    case 503: return 'station-unavailable'
    default: return write && code >= 500 ? 'unconfirmed' : 'unavailable'
  }
}

/** Owns account-token station requests until disposal has settled them. */
export class MuseDouyinStationClient {
  private readonly origin: string
  private readonly stop = new AbortController()
  private readonly pending = new Set<Promise<unknown>>()

  /** @param options - Product origin, private account file, route prefix and validated limits. */
  constructor(private readonly options: MuseDouyinStationOptions) {
    this.origin = museGatewayOrigin(options.baseUrl)
  }

  /**
   * Run station work for the current login; an account change rejects its result.
   * @param caller - Tool cancellation.
   * @param work - Requests and waits bound to the captured login.
   * @returns The work's result after a final account check.
   */
  async run<Result>(caller: AbortSignal, work: (station: MuseDouyinStation) => Promise<Result>): Promise<Result> {
    const operation = this.operation(caller, work)
    this.pending.add(operation)
    try { return await operation }
    finally { this.pending.delete(operation) }
  }

  /** Abort active operations and wait for them to settle. */
  async dispose(): Promise<void> {
    this.stop.abort()
    await Promise.allSettled([...this.pending])
  }

  private async operation<Result>(caller: AbortSignal, work: (station: MuseDouyinStation) => Promise<Result>): Promise<Result> {
    const signal = AbortSignal.any([this.stop.signal, caller])
    try {
      signal.throwIfAborted()
      let session: MuseStoredSession | null
      try { session = await readMuseSession(this.options.sessionFile, this.origin) }
      catch (_error) { throw new MuseDouyinError('unavailable') }
      signal.throwIfAborted()
      if (session === null) throw new MuseDouyinError('sign-in-required')
      const original = session
      const prefix = `/downloads?limit=${this.options.listLimit}&`
      const query = (target: MuseDouyinTarget): string => target.kind === 'work'
        ? `${prefix}awemeIds=${target.awemeId}` : `${prefix}mixId=${target.mixId}`
      const station: MuseDouyinStation = {
        status: async () => status.parse(await this.exchange(original, signal, '/downloads/status')),
        submit: async target => submission.parse(await this.exchange(original, signal, target.kind === 'work' ? '/downloads' : '/downloads/mix',
          JSON.stringify(target.kind === 'work' ? { awemeId: target.awemeId } : { mixId: target.mixId }))),
        list: async target => records.parse(await this.exchange(original, signal, query(target))),
        file: async id => file.parse(await this.exchange(original, signal, `/downloads/${encodeURIComponent(id)}`)).file,
        resolve: async url => await this.redirect(url, signal),
        wait: async (ms) => { await delay(ms, undefined, { signal }) },
      }
      const result = await work(station)
      await this.assertCurrent(original, signal)
      return result
    } catch (error) {
      if (signal.aborted) throw new MuseDouyinError('cancelled')
      if (error instanceof z.ZodError) throw new MuseDouyinError('invalid-response')
      throw error
    }
  }

  private async assertCurrent(original: MuseStoredSession, signal: AbortSignal): Promise<void> {
    let current: MuseStoredSession | null
    try { current = await readMuseSession(this.options.sessionFile, this.origin) }
    catch (_error) { throw new MuseDouyinError('account-changed') }
    signal.throwIfAborted()
    if (current?.revision !== original.revision) throw new MuseDouyinError('account-changed')
  }

  private async exchange(original: MuseStoredSession, signal: AbortSignal, path: string, body?: string): Promise<unknown> {
    await this.assertCurrent(original, signal)
    const token = original.cookie.slice('__Host-muse='.length)
    const timeout = AbortSignal.timeout(this.options.requestTimeoutMs)
    let text: string
    try {
      text = await this.read(path, token, AbortSignal.any([signal, timeout]), body)
    } catch (error) {
      if (error instanceof MuseDouyinError || signal.aborted) throw error
      throw new MuseDouyinError(body !== undefined ? 'unconfirmed' : timeout.aborted ? 'timeout' : 'unavailable')
    }
    if (text.includes(token)) throw new MuseDouyinError('invalid-response')
    let value: unknown
    try { value = JSON.parse(text) }
    catch (_error) { throw new MuseDouyinError('invalid-response') }
    await this.assertCurrent(original, signal)
    return value
  }

  private async read(path: string, token: string, signal: AbortSignal, body?: string): Promise<string> {
    // Node fetch adds no Origin header; the station refuses account-token requests that carry one.
    const response = await (this.options.fetcher ?? fetch)(new URL(`${this.options.path}${path}`, this.origin), {
      method: body === undefined ? 'GET' : 'POST', redirect: 'manual', signal,
      headers: { 'x-muse-account-token': token, accept: 'application/json', ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      ...(body === undefined ? {} : { body }),
    })
    if (response.status < 200 || response.status > 299 || response.headers.get('content-type')?.split(';')[0]?.trim() !== 'application/json') {
      await response.body?.cancel()
      throw new MuseDouyinError(response.ok ? 'invalid-response' : failure(response.status, body !== undefined))
    }
    const reader = response.body?.getReader()
    if (reader === undefined) throw new MuseDouyinError('invalid-response')
    const chunks: Uint8Array[] = []
    let bytes = 0
    for (let next = await reader.read(); !next.done; next = await reader.read()) {
      bytes += next.value.byteLength
      if (bytes > this.options.maxReplyBytes) {
        await reader.cancel()
        throw new MuseDouyinError('invalid-response')
      }
      chunks.push(next.value)
    }
    try { return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, bytes)) }
    catch (_error) { throw new MuseDouyinError('invalid-response') }
  }

  private async redirect(url: string, signal: AbortSignal): Promise<URL> {
    let response: Response
    try {
      response = await (this.options.fetcher ?? fetch)(url, { method: 'GET', redirect: 'manual',
        signal: AbortSignal.any([signal, AbortSignal.timeout(this.options.linkTimeoutMs)]) })
    } catch (_error) {
      signal.throwIfAborted()
      throw new MuseDouyinError('link-unresolved')
    }
    await response.body?.cancel()
    const location = response.headers.get('location')
    if (response.status < 300 || response.status > 399 || location === null || !URL.canParse(location, url)) {
      throw new MuseDouyinError('link-unresolved')
    }
    return new URL(location, url)
  }
}
