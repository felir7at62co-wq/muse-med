/** Bounded publication archives with explicit files and declarative Bot rows. */
import { createHash } from 'node:crypto'
import { zipSync, unzipSync } from 'fflate'
import type { MarketLimits, MarketManifest } from './types.ts'
import { MarketError, marketRecord, marketPath, marketManifest, marketSkill } from './format.ts'
export { MarketError, marketPath, marketManifest, marketSkill, marketRelease } from './format.ts'

const MANIFEST = 'muse-package.json'

/** SHA-256 of exact publication bytes.
 * @param data Publication or resource bytes.
 * @returns Lowercase hexadecimal digest.
 */
export function marketDigest(data: Uint8Array): string { return createHash('sha256').update(data).digest('hex') }

/** Validate all archive entries before exposing executable content.
 * @param archive Uploaded ZIP bytes.
 * @param limits Deployment-owned compressed and expanded limits.
 * @param allowedPlugins Deployment-owned Bot plugin allowlist.
 * @returns Parsed manifest and exact resource bytes.
 */
export function readMarketPackage(archive: Uint8Array, limits: MarketLimits, allowedPlugins: readonly string[]): {
  manifest: MarketManifest
  files: Readonly<Record<string, Uint8Array>>
} {
  if (!archive.byteLength || archive.byteLength > limits.archiveBytes) throw new MarketError('archive-too-large', 413)
  let expanded = 0
  let count = 0
  const names = new Set<string>()
  let entries: Record<string, Uint8Array>
  try {
    entries = unzipSync(archive, { filter(entry) {
      if (++count > limits.fileCount) throw new MarketError('expanded-limit', 413)
      if (entry.name.toLowerCase() === 'publication.zip') throw new MarketError('invalid-path')
      if (entry.name.endsWith('/')) {
        if (!marketPath(entry.name.slice(0, -1))) throw new MarketError('invalid-path')
        return false
      }
      const key = entry.name.normalize('NFC').toLowerCase()
      if (!marketPath(entry.name) || names.has(key)) throw new MarketError('invalid-path')
      names.add(key); expanded += entry.originalSize
      if (expanded > limits.expandedBytes) throw new MarketError('expanded-limit', 413)
      return true
    } })
  } catch (error) {
    if (error instanceof MarketError) throw error
    throw new MarketError('invalid-archive')
  }
  const raw = entries[MANIFEST]
  if (!raw || raw.byteLength > 128 * 1024) throw new MarketError('invalid-manifest')
  let envelope: unknown
  try { envelope = JSON.parse(Buffer.from(raw).toString('utf8')) } catch { throw new MarketError('invalid-manifest') }
  if (!marketRecord(envelope) || !Array.isArray(envelope.files)) throw new MarketError('invalid-manifest')
  const manifest = marketManifest(envelope, allowedPlugins)
  const resources = Object.fromEntries(Object.entries(entries).filter(([path]) => path !== MANIFEST))
  const skillRoots = manifest.skills.map(skill => skill.path.slice(0, -'SKILL.md'.length))
  if (Object.keys(resources).some(path => path.startsWith('skills/') && !skillRoots.some(root => path.startsWith(root)))) {
    throw new MarketError('undeclared-skill')
  }
  if (envelope.files.length !== Object.keys(resources).length) throw new MarketError('file-mismatch')
  const declared = new Set<string>()
  for (const file of envelope.files) {
    if (!marketRecord(file) || typeof file.path !== 'string' || declared.has(file.path)) throw new MarketError('file-mismatch')
    declared.add(file.path)
    const bytes = resources[file.path]
    if (!bytes || bytes.byteLength !== file.bytes || marketDigest(bytes) !== file.sha256) throw new MarketError('file-mismatch')
  }
  if (Object.values(entries).reduce((n, file) => n + file.byteLength, 0) > limits.expandedBytes) throw new MarketError('expanded-limit', 413)
  for (const skill of manifest.skills) {
    const bytes = resources[skill.path]
    if (!bytes) throw new MarketError('missing-skill')
    marketSkill(Buffer.from(bytes).toString('utf8'), skill.name)
  }
  return { manifest, files: resources }
}

/** Assemble an explicit resource set into a publication ZIP.
 * @param manifest Execution metadata.
 * @param files Resource bytes keyed by relative portable paths.
 * @param limits Deployment-owned archive limits.
 * @param allowedPlugins Deployment-owned Bot plugin allowlist.
 * @returns A validated archive suitable for upload and local import.
 */
export function createMarketPackage(manifest: MarketManifest, files: Readonly<Record<string, Uint8Array>>,
  limits: MarketLimits, allowedPlugins: readonly string[]): Uint8Array {
  const list = Object.entries(files).sort(([a], [b]) => a.localeCompare(b))
    .map(([path, bytes]) => ({ path, bytes: bytes.byteLength, sha256: marketDigest(bytes) }))
  const archive = zipSync(
    { ...files, [MANIFEST]: Buffer.from(JSON.stringify({ ...manifest, files: list })) },
    { mtime: new Date(1980, 0, 1) },
  )
  readMarketPackage(archive, limits, allowedPlugins)
  return archive
}
