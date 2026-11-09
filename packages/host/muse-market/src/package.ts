/** Bounded, digest-checked publication archives containing one Skill and its resources. */
import { createHash } from 'node:crypto'
import { unzipSync, zipSync } from 'fflate'
import { MarketError, marketManifest, marketPath, marketRecord, marketSkill } from './format.ts'
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
 * @returns Manifest and exact resource bytes.
 */
export function readMarketPackage(archive: Uint8Array, limits: MarketLimits): {
  manifest: MarketManifest
  files: Readonly<Record<string, Uint8Array>>
} {
  if (!archive.byteLength || archive.byteLength > limits.archiveBytes) throw new MarketError('archive-too-large')
  let expanded = 0, count = 0
  const names = new Set<string>()
  let entries: Record<string, Uint8Array>
  try {
    entries = unzipSync(archive, { filter(entry) {
      if (++count > limits.fileCount) throw new MarketError('expanded-limit')
      const directory = entry.name.endsWith('/')
      const path = directory ? entry.name.slice(0, -1) : entry.name
      const key = path.normalize('NFC').toLowerCase()
      if (!marketPath(path) || names.has(key) || key === 'publication.zip') throw new MarketError('invalid-path')
      names.add(key)
      expanded += entry.originalSize
      if (expanded > limits.expandedBytes) throw new MarketError('expanded-limit')
      return !directory
    } })
  } catch (error) {
    if (error instanceof MarketError) throw error
    throw new MarketError('invalid-archive')
  }
  const raw = entries['muse-package.json']
  if (!raw || raw.byteLength > limits.recordBytes) throw new MarketError('invalid-manifest')
  let envelope: unknown
  try { envelope = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(raw)) }
  catch (_error) { throw new MarketError('invalid-manifest') }
  const manifest = marketManifest(envelope)
  if (!marketRecord(envelope) || !Array.isArray(envelope.files)) throw new MarketError('file-mismatch')
  const files = Object.fromEntries(Object.entries(entries).filter(([path]) => path !== 'muse-package.json'))
  if (envelope.files.length !== Object.keys(files).length) throw new MarketError('file-mismatch')
  const declared = new Set<string>()
  for (const item of envelope.files) {
    if (!marketRecord(item) || typeof item.path !== 'string' || declared.has(item.path)) throw new MarketError('file-mismatch')
    declared.add(item.path)
    const bytes = files[item.path]
    if (!bytes || bytes.byteLength !== item.bytes || marketDigest(bytes) !== item.sha256) throw new MarketError('file-mismatch')
  }
  if (Object.values(entries).reduce((sum, bytes) => sum + bytes.byteLength, 0) > limits.expandedBytes) throw new MarketError('expanded-limit')
  const skill = manifest.skills[0]
  if (skill === undefined) throw new MarketError('invalid-manifest')
  if (Object.keys(files).some(path => !path.startsWith(`skills/${skill.name}/`))) throw new MarketError('undeclared-skill')
  const instructions = files[skill.path]
  if (!instructions) throw new MarketError('missing-skill')
  try { marketSkill(new TextDecoder('utf-8', { fatal: true }).decode(instructions), skill.name) }
  catch (_error) { throw new MarketError('invalid-skill') }
  return { manifest, files }
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
  const ordered = Object.entries(files).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
  const rows = ordered
    .map(([path, bytes]) => ({ path, bytes: bytes.byteLength, sha256: marketDigest(bytes) }))
  const archive = zipSync({ ...Object.fromEntries(ordered),
    'muse-package.json': Buffer.from(JSON.stringify({ ...manifest, files: rows })) }, { mtime: new Date(1980, 0, 1) })
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
