/** Browser adapter for the existing account gateway and the shared Skill package format. */
import { createLegacySkillPackageBrowser, isMarketLegacyDownloadPath, marketDigestBrowser,
  parseMarketLegacyCatalog, prepareMarketUploadBrowser, readMarketPackageBrowser } from '@deepseek-ai/dsh-muse-market/browser'
import { parseMarketAccountId, parseMarketIdentity, parseMarketPublication, parseMarketPublicationId,
  parseMarketPublisherId, parseMarketUploadRequestId } from '@deepseek-ai/dsh-muse-market/cloud-values'
import { marketRecord } from '@deepseek-ai/dsh-muse-market/src/format-values.ts'
import type { MarketBrowserActions } from '@deepseek-ai/dsh-client-ui-muse-market/src/client/market-browser-actions.ts'
import type { MarketAccountId, MarketIdentity } from '@deepseek-ai/dsh-muse-market/cloud-values'
import { createMarketTransport, MarketWebError, type MarketWebConfig } from './transport.ts'

export { marketWebConfig, readMarketBody } from './transport.ts'
export type { MarketWebConfig } from './transport.ts'

/** A same-origin market adapter and the lifetime of its pending network work. */
export interface MarketBrowserClient {
  readonly actions: MarketBrowserActions
  close(): Promise<void>
}

/** Create browser operations without inventing local installation or activation state.
 * @param config - Validated public resource policy.
 * @param fetcher - Same-origin browser fetch or a test HTTP carrier.
 * @returns Typed shared-page operations and cancellation.
 */
