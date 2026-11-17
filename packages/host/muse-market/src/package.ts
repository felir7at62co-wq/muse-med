/** Synchronous Node hashing adapter for bounded Skill publication archives. */
import { createHash } from 'node:crypto'
import { MarketError, marketManifest } from './format.ts'
import { encodeMarketPackageContent, readMarketPackageContent } from './package-content.ts'
import type { MarketLimits, MarketManifest, MarketRelease } from './types.ts'
import type { MarketReleaseId } from './types.ts'

/** Hash exact publication or resource bytes.
 * @param bytes - Complete bytes.
 * @returns Lowercase SHA-256.
 */
export function marketDigest(bytes: Uint8Array): string { return createHash('sha256').update(bytes).digest('hex') }

/** Decode an archive only after validating every declared file and digest.
 * @param archive - Complete publication ZIP.
 * @param limits - Resolved deployment limits.
 * @returns Validated singleton manifest, exact resource bytes and the required Skill instructions.
 */
export function readMarketPackage(archive: Uint8Array, limits: MarketLimits): {
  manifest: ReturnType<typeof marketManifest>
  files: Readonly<Record<string, Uint8Array>>
  skillInstructions: Uint8Array
} {
  const { manifest, files, hashes, skillInstructions } = readMarketPackageContent(archive, limits)
  for (const [path, bytes] of Object.entries(files)) {
    if (marketDigest(bytes) !== hashes.get(path)) throw new MarketError('file-mismatch')
  }
  return { manifest, files, skillInstructions }
}

/** Create a deterministic publication over an explicit resource set.
 * @param manifest - Author metadata and the one Skill entry.
 * @param files - Complete portable resource names and bytes.
 * @param limits - Resolved deployment limits.
 * @returns Validated ZIP bytes.
 */
export function createMarketPackage(
  manifest: MarketManifest, files: Readonly<Record<string, Uint8Array>>, limits: MarketLimits,
): Uint8Array {
  const hashes = new Map(Object.entries(files).map(([path, bytes]) => [path, marketDigest(bytes)]))
  const archive = encodeMarketPackageContent(manifest, files, hashes)
  readMarketPackage(archive, limits)
  return archive
}

/** Derive local release identity solely from verified archive bytes.
 * @param archive - Complete publication ZIP.
 * @param limits - Resolved deployment limits.
 * @returns Immutable release metadata.
 */
export function marketRelease(archive: Uint8Array, limits: MarketLimits): MarketRelease {
  const { manifest } = readMarketPackage(archive, limits), sha256 = marketDigest(archive)
  return { id: sha256 as MarketReleaseId, sha256, bytes: archive.byteLength, manifest }
}
