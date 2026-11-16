/** Shared discovery metadata over published releases and original Skill resources. */
import type { MarketActions, MarketInstallation, MarketLegacyResource, MarketPublication } from './market-actions.ts'

interface ListingDetails {
  readonly key: string
  readonly name: string
  readonly title: string
  readonly description: string
  readonly version: string
  readonly category: string
  readonly sha256: string
  readonly bytes: number
  readonly requirements: readonly string[]
  readonly presetPortrait?: string
}

/** Discovery identity stays separate from the canonical installed archive identity. */
export type MarketListing = ListingDetails & (
  { readonly source: 'publication'; readonly publication: MarketPublication }
  | { readonly source: 'legacy'; readonly resource: MarketLegacyResource }
)

/** Combine current published and original catalogs, retaining distinct publishers and source identities.
 * @param publications - Validated server publications.
 * @param legacy - Validated original resources.
 * @param query - Local search text shared by both sources.
 * @param category - Selected exact category or empty for all categories.
 * @returns One entry per source identity, including distinct publishers with the same name and version.
 */
export function marketListings(publications: readonly MarketPublication[], legacy: readonly MarketLegacyResource[], query = '', category = ''): MarketListing[] {
  const current = publications.filter(item => item.status === 'published').map((publication): MarketListing => ({
    ...publication.manifest, source: 'publication', publication, sha256: publication.sha256, bytes: publication.bytes,
    key: `publication:${publication.id}:${publication.sha256}`,
  }))
  const originals = legacy.map((resource): MarketListing => ({
    ...resource, source: 'legacy', resource, key: `legacy:${resource.id}:${resource.sha256}`,
  }))
  const normalized = query.normalize('NFKC').trim().toLowerCase()
  const identities = new Set<string>()
  return [...current, ...originals].filter((item) => {
    const identity = item.source === 'publication' ? `publication:${item.publication.id}` : `legacy:${item.resource.id}`
    if (identities.has(identity)) return false
    identities.add(identity)
    return (!category || item.category === category)
    && (!normalized || [item.name, item.title, item.description, item.category,
      item.source === 'publication' ? item.publication.publisher : ''].join(' ').normalize('NFKC').toLowerCase().includes(normalized))
  })
}

/** Find a confirmed canonical installation without inferring a converted archive from its name.
 * @param item - Discovery entry with its original archive digest.
 * @param installed - Current authoritative local installations.
 * @param confirmed - In-memory source-to-canonical identities confirmed by successful imports.
 * @returns The exact installed release, if its identity is known.
 */
export function listingInstallation(item: MarketListing, installed: readonly MarketInstallation[], confirmed: Readonly<Record<string, MarketInstallation['release']['id']>>): MarketInstallation | undefined {
  const id = item.source === 'legacy' ? item.resource.installationId ?? confirmed[item.key] : confirmed[item.key]
  return installed.find(local => id !== undefined ? local.release.id === id
    : item.source === 'publication' && local.release.sha256 === item.sha256)
}

/** Install the selected source and digest using its owning Host adapter.
 * @param actions - Actual mounted market operations.
 * @param item - Exact observed discovery entry.
 * @returns Canonical installation returned by the Host, including conversion identity.
 */
export async function installMarketListing(actions: MarketActions, item: MarketListing): Promise<MarketInstallation> {
  return item.source === 'publication'
    ? (await actions.installPublication(item.publication.id, item.sha256)).installation
    : (await actions.installLegacy(item.resource.id, item.sha256)).installation
}

/** Extend discovery by one page when its scroll viewport approaches the end.
 * @param viewport - Current scroll position and viewport dimensions.
 * @param shown - Number of discovery cards already requested.
 * @param total - Number of matching discovery cards.
 * @returns The retained count, or one additional page capped at the matching total.
 */
export function nextMarketListingCount(viewport: Pick<HTMLElement, 'scrollHeight' | 'scrollTop' | 'clientHeight'>, shown: number, total: number): number {
  return viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight < 320 && shown < total
    ? Math.min(shown + 12, total) : shown
}
