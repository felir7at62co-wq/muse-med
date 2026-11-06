/** Account-bound market transport; cookies never leave the Host. */
import { readMuseSession } from '@deepseek-ai/dsh-muse-account/session'
import { MarketError, marketLegacyCatalog, marketLegacyId, marketRelease } from './format.ts'
import { marketDigest } from './package.ts'
import type { MarketLegacyResource, MarketRelease } from './types.ts'

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Cloud endpoint and transport bounds. */
export interface MarketCloudConfig {
  readonly baseUrl: string
  readonly sessionFile: string
  readonly requestTimeoutMs: number
  readonly archiveBytes: number
  readonly allowedPlugins: readonly string[]
}

/** Authenticated directory, publication and download operations. */
export class MuseMarketCloud {
  private readonly origin: string
  private readonly lifetime = new AbortController()
  private readonly pending = new Set<Promise<unknown>>()

  constructor(private readonly config: MarketCloudConfig) {
    const url = new URL(config.baseUrl)
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))
      || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error('Invalid market origin')
    this.origin = url.origin
  }

  private async bytes(path: string, init: RequestInit, maximum: number, access: 'required' | 'optional' | 'anonymous'): Promise<Uint8Array> {
    const work = (async () => {
      const session = access === 'anonymous' ? null : await readMuseSession(this.config.sessionFile, this.origin)
      if (access === 'required' && !session) throw new MarketError('login-required', 401)
      const headers = new Headers(init.headers)
      headers.set('origin', this.origin)
      if (session) headers.set('cookie', session.cookie)
      const response = await fetch(this.origin + path, {
        ...init, redirect: 'manual', signal: AbortSignal.any([this.lifetime.signal, AbortSignal.timeout(this.config.requestTimeoutMs)]),
        headers,
      })
      if (!response.ok) {
        await response.body?.cancel()
        throw new MarketError(response.status === 401 || response.status === 303 ? 'login-required'
          : response.status === 403 ? 'publisher-required' : response.status === 409 ? 'cloud-conflict' : 'cloud-unavailable', response.status)
      }
      const reader = response.body?.getReader()
      if (!reader) throw new MarketError('invalid-response')
      const chunks: Uint8Array[] = []; let size = 0
      try {
        while (true) {
          const part = await reader.read()
          if (part.done) break
          size += part.value.byteLength
          if (size > maximum) throw new MarketError('response-too-large', 413)
          chunks.push(part.value)
        }
      } finally { await reader.cancel(); reader.releaseLock() }
      return Buffer.concat(chunks)
    })()
    this.pending.add(work)
    try { return await work }
    finally { this.pending.delete(work) }
  }

  private async json(path: string, init: RequestInit, authenticated = true): Promise<unknown> {
    const bytes = await this.bytes('/api/market/v1' + path, init, Math.max(1024 * 1024, this.config.archiveBytes), authenticated ? 'required' : 'optional')
    try { return JSON.parse(Buffer.from(bytes).toString('utf8')) } catch { throw new MarketError('invalid-response') }
  }

  /** Search the public catalog or the current creator's publications.
   * @param q Search text.
   * @param kind Skill filter, or empty for all available Skills.
   * @param mine Whether to request creator-visible drafts.
   * @returns Validated release metadata.
   */
  async list(q: string, kind: string, mine: boolean): Promise<MarketRelease[]> {
    if (kind && kind !== 'skill') throw new MarketError('skill-only')
    const value = await this.json('/catalog?' + new URLSearchParams({ q, kind: 'skill', mine: String(mine) }).toString(), {}, mine)
    if (!value || typeof value !== 'object' || !('items' in value) || !Array.isArray(value.items)) throw new MarketError('invalid-response')
    return value.items.map(item => marketRelease(item, this.config.allowedPlugins)).filter(item => item.manifest.kind === 'skill')
  }

  /** Read the original public distributions without account credentials.
   * @param query Search text.
   * @param kind Skill filter, or empty for all available Skills.
   * @returns Validated metadata and original download links on the configured cloud origin.
   */
  async legacyCatalog(query: string, kind: string): Promise<MarketLegacyResource[]> {
    if (kind && kind !== 'skill') throw new MarketError('skill-only')
    const bytes = await this.bytes('/market/catalog.json', {}, 1024 * 1024, 'anonymous')
    let value: unknown
    try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) }
    catch { throw new MarketError('invalid-response') }
    return marketLegacyCatalog(value, query, 'skill', this.origin)
  }

  /** Download the exact original archive advertised by the current public catalog.
   * @param id Original catalog identity.
   * @param sha256 Digest displayed when the user selected the resource.
   * @returns Catalog metadata and the verified original archive.
   */
  async downloadLegacy(id: string, sha256: string): Promise<{ resource: MarketLegacyResource; archive: Uint8Array }> {
    if (!marketLegacyId(id) || !/^[a-f0-9]{64}$/.test(sha256)) throw new MarketError('invalid-release')
    if (!id.startsWith('muse/skills/')) throw new MarketError('skill-only')
    const resource = (await this.legacyCatalog('', '')).find(row => row.id === id)
    if (!resource) throw new MarketError('legacy-not-found', 404)
    if (resource.sha256 !== sha256) throw new MarketError('legacy-catalog-changed', 409)
    const archive = await this.bytes(new URL(resource.href).pathname, {}, this.config.archiveBytes, 'anonymous')
    if (marketDigest(archive) !== sha256) throw new MarketError('digest-mismatch')
    return { resource, archive }
  }

  /** Read the signed-in creator's admitted teams and administrator status.
   * @returns Public team identifiers and names without credentials.
   */
  async identity(): Promise<{ publishers: { id: string; title: string }[]; admin: boolean }> {
    const value = await this.json('/me', {})
    if (!value || typeof value !== 'object' || !('publishers' in value) || !Array.isArray(value.publishers)
      || !('admin' in value) || typeof value.admin !== 'boolean') throw new MarketError('invalid-response')
    const publisherRows: unknown[] = value.publishers
    const publishers = publisherRows.map((item) => {
      if (!record(item) || typeof item.id !== 'string' || !/^[a-f0-9]{32}$/.test(item.id)
        || typeof item.title !== 'string' || item.title.length > 100) throw new MarketError('invalid-response')
      return { id: item.id, title: item.title }
    })
    return { publishers, admin: value.admin }
  }

  /** Fetch one release and its authenticated publication file.
   * @param id Selected release identity.
   * @returns Metadata and bounded download bytes for local digest validation.
   */
  async download(id: string): Promise<{ release: MarketRelease; archive: Uint8Array }> {
    if (!/^[a-f0-9]{32,64}$/.test(id)) throw new MarketError('invalid-release')
    const release = marketRelease(await this.json(`/releases/${id}`, {}), this.config.allowedPlugins)
    if (release.manifest.kind !== 'skill') throw new MarketError('skill-only')
    const archive = await this.bytes(`/api/market/v1/releases/${id}/download`, {}, this.config.archiveBytes, 'required')
    return { release, archive }
  }

  /** Upload an explicit local publication as a private draft.
   * @param publisherId Selected creator team.
   * @param requestId Idempotency key retained for retries.
   * @param archive Verified publication bytes.
   * @returns The durable cloud draft.
   */
  async upload(publisherId: string, requestId: string, archive: Uint8Array): Promise<MarketRelease> {
    const value = await this.json('/uploads', { method: 'POST', headers: { 'content-type': 'application/zip',
      'x-market-publisher': publisherId, 'idempotency-key': requestId }, body: Buffer.from(archive) })
    const release = marketRelease(value, this.config.allowedPlugins)
    if (release.manifest.kind !== 'skill') throw new MarketError('skill-only')
    return release
  }

  /** Apply an explicit creator submission or administrator review action.
   * @param id Release identity.
   * @param revision Revision the caller reviewed.
   * @param action Requested transition.
   * @param note Review note.
   * @returns Updated release metadata.
   */
  async review(id: string, revision: number, action: string, note: string): Promise<MarketRelease> {
    if (!/^[a-f0-9]{32,64}$/.test(id)) throw new MarketError('invalid-release')
    const release = marketRelease(await this.json(`/releases/${id}/review`, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ revision, action, note }) }), this.config.allowedPlugins)
    if (release.manifest.kind !== 'skill') throw new MarketError('skill-only')
    return release
  }

  /** Abort requests and await body-reader cleanup before the Host unloads. */
  async close(): Promise<void> { this.lifetime.abort(); await Promise.allSettled([...this.pending]) }
}
