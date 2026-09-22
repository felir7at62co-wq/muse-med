/** Credential-free public catalogue reads and verified, explicit audio downloads. */
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { lstat, mkdir, mkdtemp, open, rename, rm, unlink } from 'node:fs/promises'
import { extname, join } from 'node:path'
import type { CatalogConfig, CatalogTrack } from './types.ts'

const AUDIO_EXTENSION = /^\.(?:mp3|wav|m4a|flac|aac|ogg|opus)$/
const DIGEST = /^sha256:[a-f0-9]{64}$/

function object(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid BGM catalog object')
  return value as Record<string, unknown>
}

function parseCatalog(value: unknown, config: CatalogConfig): CatalogTrack[] {
  const catalog = object(value)
  if (catalog.version !== 1 || !Array.isArray(catalog.tracks)) throw new Error('Invalid BGM catalog version or tracks')
  const ids = new Set<string>()
  const origin = new URL(config.catalogUrl).origin
  return catalog.tracks.map((raw: unknown) => {
    const row = object(raw)
    if (typeof row.sha256 !== 'string' || !DIGEST.test(row.sha256) || row.id !== row.sha256
      || ids.has(row.sha256)) throw new Error('Invalid or duplicate BGM catalog track ID')
    if (typeof row.name !== 'string' || !row.name.isWellFormed() || row.name.length > 255
      || /[\x00-\x1f\x7f/\\]/.test(row.name)) throw new Error('Invalid BGM catalog track name')
    const extension = extname(row.name).toLowerCase()
    if (!AUDIO_EXTENSION.test(extension)) throw new Error('Unsupported BGM catalog audio extension')
    const expectedUrl = `${origin}/bgm/tracks/${row.sha256.slice(7)}${extension}`
    if (row.url !== expectedUrl) throw new Error('BGM catalog track URL must be its same-origin content-addressed object')
    if (typeof row.bytes !== 'number' || !Number.isSafeInteger(row.bytes) || row.bytes < 1
      || row.bytes > config.maxTrackBytes) throw new Error('BGM catalog track size exceeds byte limit')
    for (const key of ['valence', 'arousal'] as const) {
      if (typeof row[key] !== 'number' || !Number.isFinite(row[key]) || row[key] < 1 || row[key] > 9) {
        throw new Error(`Invalid BGM catalog ${key}`)
      }
    }
    if (!Array.isArray(row.moods) || row.moods.length > 128
      || !row.moods.every((mood: unknown) => typeof mood === 'string' && mood.length <= 128 && mood.isWellFormed())) {
      throw new Error('Invalid BGM catalog moods')
    }
    ids.add(row.sha256)
    return { id: row.sha256, sha256: row.sha256, name: row.name, bytes: row.bytes,
      url: expectedUrl, valence: row.valence as number, arousal: row.arousal as number, moods: row.moods as string[] }
  })
}

async function request(url: string, signal: AbortSignal, maximum: number): Promise<NonNullable<Response['body']>> {
  signal.throwIfAborted()
  const response = await fetch(url, { method: 'GET', credentials: 'omit', redirect: 'error', signal })
  const length = response.headers.get('content-length')
  if (response.status !== 200 || response.redirected || !response.body
    || (length !== null && (!/^\d+$/.test(length) || Number(length) > maximum))) {
    await response.body?.cancel()
    throw new Error('BGM download refused: HTTP status, redirect, body or byte limit')
  }
  return response.body
}

/**
 * Fetch and validate one bounded catalogue; never fetch an audio candidate.
 * @param config - Resolved public-library settings.
 * @param signal - Operation cancellation and deadline.
 * @returns Catalogue measurements with validated content-addressed track URLs.
 */
export async function loadCatalog(config: CatalogConfig, signal: AbortSignal): Promise<CatalogTrack[]> {
  const body = await request(config.catalogUrl, signal, config.maxCatalogBytes)
  const chunks: Uint8Array[] = []
  let bytes = 0
  for await (const chunk of body) {
    signal.throwIfAborted()
    bytes += chunk.byteLength
    if (bytes > config.maxCatalogBytes) throw new Error('BGM catalog exceeds byte limit')
    chunks.push(chunk)
  }
  signal.throwIfAborted()
  return parseCatalog(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))), config)
}

async function validCache(path: string, track: CatalogTrack, signal: AbortSignal): Promise<boolean> {
  let info
  try { info = await lstat(path) } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
  if (!info.isFile()) throw new Error('BGM cache entry is not a regular file')
  if (info.size !== track.bytes) return false
  const hash = createHash('sha256')
  let bytes = 0
  for await (const chunk of createReadStream(path) as AsyncIterable<Buffer>) {
    signal.throwIfAborted()
    bytes += chunk.length
    if (bytes > track.bytes) return false
    hash.update(chunk)
  }
  signal.throwIfAborted()
  return bytes === track.bytes && `sha256:${hash.digest('hex')}` === track.sha256
}

/**
 * Download exactly one catalogue ID and atomically publish verified local bytes.
 * @param config - Resolved public-library settings.
 * @param trackId - ID selected from this catalogue, not a URL or local filename.
 * @param signal - Operation cancellation and deadline, including catalogue fetch.
 * @returns A real local path usable by the composer; reuse also verifies SHA-256.
 */
export async function downloadTrack(config: CatalogConfig, trackId: string, signal: AbortSignal): Promise<{
  track_id: string
  path: string
  bytes: number
  sha256: string
  cached: boolean
}> {
  const track = (await loadCatalog(config, signal)).find(candidate => candidate.id === trackId)
  if (!track) throw new Error('BGM track_id is not in the configured catalog')
  const path = join(config.cacheDir, `${track.sha256.slice(7)}${extname(track.name).toLowerCase()}`)
  const result = { track_id: track.id, path, bytes: track.bytes, sha256: track.sha256 }
  if (await validCache(path, track, signal)) return { ...result, cached: true }
  // Remove only this content-addressed entry; directories/symlinks failed above.
  try { await unlink(path) } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  await mkdir(config.cacheDir, { recursive: true, mode: 0o700 })
  const temporary = await mkdtemp(join(config.cacheDir, '.download-'))
  try {
    const staged = join(temporary, 'audio')
    const handle = await open(staged, 'wx', 0o600)
    const hash = createHash('sha256')
    let bytes = 0
    try {
      const body = await request(track.url, signal, track.bytes)
      for await (const chunk of body) {
        signal.throwIfAborted()
        bytes += chunk.byteLength
        if (bytes > track.bytes) throw new Error('BGM audio exceeds declared byte size')
        hash.update(chunk)
        await handle.writeFile(chunk)
      }
    } finally { await handle.close() }
    signal.throwIfAborted()
    if (bytes !== track.bytes || `sha256:${hash.digest('hex')}` !== track.sha256) {
      throw new Error('BGM audio byte size or SHA-256 mismatch')
    }
    try {
      await rename(staged, path)
      return { ...result, cached: false }
    } catch (error) {
      // A concurrent download of the same track can publish first, and replacing
      // the destination it just created can fail with EPERM on Windows. The path
      // is content-addressed, so a verifying file already holds the expected bytes.
      if (await validCache(path, track, signal)) return { ...result, cached: true }
      throw error
    }
  } finally { await rm(temporary, { recursive: true, force: true }) }
}