export function createMarketBrowserClient(config: MarketWebConfig, fetcher: typeof fetch = fetch): MarketBrowserClient {
  const transport = createMarketTransport(config, fetcher)
  const publication = (value: unknown) => {
    try { return parseMarketPublication(value, config.limits) }
    catch (_error) { throw new MarketWebError('invalid-response', 502) }
  }
  const account = async (): Promise<MarketAccountId> => {
    const value = await transport.json('/api/muse.account')
    if (!marketRecord(value)) throw new MarketWebError('invalid-response', 502)
    return parseMarketAccountId(value.accountId)
  }
  const identity = async (): Promise<MarketIdentity> => {
    const before = await account(), value = await transport.json('/api/market/v1/me'), after = await account()
    if (before !== after) throw new MarketWebError('account-changed', 409)
    if (!marketRecord(value)) throw new MarketWebError('invalid-response', 502)
    const parsed = Object.hasOwn(value, 'accountId') ? parseMarketIdentity(value)
      : parseMarketIdentity({ ...value, accountId: before })
    if (parsed.accountId !== before) throw new MarketWebError('account-changed', 409)
    return parsed
  }
  const current = async (expected: MarketAccountId): Promise<MarketIdentity> => {
    const value = await identity()
    if (value.accountId !== expected) throw new MarketWebError('account-changed', 409)
    return value
  }
  const verified = async (bytes: Uint8Array, sha256: string, length: number): Promise<void> => {
    if (bytes.byteLength !== length || await marketDigestBrowser(bytes) !== sha256) throw new MarketWebError('digest-mismatch')
  }
  const getPublication = async (id: Parameters<MarketBrowserActions['getPublication']>[0]) => {
    const selected = parseMarketPublicationId(id)
    const item = publication(await transport.json('/api/market/v1/releases/' + selected))
    if (item.id !== selected) throw new MarketWebError('invalid-response', 502)
    return item
  }
  return {
    actions: {
      archiveBytes: config.limits.archiveBytes,
      identity,
      catalog: async (query, mine) => {
        if (query.length > 200) throw new MarketWebError('invalid-query')
        const search = new URLSearchParams({ q: '', mine: String(mine), kind: 'skill' })
        const value = await transport.json('/api/market/v1/catalog?' + search.toString(), { credentials: mine ? 'same-origin' : 'omit' })
        if (!marketRecord(value) || !Array.isArray(value.items) || value.items.length > config.catalogLimit) {
          throw new MarketWebError('invalid-response', 502)
        }
        const items = value.items.map(publication)
        if (!mine && items.some(item => item.status !== 'published')) throw new MarketWebError('invalid-response', 502)
        const words = query.trim().toLowerCase().split(/\s+/u)
        return items.filter(item => words.every(word => [item.manifest.name, item.manifest.title,
          item.manifest.description, item.manifest.category, item.publisher, ...item.manifest.skills.map(skill => skill.name)]
          .join(' ').toLowerCase().includes(word)))
      },
      legacyCatalog: async query => parseMarketLegacyCatalog(await transport.json('/market/catalog.json', { credentials: 'omit' }), query,
        config.limits, config.catalogLimit),
      getPublication,
      previewArchive: async bytes => (await readMarketPackageBrowser(bytes, config.limits)).manifest,
      prepareArchive: async (bytes, portrait) => {
        const prepared = await prepareMarketUploadBrowser(bytes, portrait, config.limits)
        return { bytes: prepared, manifest: (await readMarketPackageBrowser(prepared, config.limits)).manifest }
      },
      uploadArchive: async (bytes, publisherId, requestId, accountId) => {
        const owned = new Uint8Array(bytes)
        const inspected = await readMarketPackageBrowser(owned, config.limits)
        const actor = await current(accountId)
        const team = parseMarketPublisherId(publisherId), key = parseMarketUploadRequestId(requestId)
        if (!actor.publishers.some(row => row.id === team)) throw new MarketWebError('permission-denied', 403)
        const saved = publication(await transport.json('/api/market/v1/uploads', {
          method: 'POST', headers: { 'content-type': 'application/zip', 'x-market-publisher': team,
            'idempotency-key': key, 'x-muse-market-account': accountId },
          body: new Blob([owned]),
        }))
        await current(accountId)
        await verified(owned, saved.sha256, saved.bytes)
        if (saved.publisherId !== team || JSON.stringify(saved.manifest) !== JSON.stringify(inspected.manifest)) {
          throw new MarketWebError('invalid-response', 502)
        }
        return saved
      },
      downloadPublication: async (item) => {
        const id = parseMarketPublicationId(item.id)
        const expected = item.status === 'published' ? undefined : (await identity()).accountId
        const bytes = await transport.request(`/api/market/v1/releases/${id}/download`, {}, config.limits.archiveBytes)
        await verified(bytes, item.sha256, item.bytes)
        const { manifest } = await readMarketPackageBrowser(bytes, config.limits)
        if (JSON.stringify(manifest) !== JSON.stringify(item.manifest)) throw new MarketWebError('invalid-response', 502)
        if (expected !== undefined) await current(expected)
        return { name: `${manifest.name}-${manifest.version}.zip`, bytes }
      },
      downloadLegacy: async (resource) => {
        if (!isMarketLegacyDownloadPath(resource.downloadPath)) throw new MarketWebError('invalid-cloud-path')
        const original = await transport.request(resource.downloadPath, { credentials: 'omit' }, config.limits.archiveBytes)
        const bytes = await createLegacySkillPackageBrowser(resource, original, config.limits)
        return { name: `${resource.name}-${resource.version}.zip`, bytes }
      },
      review: async (id, revision, action, note, accountId) => {
        if (!Number.isSafeInteger(revision) || revision < 1 || note.length > 2000
          || !['submit', 'approve', 'reject', 'withdraw'].includes(action)
          || action === 'reject' && !note.trim()) throw new MarketWebError('invalid-review')
        await current(accountId)
        const selected = parseMarketPublicationId(id)
        const expected = action === 'submit' ? 'pending' : action === 'approve' ? 'published'
          : action === 'reject' ? 'rejected' : 'withdrawn'
        const confirms = (item: ReturnType<typeof publication>): boolean => item.id === selected
          && item.revision === revision + 1 && item.status === expected && item.reviewNote === note
        try {
          const item = publication(await transport.json(`/api/market/v1/releases/${selected}/review`, {
            method: 'POST', headers: { 'content-type': 'application/json', 'x-muse-market-account': accountId },
            body: JSON.stringify({ revision, action, note }),
          }))
          await current(accountId)
          if (!confirms(item)) throw new MarketWebError('invalid-response', 502)
          return item
        } catch (error) {
          if (!(error instanceof MarketWebError) || error.details.code === 'account-changed'
            || error.details.status < 500 && error.details.status !== 409) throw error
          const observed = await getPublication(selected)
          await current(accountId)
          if (error.details.status >= 500 && confirms(observed)) return observed
          throw new MarketWebError(error.details.status === 409 ? 'cloud-conflict' : 'review-unconfirmed',
            error.details.status === 409 ? 409 : 503)
        }
      },
    },
    close: transport.close,
  }
}
