/** Shared archive structure checks and deterministic encoding for Node and browser hashing adapters. */
import { unzipSync, zipSync } from 'fflate'
import { MarketError, marketManifest, marketPath, marketRecord, marketSkill } from './format.ts'
import type { MarketLimits, MarketManifest } from './types.ts'

/** Decoded resources and their declared hashes, before cryptographic verification. */
export interface MarketPackageContent {
  readonly manifest: ReturnType<typeof marketManifest>
  readonly files: Readonly<Record<string, Uint8Array>>
  readonly hashes: ReadonlyMap<string, string>
  readonly skillInstructions: Uint8Array
}

/** Decode bounded archive structure without accepting its declared resource hashes as verified.
 * @param archive - Complete owned ZIP bytes.
 * @param limits - Deployment archive, expansion and record limits.
 * @returns Structurally validated content and resource hash claims requiring verification.
 */
export function readMarketPackageContent(archive: Uint8Array, limits: MarketLimits): MarketPackageContent {
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
  const hashes = new Map<string, string>()
  for (const item of envelope.files) {
    if (!marketRecord(item) || typeof item.path !== 'string' || hashes.has(item.path)) throw new MarketError('file-mismatch')
    const bytes = files[item.path]
    if (!bytes || bytes.byteLength !== item.bytes || typeof item.sha256 !== 'string'
      || !/^[a-f0-9]{64}$/u.test(item.sha256)) throw new MarketError('file-mismatch')
    hashes.set(item.path, item.sha256)
  }
  if (Object.values(entries).reduce((sum, bytes) => sum + bytes.byteLength, 0) > limits.expandedBytes) throw new MarketError('expanded-limit')
  const skill = manifest.skills[0]
  if (Object.keys(files).some(path => !path.startsWith(`skills/${skill.name}/`))) throw new MarketError('undeclared-skill')
  const instructions = files[skill.path]
  if (!instructions) throw new MarketError('missing-skill')
  try { marketSkill(new TextDecoder('utf-8', { fatal: true }).decode(instructions), skill.name) }
  catch (_error) { throw new MarketError('invalid-skill') }
  return { manifest, files, hashes, skillInstructions: instructions }
}

/** Encode the same deterministic ZIP from resources and independently computed hashes.
 * @param manifest - Author metadata and the one Skill entry.
 * @param files - Owned portable resource names and bytes.
 * @param hashes - SHA-256 for every resource.
 * @returns Encoded ZIP requiring ordinary complete package validation.
 */
export function encodeMarketPackageContent(
  manifest: MarketManifest, files: Readonly<Record<string, Uint8Array>>, hashes: ReadonlyMap<string, string>,
): Uint8Array {
  const captured = new Map(Object.entries(files))
  const ordered = [...captured.keys()].sort().map(path => [path, captured.get(path) as Uint8Array] as const)
  const rows = ordered.map(([path, bytes]) => {
    const sha256 = hashes.get(path)
    if (sha256 === undefined) throw new MarketError('file-mismatch')
    return { path, bytes: bytes.byteLength, sha256 }
  })
  return zipSync({ ...Object.fromEntries(ordered),
    'muse-package.json': new TextEncoder().encode(JSON.stringify({ ...manifest, files: rows })) }, { mtime: new Date(1980, 0, 1) })
}
