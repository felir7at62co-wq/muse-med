/** Same-origin browser transport using the existing authenticated market API. */
import { bindMarketPortrait, MarketError, marketRecord, marketRelease, previewMarketPackage } from '@deepseek-ai/dsh-muse-market/format'
import type { MarketLimits, MarketRelease } from '@deepseek-ai/dsh-muse-market/types'
import type { MarketLegacyResource, MarketWebActions } from '@deepseek-ai/dsh-client-ui-muse-account/src/client/market-web-types.ts'

function legacyResource(value: unknown): MarketLegacyResource {
  if (!marketRecord(value) || (value.kind !== 'bot' && value.kind !== 'skill')
    || typeof value.id !== 'string' || !/^muse\/(?:bots|skills)\/[a-z0-9-]+$/.test(value.id)
    || typeof value.name !== 'string' || typeof value.description !== 'string'
    || typeof value.category !== 'string' || typeof value.version !== 'string'
    || typeof value.validation !== 'string'
    || typeof value.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(value.sha256)
    || typeof value.package !== 'string' || !/^downloads\/[a-zA-Z0-9._-]+\.(?:zip|tgz)$/.test(value.package)
    || !Array.isArray(value.requirements) || !value.requirements.every((item: unknown): item is string => typeof item === 'string')) {
    throw new MarketError('invalid-response')
  }
  const requiredSkills: unknown = value.requiredSkills ?? []
  if (!Array.isArray(requiredSkills) || !requiredSkills.every((item: unknown): item is string => typeof item === 'string')) {
    throw new MarketError('invalid-response')
  }
  return {
    id: value.id, kind: value.kind, title: value.name, description: value.description, category: value.category,
    version: value.version, requirements: value.requirements, requiredSkills, validation: value.validation,
    sha256: value.sha256, href: '/market/' + value.package,
  }
}

/** Public deployment configuration; credentials and private storage paths are excluded. */
export interface MarketWebConfig {
  readonly limits: MarketLimits
  readonly allowedPlugins: readonly string[]
  readonly requestTimeoutMs: number
  readonly metadataBytes: number
}

/** Validate the website's public resource policy before starting API requests.
 * @param input Untrusted public configuration JSON.
 * @returns Explicit browser request bounds and admitted Bot plugins.
 */
export function marketWebConfig(input: unknown): MarketWebConfig {
  if (!marketRecord(input) || !marketRecord(input.limits) || !Array.isArray(input.allowedPlugins)
    || !input.allowedPlugins.every((name: unknown) => typeof name === 'string' && /^@deepseek-ai\/dsh-[a-z0-9-]+$/.test(name))) throw Error('invalid-market-config')
  const bounded = (value: unknown, minimum: number, maximum: number): number => {
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum || value > maximum) throw Error('invalid-market-config')
    return value
  }
  return {
    allowedPlugins: input.allowedPlugins,
    limits: { archiveBytes: bounded(input.limits.archiveBytes, 1024, 64 * 1024 * 1024),
      expandedBytes: bounded(input.limits.expandedBytes, 1024, 256 * 1024 * 1024), fileCount: bounded(input.limits.fileCount, 1, 4096) },
    requestTimeoutMs: bounded(input.requestTimeoutMs, 1000, 300000),
    metadataBytes: bounded(input.metadataBytes, 1024, 64 * 1024 * 1024),
  }
}

/** Read a complete bounded response while releasing its stream reader on every outcome.
 * @param response Fetch response owned by the caller.
 * @param maximum Maximum admitted response bytes.
 * @returns Complete response bytes.
 */
export async function readMarketBody(response: Response, maximum: number): Promise<Uint8Array> {
  const declared = response.headers.get('content-length')
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > maximum)) {
    await response.body?.cancel(); throw new MarketError('invalid-response')
  }
  const reader = response.body?.getReader()
  if (!reader) throw new MarketError('invalid-response')
  const chunks: Uint8Array[] = []; let length = 0
  try {
    while (true) {
      const part = await reader.read()
      if (part.done) break
      length += part.value.length
      if (length > maximum) throw new MarketError('invalid-response')
      chunks.push(part.value)
    }
  } finally { try { await reader.cancel() } finally { reader.releaseLock() } }
  const bytes = new Uint8Array(length); let offset = 0
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length }
  return bytes
}

/** Browser callbacks and cancellation owned by the website root. */
export interface MarketBrowserClient {
  readonly actions: MarketWebActions
  /** Abort active requests and await body-reader release before replacing the client. */
  close(): Promise<void>
}

/** Create a bounded same-origin transport without reading or exposing the account cookie.
 * @param config Validated public deployment limits.
 * @param fetcher Browser fetch, replaceable at the HTTP carrier in transport tests.
 * @returns Cloud publication callbacks and owned-request teardown.
 */
