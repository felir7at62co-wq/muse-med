/** Public original Skill catalog records, separate from moderated cloud publications. */
import { brandString, type Branded } from '@deepseek-ai/dsh-brand'
import { MarketCloudError } from './cloud-protocol.ts'
import { marketMetadata, marketRecord, marketText } from './format-values.ts'
import type { MarketLimits, MarketReleaseId } from './types.ts'

/** Stable original-catalog identity; it is neither a publication id nor an archive digest. */
export type MarketLegacyResourceId = Branded<'MarketLegacyResourceId'>

/** Metadata for one original Skill ZIP served without account credentials. */
export interface MarketLegacyResource {
  readonly id: MarketLegacyResourceId
  readonly name: string
  readonly title: string
  readonly description: string
  readonly category: string
  readonly version: string
  readonly requirements: readonly string[]
  readonly requiredSkills: readonly string[]
  readonly validation: string
  readonly sha256: string
  readonly bytes: number
  readonly downloadPath: string
  /** Verified canonical local archive for this exact original digest, when installed. */
  readonly installationId?: MarketReleaseId
}

/** Validate an original Skill catalog identity.
 * @param value - Untrusted selected resource identity.
 * @returns The validated unchanged catalog identity.
 */
export function parseMarketLegacyResourceId(value: unknown): MarketLegacyResourceId {
  if (typeof value !== 'string' || value.length > 160 || !/^muse\/skills\/[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(value)) {
    throw new MarketCloudError('invalid-legacy-resource', 400)
  }
  return brandString<MarketLegacyResourceId>(value)
}

/** Confine anonymous downloads to one non-encoded ZIP filename below the market directory.
 * @param value - Complete same-origin request path.
 * @returns Whether the path names a direct public market ZIP.
 */
export function isMarketLegacyDownloadPath(value: string): boolean {
  return value.length <= 240 && /^\/market\/downloads\/[a-zA-Z0-9][a-zA-Z0-9._-]*\.zip$/u.test(value)
}

/** Decode original catalog metadata without fetching images or executing archive content.
 * @param value - Parsed original catalog JSON.
 * @param query - Space-separated search words; empty selects the complete Skill catalog.
 * @param limits - Local archive admission bounds.
 * @param maximum - Maximum source catalog entries, including entries hidden from this Skill-only view.
 * @returns Matching original Skills with safe same-origin download paths.
 */
export function parseMarketLegacyCatalog(value: unknown, query: string, limits: MarketLimits, maximum: number): MarketLegacyResource[] {
  if (query.length > 200) throw new MarketCloudError('invalid-query', 400)
  try {
    if (!marketRecord(value) || value.schemaVersion !== 1 || !Array.isArray(value.entries)
      || value.entries.length > maximum) throw new Error('Invalid original catalog')
    const items: MarketLegacyResource[] = []
    for (const row of value.entries) {
      if (!marketRecord(row) || row.kind !== 'skill' && row.kind !== 'bot') throw new Error('Invalid original resource')
      if (row.kind === 'bot') continue
      const id = parseMarketLegacyResourceId(row.id), name = id.slice('muse/skills/'.length)
      if (row.slug !== name || typeof row.package !== 'string' || !isMarketLegacyDownloadPath(`/market/${row.package}`)
        || typeof row.sha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(row.sha256)
        || typeof row.bytes !== 'number' || !Number.isSafeInteger(row.bytes) || row.bytes < 1 || row.bytes > limits.archiveBytes
        || !marketText(row.validation, 2000)) throw new Error('Invalid original metadata')
      const metadata = marketMetadata({ name, title: row.name, description: row.description, category: row.category,
        version: row.version, requirements: row.requirements, license: 'NOASSERTION', examples: [] })
      const requiredSkills = row.requiredSkills ?? []
      if (!Array.isArray(requiredSkills) || requiredSkills.length > 100
        || !requiredSkills.every(item => marketText(item, 160))) throw new Error('Invalid original dependencies')
      items.push({ id, name, title: metadata.title, description: metadata.description, category: metadata.category,
        version: metadata.version, requirements: metadata.requirements, requiredSkills, validation: row.validation,
        sha256: row.sha256, bytes: row.bytes, downloadPath: `/market/${row.package}` })
    }
    if (new Set(items.map(item => item.id)).size !== items.length) throw new Error('Duplicate original resource')
    const words = query.toLowerCase().trim().split(/\s+/u)
    return items.filter(item => words.every(word => [item.name, item.title, item.description, item.category].join(' ').toLowerCase().includes(word)))
  } catch (error) { throw new MarketCloudError('invalid-response', 502, { cause: error }) }
}
