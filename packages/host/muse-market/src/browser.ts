/** Browser-safe asynchronous package verification and preparation using Web Crypto. */
import { MarketError, marketMetadata, type marketManifest } from './format-values.ts'
import { completeLegacySkillFiles, officeHelperSha256, readLegacySkillContent } from './legacy-content.ts'
import { encodeMarketPackageContent, readMarketPackageContent } from './package-content.ts'
import type { MarketLegacyResource } from './legacy.ts'
import type { MarketLimits, MarketManifest, MarketRelease, MarketReleaseId } from './types.ts'

export { MarketError } from './format-values.ts'
export { parseMarketLegacyCatalog, parseMarketLegacyResourceId, isMarketLegacyDownloadPath } from './legacy.ts'
export type { MarketLegacyResource, MarketLegacyResourceId } from './legacy.ts'
export type { MarketLimits, MarketManifest, MarketMetadata, MarketRelease } from './types.ts'

/** Hash a snapshot of complete bytes in a secure browser context.
 * @param bytes - Publication or resource bytes.
 * @returns Lowercase SHA-256; refuses when Web Crypto is unavailable.
 */
export async function marketDigestBrowser(bytes: Uint8Array): Promise<string> {
  const runtime: { readonly crypto?: { readonly subtle?: typeof globalThis.crypto.subtle } } = globalThis
  const subtle = runtime.crypto?.subtle
  if (subtle === undefined) throw new MarketError('crypto-unavailable')
  const digest = await subtle.digest('SHA-256', new Uint8Array(bytes).buffer)
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('')
}

function archiveSnapshot(archive: Uint8Array, limits: MarketLimits): Uint8Array {
  if (!archive.byteLength || archive.byteLength > limits.archiveBytes) throw new MarketError('archive-too-large')
  return new Uint8Array(archive)
}

async function verifiedContent(archive: Uint8Array, limits: MarketLimits) {
  const { manifest, files, hashes, skillInstructions } = readMarketPackageContent(archive, limits)
  for (const [path, bytes] of Object.entries(files)) {
    if (await marketDigestBrowser(bytes) !== hashes.get(path)) throw new MarketError('file-mismatch')
  }
  return { manifest, files, skillInstructions }
}

/** Verify a canonical Skill ZIP without evaluating its instructions or resources.
 * @param archive - Complete untrusted ZIP bytes, copied before asynchronous work.
 * @param limits - Compressed, expanded, entry and manifest bounds.
 * @returns Validated metadata and exact resource bytes.
 */
export async function readMarketPackageBrowser(archive: Uint8Array, limits: MarketLimits): Promise<{
  manifest: ReturnType<typeof marketManifest>
  files: Readonly<Record<string, Uint8Array>>
  skillInstructions: Uint8Array
}> {
  return await verifiedContent(archiveSnapshot(archive, limits), { ...limits })
}

/** Create the same canonical bytes as the synchronous Host codec.
 * @param manifest - Complete Skill-only publication metadata.
 * @param files - Complete portable resources, copied before asynchronous work.
 * @param limits - Compressed, expanded, entry and manifest bounds.
 * @returns Verified deterministic ZIP bytes.
 */
export async function createMarketPackageBrowser(
  manifest: MarketManifest, files: Readonly<Record<string, Uint8Array>>, limits: MarketLimits,
): Promise<Uint8Array> {
  const ownedManifest = structuredClone(manifest), ownedLimits = { ...limits }
  const ownedFiles = Object.fromEntries(Object.entries(files).map(([path, bytes]) => [path, new Uint8Array(bytes)]))
  const hashes = new Map<string, string>()
  for (const [path, bytes] of Object.entries(ownedFiles)) hashes.set(path, await marketDigestBrowser(bytes))
  const archive = encodeMarketPackageContent(ownedManifest, ownedFiles, hashes)
  await verifiedContent(archive, ownedLimits)
  return archive
}

/** Derive exact canonical release metadata after complete browser-side verification.
 * @param archive - Complete untrusted ZIP bytes.
 * @param limits - Compressed, expanded, entry and manifest bounds.
 * @returns Release identity derived from the verified original archive bytes.
 */
export async function marketReleaseBrowser(archive: Uint8Array, limits: MarketLimits): Promise<MarketRelease> {
  const owned = archiveSnapshot(archive, limits)
  const { manifest } = await verifiedContent(owned, { ...limits }), sha256 = await marketDigestBrowser(owned)
  return { id: sha256 as MarketReleaseId, sha256, bytes: owned.byteLength, manifest }
}

/** Bind an automatic portrait without changing an existing binding or overwriting the input archive.
 * @param archive - Complete canonical Skill ZIP.
 * @param presetPortrait - Safe presentation asset key chosen by the caller.
 * @param limits - Compressed, expanded, entry and manifest bounds.
 * @returns Original verified bytes when already bound, otherwise a new canonical package with identical resources.
 */
export async function prepareMarketUploadBrowser(
  archive: Uint8Array, presetPortrait: string, limits: MarketLimits,
): Promise<Uint8Array> {
  const owned = archiveSnapshot(archive, limits), ownedLimits = { ...limits }
  const { manifest, files } = await verifiedContent(owned, ownedLimits)
  const metadata = marketMetadata({ ...manifest, presetPortrait })
  if (manifest.presetPortrait !== undefined) return owned
  return await createMarketPackageBrowser({ ...manifest, ...metadata }, files, ownedLimits)
}

/** Convert an original catalog ZIP using the Host's resource and Office-helper rules.
 * @param resource - Validated selected original catalog metadata.
 * @param archive - Complete original ZIP matching its catalog length and SHA-256.
 * @param limits - Compressed, expanded, entry and manifest bounds.
 * @returns The same deterministic canonical bytes produced by the Host converter.
 */
export async function createLegacySkillPackageBrowser(
  resource: MarketLegacyResource, archive: Uint8Array, limits: MarketLimits,
): Promise<Uint8Array> {
  const owned = archiveSnapshot(archive, limits), ownedResource = structuredClone(resource), ownedLimits = { ...limits }
  if (owned.byteLength !== ownedResource.bytes || await marketDigestBrowser(owned) !== ownedResource.sha256) throw new MarketError('digest-mismatch')
  const content = readLegacySkillContent(ownedResource, owned, ownedLimits)
  if (content.officeHelper !== undefined && await marketDigestBrowser(content.officeHelper) !== officeHelperSha256) throw new MarketError('digest-mismatch')
  return await createMarketPackageBrowser(content.manifest, completeLegacySkillFiles(content), ownedLimits)
}
