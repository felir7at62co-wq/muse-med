/** Prepare the public BGM catalog from verified local audio and measured emotion values. */
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { readFile, realpath, stat } from 'node:fs/promises'
import { basename, extname, isAbsolute, relative, resolve, sep } from 'node:path'

/** Public track metadata; local filesystem paths and credentials are excluded. */
export interface PublishedBgmTrack {
  readonly id: string
  readonly name: string
  readonly sha256: string
  readonly bytes: number
  readonly url: string
  readonly valence: number
  readonly arousal: number
  readonly moods: readonly string[]
}

/** Versioned catalog consumed by the BGM matching plugin. */
export interface PublishedBgmCatalog {
  readonly version: 1
  readonly tracks: readonly PublishedBgmTrack[]
}

/** Verified local source for one content-addressed audio object. */
export interface BgmUploadArtifact {
  readonly source: string
  readonly key: string
  readonly sha256: string
  readonly bytes: number
  readonly contentType: string
}

/** Local upload plan; only its manifest may be published as the catalog. */
export interface BgmPublication {
  readonly manifest: PublishedBgmCatalog
  readonly artifacts: readonly BgmUploadArtifact[]
}

const CONTENT_TYPES: Readonly<Record<string, string>> = {
  '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.m4a': 'audio/mp4', '.flac': 'audio/flac',
  '.aac': 'audio/aac', '.ogg': 'audio/ogg', '.opus': 'audio/ogg',
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function emotion(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 1 || value > 9) {
    throw new Error(`BGM publication: ${field} must be finite and within 1–9`)
  }
  return value
}

/**
 * Verify an audio file against the index without loading its body into memory.
 * @param source - Local audio path.
 * @param bytes - Required file size.
 * @param sha256 - Required digest with its sha256: prefix.
 */
export async function verifyBgmSource(source: string, bytes: number, sha256: string): Promise<void> {
  const info = await stat(source)
  if (!info.isFile() || info.size !== bytes) throw new Error('BGM publication: source size differs from index')
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(source)) hash.update(chunk)
  if (`sha256:${hash.digest('hex')}` !== sha256) throw new Error('BGM publication: source hash differs from index')
}

/**
 * Validate every source before any upload and omit machine-specific fields from public metadata.
 * @param indexPath - Existing local emotion index JSON.
 * @param libraryDir - Only audio inside this directory may be published.
 * @param publicOrigin - HTTPS bucket origin, without a path, credentials, or query.
 * @returns A deterministic public catalog and its verified local upload sources.
 */
export async function prepareBgmPublication(indexPath: string, libraryDir: string, publicOrigin: string): Promise<BgmPublication> {
  const origin = new URL(publicOrigin)
  if (origin.protocol !== 'https:' || origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash) {
    throw new Error('BGM publication: public origin must be an HTTPS origin without credentials or a path')
  }
  const root = await realpath(libraryDir)
  const index: unknown = JSON.parse(await readFile(indexPath, 'utf8'))
  if (!Array.isArray(index) || index.length === 0) throw new Error('BGM publication: index is invalid or empty')
  const tracks: PublishedBgmTrack[] = []
  const artifacts: BgmUploadArtifact[] = []
  const identities = new Set<string>()
  for (const row of index) {
    if (!record(row) || typeof row.path !== 'string' || !row.path.trim()
      || typeof row.sha256 !== 'string' || !/^sha256:[a-f0-9]{64}$/u.test(row.sha256)
      || typeof row.bytes !== 'number' || !Number.isSafeInteger(row.bytes) || row.bytes <= 0
      || !Array.isArray(row.moods) || !row.moods.every((mood: unknown) => typeof mood === 'string')) {
      throw new Error('BGM publication: invalid track record')
    }
    const valence = emotion(row.valence, 'valence')
    const arousal = emotion(row.arousal, 'arousal')
    if (identities.has(row.sha256)) throw new Error('BGM publication: duplicate track identity')
    identities.add(row.sha256)
    const source = await realpath(resolve(row.path))
    const within = relative(root, source)
    if (isAbsolute(within) || within === '..' || within.startsWith(`..${sep}`) || within === '') {
      throw new Error('BGM publication: source is outside the declared library')
    }
    const extension = extname(source).toLowerCase()
    const contentType = CONTENT_TYPES[extension]
    if (!contentType) throw new Error('BGM publication: unsupported audio extension')
    await verifyBgmSource(source, row.bytes, row.sha256)
    const key = `bgm/tracks/${row.sha256.slice(7)}${extension}`
    tracks.push({ id: row.sha256, name: basename(row.path), sha256: row.sha256, bytes: row.bytes,
      url: `${origin.origin}/${key}`, valence, arousal, moods: row.moods as string[] })
    artifacts.push({ source, key, sha256: row.sha256, bytes: row.bytes, contentType })
  }
  tracks.sort((a, b) => a.id.localeCompare(b.id))
  artifacts.sort((a, b) => a.sha256.localeCompare(b.sha256))
  return { manifest: { version: 1, tracks }, artifacts }
}