export function createMarketBrowserClient(config: MarketWebConfig, fetcher: typeof fetch = fetch): MarketBrowserClient {
  const lifetime = new AbortController(), pending = new Set<Promise<unknown>>()
  const jsonValue = (bytes: Uint8Array): unknown => {
    try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) }
    catch { throw new MarketError('invalid-response') }
  }
  const request = async (path: string, init: RequestInit = {}, maximum = config.metadataBytes): Promise<Uint8Array> => {
    const work = (async () => {
      lifetime.signal.throwIfAborted()
      const response = await fetcher(path, { ...init, credentials: 'same-origin', mode: 'same-origin',
        redirect: 'manual', signal: AbortSignal.any([lifetime.signal, AbortSignal.timeout(config.requestTimeoutMs)]) })
      if (response.status === 401 || response.status === 303 || response.type === 'opaqueredirect') {
        await response.body?.cancel(); throw new MarketError('login-required', 401)
      }
      if (!response.ok) {
        if (response.status === 400 || response.status === 404) {
          const value = jsonValue(await readMarketBody(response, Math.min(config.metadataBytes, 16384)))
          if (marketRecord(value) && typeof value.error === 'string') {
            if (['invalid-manifest', 'invalid-path', 'expanded-limit', 'invalid-release', 'archive-too-large'].includes(value.error)) {
              throw new MarketError(value.error, response.status)
            }
            if (['invalid-archive', 'file-mismatch', 'missing-skill', 'undeclared-skill', 'invalid-skill'].includes(value.error)) {
              throw new MarketError('invalid-archive', response.status)
            }
            if (value.error === 'not-found') throw new MarketError('invalid-release', response.status)
          }
          throw new MarketError('cloud-unavailable', response.status)
        }
        await response.body?.cancel()
        throw new MarketError(response.status === 403 ? 'publisher-required'
          : response.status === 409 ? 'cloud-conflict' : response.status === 413 ? 'archive-too-large'
            : response.status === 429 ? 'rate-limited' : 'cloud-unavailable', response.status)
      }
      const bytes = await readMarketBody(response, maximum)
      lifetime.signal.throwIfAborted()
      return bytes
    })()
    pending.add(work)
    try { return await work }
    catch (error) {
      if (error instanceof MarketError || lifetime.signal.aborted) throw error
      throw new MarketError('cloud-unavailable')
    } finally { pending.delete(work) }
  }
  const json = async (path: string, init?: RequestInit): Promise<unknown> => jsonValue(await request('/api/market/v1' + path, init))
  const releaseId = (id: string): void => { if (!/^[a-f0-9]{32,64}$/.test(id)) throw new MarketError('invalid-release') }
  return {
    actions: {
      archiveBytes: config.limits.archiveBytes,
      legacyCatalog: async (query, kind) => {
        const value = jsonValue(await request('/market/catalog.json', {}, Math.min(config.metadataBytes, 1024 * 1024)))
        if (!marketRecord(value) || !Array.isArray(value.entries) || value.entries.length > 500) throw new MarketError('invalid-response')
        const entries = value.entries.map(legacyResource)
        if (new Set(entries.map(entry => entry.id)).size !== entries.length) throw new MarketError('invalid-response')
        const words = query.toLowerCase().trim().split(/\s+/)
        return entries.filter((entry) => {
          const searchable = [entry.title, entry.description, entry.category].join(' ').toLowerCase()
          return (!kind || kind === entry.kind) && words.every(word => searchable.includes(word))
        })
      },
      catalog: async (q, kind, mine) => {
        const value = await json('/catalog?' + new URLSearchParams({ q, kind, mine: String(mine) }).toString())
        if (!marketRecord(value) || !Array.isArray(value.items)) throw new MarketError('invalid-response')
        return value.items.map(row => marketRelease(row, config.allowedPlugins))
      },
      identity: async () => {
        const value = await json('/me')
        if (!marketRecord(value) || !Array.isArray(value.publishers) || typeof value.admin !== 'boolean') throw new MarketError('invalid-response')
        const publishers = value.publishers.map((row: unknown) => {
          if (!marketRecord(row) || typeof row.id !== 'string' || !/^[a-f0-9]{32}$/.test(row.id)
            || typeof row.title !== 'string' || !row.title.trim() || row.title.length > 100) throw new MarketError('invalid-response')
          return { id: row.id, title: row.title }
        })
        return { publishers, admin: value.admin }
      },
      previewArchive: archive => Promise.resolve().then(() => previewMarketPackage(archive, config.limits, config.allowedPlugins)),
      uploadArchive: async (archive, publisherId, requestId, portrait) => {
        if (portrait) archive = bindMarketPortrait(archive, portrait, config.limits, config.allowedPlugins)
        if (!/^[a-f0-9]{32}$/.test(publisherId) || !/^[A-Za-z0-9_-]{8,128}$/.test(requestId)) throw new MarketError('invalid-selection')
        if (!archive.length || archive.length > config.limits.archiveBytes) throw new MarketError('archive-too-large', 413)
        return marketRelease(await json('/uploads', { method: 'POST', headers: { 'content-type': 'application/zip',
          'x-market-publisher': publisherId, 'idempotency-key': requestId }, body: new Blob([Uint8Array.from(archive)]) }), config.allowedPlugins)
      },
      downloadArchive: async (release: MarketRelease) => {
        releaseId(release.id)
        const bytes = await request('/api/market/v1/releases/' + release.id + '/download', {}, config.limits.archiveBytes)
        const hash = new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', Uint8Array.from(bytes)))
        const digest = [...hash].map(value => value.toString(16).padStart(2, '0')).join('')
        lifetime.signal.throwIfAborted()
        if (digest !== release.sha256 || bytes.length !== release.bytes) throw new MarketError('invalid-archive')
        return { name: release.manifest.name + '-' + release.manifest.version + '.zip', bytes }
      },
      review: async (id, revision, action, note) => {
        releaseId(id)
        return marketRelease(await json('/releases/' + id + '/review', { method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ revision, action, note }) }), config.allowedPlugins)
      },
    },
    close: async () => { lifetime.abort(); await Promise.allSettled(pending) },
  }
}
