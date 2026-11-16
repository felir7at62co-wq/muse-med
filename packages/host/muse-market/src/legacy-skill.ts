/** Node hashing adapter for deterministic original Skill conversion. */
import { MarketError } from './format-values.ts'
import { completeLegacySkillFiles, officeHelperSha256, readLegacySkillContent } from './legacy-content.ts'
import { createMarketPackage, marketDigest } from './package.ts'
import type { MarketLegacyResource } from './legacy.ts'
import type { MarketLimits } from './types.ts'

/** Preserve one original Skill's resources while adding a canonical publication manifest.
 * @param resource - Validated selected original resource.
 * @param archive - Original ZIP bytes matching the catalog's length and SHA-256.
 * @param limits - Local compressed, expanded, entry and manifest bounds.
 * @returns Deterministic canonical bytes; only the reviewed Office helper is relocated with its reference updated.
 */
export function createLegacySkillPackage(resource: MarketLegacyResource, archive: Uint8Array, limits: MarketLimits): Uint8Array {
  if (!archive.byteLength || archive.byteLength > limits.archiveBytes) throw new MarketError('archive-too-large')
  if (archive.byteLength !== resource.bytes || marketDigest(archive) !== resource.sha256) throw new MarketError('digest-mismatch')
  const content = readLegacySkillContent(resource, archive, limits)
  if (content.officeHelper !== undefined && marketDigest(content.officeHelper) !== officeHelperSha256) throw new MarketError('digest-mismatch')
  return createMarketPackage(content.manifest, completeLegacySkillFiles(content), limits)
}
