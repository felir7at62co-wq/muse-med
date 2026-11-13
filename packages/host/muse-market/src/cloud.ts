/** Optional account-bound Skill publication client; credentials remain in the Host. */
import { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import { Remote, RemoteError, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import { museGatewayOrigin, readMuseSession } from '@deepseek-ai/dsh-muse-account'
import { isAbsolute } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { MarketError, marketRecord } from './format.ts'
import { marketDigest, readMarketPackage } from './package.ts'
import { MarketCloudError, parseMarketIdentity, parseMarketPublication, parseMarketPublicationId,
  parseMarketPublisherId, parseMarketUploadRequestId } from './cloud-protocol.ts'
import type { MarketPublication, MarketPublicationId, MarketPublisherId, MarketUploadRequestId,
  MarketReviewAction, MarketIdentity } from './cloud-protocol.ts'
import type { MarketLimits, MarketReleaseId, MuseMarketInstallation } from './types.ts'
import type {} from './index.ts'

export type { MarketPublication, MarketPublicationId, MarketPublisherId, MarketUploadRequestId,
  MarketReviewAction, MarketIdentity } from './cloud-protocol.ts'
export { parseMarketPublicationId, parseMarketPublisherId, parseMarketUploadRequestId } from './cloud-protocol.ts'

/** Host-owned endpoint, credential-file location and independent transport bounds. */
export interface MuseMarketCloudConfig {
  /** Canonical Muse Account HTTPS origin, or loopback HTTP for a private deployment. */
  readonly baseUrl: string
  /** Absolute private Muse Account session file; never supplied by Remote callers. */
  readonly sessionFile: string
  /** Maximum lifetime of each HTTP request and its complete response body. */
  readonly requestTimeoutMs: number
  /** Maximum encoded JSON request bytes. */
  readonly jsonRequestBytes: number
  /** Maximum complete JSON reply bytes; archive limits come from local storage. */
  readonly jsonResponseBytes: number
  /** Maximum catalog items accepted without silently truncating a server reply. */
  readonly catalogLimit: number
}

interface CloudRequest {
  json(path: string, init?: RequestInit): Promise<unknown>
  archive(path: string, publication: MarketPublication): Promise<Buffer>
  assertCurrent(): Promise<void>
}

interface WriteContext {
  readonly requestId?: MarketUploadRequestId
  readonly publicationId?: MarketPublicationId
  readonly reviewedRevision?: number
  readonly observed?: MarketPublication
}

class WriteUnconfirmed extends MarketCloudError {
  constructor(code: string, status: number, readonly context: WriteContext) { super(code, status) }
}

class AccountTransport {
  private readonly origin: string
  private readonly lifetime = new AbortController()
  private readonly pending = new Set<Promise<unknown>>()

  constructor(private readonly config: MuseMarketCloudConfig, private readonly limits: MarketLimits) {
    this.origin = museGatewayOrigin(config.baseUrl)
    if (!isAbsolute(config.sessionFile)) throw new MarketCloudError('invalid-session-file', 400)
  }

  async account<T>(required: boolean, action: (request: CloudRequest) => Promise<T>): Promise<T> {
    const work = this.open(required, action)
    this.pending.add(work)
    try { return await work } finally { this.pending.delete(work) }
  }

  private async open<T>(required: boolean, action: (request: CloudRequest) => Promise<T>): Promise<T> {
    if (this.lifetime.signal.aborted) throw new MarketCloudError('closing', 503)
    let session
    try { session = await readMuseSession(this.config.sessionFile, this.origin) }
    catch (_error) { throw new MarketCloudError('account-unavailable', 503) }
    if (required && session === null) throw new MarketCloudError('login-required', 401)
    const assertCurrent = async (): Promise<void> => {
      if (this.lifetime.signal.aborted) throw new MarketCloudError('closing', 503)
      if (session === null) return
      let current
      try { current = await readMuseSession(this.config.sessionFile, this.origin) }
      catch (_error) { throw new MarketCloudError('account-unavailable', 503) }
      if (current?.revision !== session.revision || current.cookie !== session.cookie) throw new MarketCloudError('account-changed', 409)
    }
    const bytes = async (path: string, init: RequestInit, maximum: number, publication?: MarketPublication): Promise<Buffer> => {
      await assertCurrent()
      const headers = new Headers(init.headers)
      headers.set('origin', this.origin)
      if (session !== null) headers.set('cookie', session.cookie)
      const signal = AbortSignal.any([this.lifetime.signal, AbortSignal.timeout(this.config.requestTimeoutMs)])
      let response: Response
      try { response = await fetch(this.origin + path, { ...init, headers, redirect: 'manual', signal }) }
      catch (_error) {
        throw new MarketCloudError(this.lifetime.signal.aborted ? 'closing' : signal.aborted ? 'cloud-timeout' : 'cloud-unavailable', 503)
      }
      if (!response.ok) {
        await response.body?.cancel()
        const status = response.status
        throw new MarketCloudError(status >= 300 && status < 400 ? 'redirect-refused'
          : status === 401 ? 'login-required' : status === 403 ? 'permission-denied'
            : status === 404 ? 'not-found' : status === 409 ? 'cloud-conflict'
              : status === 413 ? 'response-too-large' : status === 429 ? 'rate-limited' : 'cloud-unavailable', status)
      }
      const length = response.headers.get('content-length')
      if (length !== null && (!/^\d+$/u.test(length) || Number(length) > maximum)) {
        await response.body?.cancel(); throw new MarketCloudError('response-too-large', 413)
      }
      const kind = response.headers.get('content-type')?.split(';', 1)[0]?.trim()
      if (publication === undefined ? kind !== 'application/json' : kind !== 'application/zip'
        || response.headers.get('x-content-sha256') !== publication.sha256
        || length !== String(publication.bytes)) {
        await response.body?.cancel(); throw new MarketCloudError('invalid-response', 502)
      }
      const reader = response.body?.getReader()
      if (reader === undefined) throw new MarketCloudError('invalid-response', 502)
      const chunks: Uint8Array[] = []; let size = 0
      try {
        while (true) {
          const part = await reader.read()
          if (part.done) break
          size += part.value.byteLength
          if (size > maximum) throw new MarketCloudError('response-too-large', 413)
          chunks.push(part.value)
        }
      } catch (error) {
        if (error instanceof MarketCloudError) throw error
        throw new MarketCloudError(this.lifetime.signal.aborted ? 'closing' : signal.aborted ? 'cloud-timeout' : 'cloud-unavailable', 503)
      } finally {
        try { await reader.cancel() }
        catch (_error) { /* Preserve the request failure when the stream is already closed or errored. */ }
        reader.releaseLock()
      }
      await assertCurrent()
      return Buffer.concat(chunks)
    }
    return await action({
      assertCurrent,
      archive: (path, publication) => bytes(path, {}, this.limits.archiveBytes, publication),
      json: async (path, init = {}) => {
        const body = init.body
        if (typeof body === 'string' && Buffer.byteLength(body) > this.config.jsonRequestBytes) throw new MarketCloudError('request-too-large', 413)
        const result = await bytes(path, init, this.config.jsonResponseBytes)
        try { const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(result)); return value }
        catch (_error) { throw new MarketCloudError('invalid-response', 502) }
      },
    })
  }

  async close(): Promise<void> {
    this.lifetime.abort()
    await Promise.allSettled([...this.pending])
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context { museMarketCloud: MuseMarketCloud }
}
declare module '@deepseek-ai/dsh-typert-protocol' {
  interface RemoteErrorDetailsMap {
    'muse-market/cloud-failed': { readonly code: string; readonly status: number } & WriteContext
  }
}

/** Explicit cloud operations over immutable local archives; installation never activates a Skill. */
export default class MuseMarketCloud extends TypertRemoteService {
  static inject = ['museMarket']
  static Config = Schema.object({
    baseUrl: Schema.string().required(),
    sessionFile: Schema.string().default(dshHomePath('muse-account', 'session.json')),
    requestTimeoutMs: Schema.natural().min(100).max(120_000).default(30_000),
    jsonRequestBytes: Schema.natural().min(1024).max(1024 * 1024).default(16_384),
    jsonResponseBytes: Schema.natural().min(1024).max(16 * 1024 * 1024).default(1024 * 1024),
    catalogLimit: Schema.natural().min(1).max(100).default(100),
  })
  private readonly transport: AccountTransport
  private readonly limits: MarketLimits

  constructor(ctx: Context, private readonly config: MuseMarketCloudConfig) {
    super(ctx, 'museMarketCloud')
    this.limits = ctx.museMarket.publicationStorage().limits
    this.transport = new AccountTransport(config, this.limits)
    ctx.effect(() => () => this.transport.close())
  }

  private async run<T>(action: () => Promise<T>): Promise<T> {
    try { return await action() }
    catch (error) {
      if (error instanceof RemoteError) throw error
      const code = error instanceof MarketCloudError || error instanceof MarketError ? error.code : 'cloud-unavailable'
      const status = error instanceof MarketCloudError ? error.status : error instanceof MarketError ? 400 : 503
      throw new RemoteError('muse-market/cloud-failed', 'Skill cloud operation failed', {
        code, status, ...(error instanceof WriteUnconfirmed ? error.context : {}),
      })
    }
  }

  /** Search published metadata, or the signed-in creator's private records.
   * @param q - Search text, at most 200 characters; empty requests the bounded current catalog.
   * @param mine - Whether private creator-visible publications are requested.
   * @returns At most catalogLimit validated records; oversized replies refuse instead of truncating.
   */
  @Remote('catalog')
  async catalog(q: string, mine: boolean): Promise<MarketPublication[]> {
    return await this.run(() => this.transport.account(mine, async (request) => {
      if (q.length > 200) throw new MarketCloudError('invalid-query', 400)
      const value = await request.json('/api/market/v1/catalog?' + new URLSearchParams({ q, mine: String(mine) }).toString())
      if (!marketRecord(value) || Object.keys(value).length !== 1 || !Array.isArray(value.items)
        || value.items.length > this.config.catalogLimit) throw new MarketCloudError('invalid-response', 502)
      const publications = value.items.map((item: unknown) => parseMarketPublication(item, this.limits))
      if (!mine && publications.some(item => item.status !== 'published')) throw new MarketCloudError('invalid-response', 502)
      return publications
    }))
  }

  /** Read admitted publishing teams and administrator capability for the current login.
   * @returns Validated public identity facts without the private account cookie.
   */
  @Remote('identity')
  async identity(): Promise<MarketIdentity> {
    return await this.run(() => this.transport.account(true, async request => parseMarketIdentity(await request.json('/api/market/v1/me'))))
  }

  /** Read one original publication using current account visibility.
   * @param id - Exact 32-character cloud publication identity, distinct from a local SHA.
   * @returns Complete validated public or authorized private metadata.
   */
  @Remote('getPublication')
  async getPublication(id: MarketPublicationId): Promise<MarketPublication> {
    return await this.run(() => this.transport.account(false, async (request) => {
      const selected = parseMarketPublicationId(id)
      const value = parseMarketPublication(await request.json(`/api/market/v1/releases/${selected}`), this.limits)
      if (value.id !== selected) throw new MarketCloudError('invalid-response', 502)
      return value
    }))
  }

  /** Upload exact retained local bytes as a private draft; retry only with the original key and archive.
   * @param localId - Exact 64-character local archive SHA identity.
   * @param publisherId - Admitted publishing team selected by the caller.
   * @param requestId - Original account-scoped upload key retained across uncertain replies.
   * @returns The exact archive's cloud record; upload never submits it for review.
   */
  @Remote('publishDraft')
  async publishDraft(
    localId: MarketReleaseId, publisherId: MarketPublisherId, requestId: MarketUploadRequestId,
  ): Promise<MarketPublication> {
    return await this.run(async () => {
      const publisher = parseMarketPublisherId(publisherId), key = parseMarketUploadRequestId(requestId)
      if (!/^[a-f0-9]{64}$/u.test(localId)) throw new MarketCloudError('invalid-local-release', 400)
      return await this.transport.account(true, async (request) => {
        const exported = await this.ctx.museMarket.exportPackage(localId), archive = Buffer.from(exported.base64, 'base64')
        const decoded = readMarketPackage(archive, this.limits)
        try {
          const raw = await request.json('/api/market/v1/uploads', { method: 'POST',
            headers: { 'content-type': 'application/zip', 'x-market-publisher': publisher, 'idempotency-key': key }, body: archive })
          const value = parseMarketPublication(raw, this.limits)
          if (value.publisherId !== publisher || value.sha256 !== localId || value.bytes !== archive.byteLength
            || !isDeepStrictEqual(value.manifest, decoded.manifest)) throw new MarketCloudError('publication-mismatch', 502)
          return value
        }
        catch (error) {
          if (error instanceof MarketCloudError && (error.status >= 500 || error.code === 'account-changed')) {
            throw new WriteUnconfirmed(error.code === 'account-changed' ? error.code : 'publication-unconfirmed',
              error.code === 'account-changed' ? error.status : 503, { requestId: key })
          }
          throw error
        }
      })
    })
  }

  /** Install the archive selected by its catalog digest without choosing a default or changing Session bindings.
   * @param id - Exact cloud publication identity.
   * @param expectedSha256 - Digest the caller observed when selecting the publication.
   * @returns Original cloud metadata and the verified disabled local installation.
   */
  @Remote('installPublication')
  async installPublication(
    id: MarketPublicationId, expectedSha256: string,
  ): Promise<{ publication: MarketPublication; installation: MuseMarketInstallation }> {
    return await this.run(() => this.transport.account(true, async (request) => {
      const selected = parseMarketPublicationId(id)
      if (!/^[a-f0-9]{64}$/u.test(expectedSha256)) throw new MarketCloudError('invalid-digest', 400)
      const publication = parseMarketPublication(await request.json(`/api/market/v1/releases/${selected}`), this.limits)
      if (publication.id !== selected || publication.sha256 !== expectedSha256) throw new MarketCloudError('catalog-changed', 409)
      const archive = await request.archive(`/api/market/v1/releases/${selected}/download`, publication)
      const decoded = readMarketPackage(archive, this.limits)
      if (archive.byteLength !== publication.bytes || marketDigest(archive) !== expectedSha256
        || !isDeepStrictEqual(decoded.manifest, publication.manifest)) throw new MarketCloudError('archive-mismatch', 502)
      await request.assertCurrent()
      const installation = await this.ctx.museMarket.importPackage(archive.toString('base64'))
      return { publication, installation }
    }))
  }

  /** Explicitly submit, approve, reject or withdraw the revision the caller inspected.
   * @param id - Original cloud publication identity.
   * @param revision - Positive revision the caller reviewed; never replaced after a conflict.
   * @param action - Requested transition; submit is separate from private upload.
   * @param note - Explicit review note, at most 2000 characters.
   * @returns Confirmed response or exact matching state read back after an uncertain response.
   */
  @Remote('review')
  async review(id: MarketPublicationId, revision: number, action: MarketReviewAction, note: string): Promise<MarketPublication> {
    return await this.run(() => this.transport.account(true, async (request) => {
      const selected = parseMarketPublicationId(id)
      if (!Number.isSafeInteger(revision) || revision < 1 || !['submit', 'approve', 'reject', 'withdraw'].includes(action)
        || note.length > 2000 || action === 'reject' && note.trim() === '') throw new MarketCloudError('invalid-review', 400)
      const expected = action === 'submit' ? 'pending' : action === 'approve' ? 'published' : action === 'reject' ? 'rejected' : 'withdrawn'
      try {
        const value = parseMarketPublication(await request.json(`/api/market/v1/releases/${selected}/review`, {
          method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ revision, action, note }),
        }), this.limits)
        if (value.id !== selected || value.revision !== revision + 1 || value.status !== expected || value.reviewNote !== note) {
          throw new MarketCloudError('invalid-response', 502)
        }
        return value
      } catch (error) {
        if (!(error instanceof MarketCloudError) || error.status < 500 && error.status !== 409) throw error
        if (error.code === 'account-changed') throw new WriteUnconfirmed(error.code, error.status,
          { publicationId: selected, reviewedRevision: revision })
        let observed: MarketPublication | undefined
        try {
          observed = parseMarketPublication(await request.json(`/api/market/v1/releases/${selected}`), this.limits)
          if (observed.id !== selected) throw new MarketCloudError('invalid-response', 502)
        } catch (readError) {
          if (readError instanceof MarketCloudError && readError.code === 'account-changed') {
            throw new WriteUnconfirmed(readError.code, readError.status, { publicationId: selected, reviewedRevision: revision })
          }
          throw new WriteUnconfirmed('review-unconfirmed', 503, { publicationId: selected, reviewedRevision: revision })
        }
        if (error.status >= 500 && observed.revision === revision + 1 && observed.status === expected
          && observed.reviewNote === note) return observed
        throw new WriteUnconfirmed(error.status === 409 ? 'cloud-conflict' : 'review-unconfirmed', error.status === 409 ? 409 : 503,
          { publicationId: selected, reviewedRevision: revision, observed })
      }
    }))
  }
}
