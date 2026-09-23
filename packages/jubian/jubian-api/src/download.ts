/**
 * Bounded media transfer for the download method.
 *
 * Jubian's media lives on a public TOS CDN that needs no credential, so this
 * module sends no Authorization header at all. What it does enforce is the
 * boundary the product established: an explicit origin allowlist that can never
 * come from the candidate URL itself, a byte ceiling per media kind, no redirect
 * following, and a decoded-header check so a saved file's extension is not a
 * guess. The caller receives bytes plus a digest; writing them is a separate,
 * explicit step.
 */
import { createHash } from 'node:crypto'
import { JubianError } from '@deepseek-ai/dsh-jubian'

/** The origins this plugin accepts media from; never read from the URL being fetched. */
export const MEDIA_ALLOWED_ORIGINS = ['https://jubian-aigc.tos-cn-beijing.volces.com'] as const

/** Byte ceilings per media kind, matching the product's own hard limits. */
export const MEDIA_LIMITS = { image: 64 * 1024 * 1024, video: 512 * 1024 * 1024 } as const

/** The media kinds this module recognises. */
export type MediaKind = 'image' | 'video'

/** One downloaded payload, decoded enough to trust its kind. */
export interface DownloadedMedia {
  bytes: Uint8Array
  media_type: string
  /** Provider media kind the header proved. */
  kind: MediaKind
  sha256: string
}

/** How one download call picks its transport, its allowlist and its limits. */
export interface DownloadMediaOptions {
  /** Explicit kind: the caller knows whether it asked for a still or a video. */
  kind: MediaKind
  /** Origin allowlist; defaults to {@link MEDIA_ALLOWED_ORIGINS}. */
  allowedOrigins?: readonly string[]
  /** Refuse a body larger than this many bytes; defaults to the module's cap. */
  maxBytes?: number
  /** Abort the request after this many milliseconds. */
  timeoutMs?: number
  /** Transport override, used by tests. */
  fetch?: typeof fetch
  /** Caller-owned cancellation, raced against the timeout. */
  signal?: AbortSignal
}

function reject(): never { throw new JubianError('CONTRACT_CHANGED') }

/**
 * Parse a media URL and prove it sits on an allowed, credential-free origin.
 * @param source - Candidate URL.
 * @param origins - Allowed origins.
 * @returns The parsed URL.
 */
function parseOrigin(source: string, origins: readonly string[]): URL {
  if (typeof source !== 'string' || source.length > 16384 || !source.isWellFormed()
    || /[\u0000-\u0020\u007f]/.test(source)) reject()
  let url: URL
  try { url = new URL(source) } catch { return reject() }
  if (url.protocol !== 'https:' || url.username || url.password || url.hash) reject()
  if (!origins.includes(url.origin)) reject()
  return url
}

/**
 * Prove which media kind a payload actually is from its own header bytes.
 * @param bytes - Downloaded payload.
 * @returns The media type and kind, or throws when no supported header matches.
 */
function decodeHeader(bytes: Uint8Array): { media_type: string; kind: MediaKind } {
  const view = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  if (bytes.length >= 8 && view.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))) {
    return { media_type: 'image/png', kind: 'image' }
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return { media_type: 'image/jpeg', kind: 'image' }
  }
  if (bytes.length >= 12 && view.toString('ascii', 0, 4) === 'RIFF' && view.toString('ascii', 8, 12) === 'WEBP') {
    return { media_type: 'image/webp', kind: 'image' }
  }
  if (bytes.length >= 16 && view.toString('ascii', 4, 8) === 'ftyp'
    && view.readUInt32BE(0) >= 16 && view.readUInt32BE(0) <= bytes.length
    && /^(isom|iso[2-9]|mp4[12]|avc1|dash|M4[ABPV] |qt  )$/.test(view.toString('ascii', 8, 12))) {
    return { media_type: 'video/mp4', kind: 'video' }
  }
  return reject()
}

/**
 * Download one bounded media payload from an allowed origin.
 * @param source - Media URL as the provider reported it.
 * @param options - Explicit kind, limits and optional cancellation.
 * @returns The complete bytes, their decoded kind and their digest.
 * @throws {JubianError} `CONTRACT_CHANGED` when the origin, size or header is not acceptable.
 */
export async function downloadMedia(source: string, options: DownloadMediaOptions): Promise<DownloadedMedia> {
  const origins = options.allowedOrigins ?? MEDIA_ALLOWED_ORIGINS
  const ceiling = MEDIA_LIMITS[options.kind]
  const maximum = options.maxBytes ?? ceiling
  const timeoutMs = options.timeoutMs ?? 60000
  if (!Number.isSafeInteger(maximum) || maximum < 1 || maximum > ceiling) reject()
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 300000
    || !Array.isArray(origins) || !origins.length) reject()
  const url = parseOrigin(source, origins)
  const transport = options.fetch ?? fetch
  const timeout = AbortSignal.timeout(timeoutMs)
  const signal = options.signal === undefined ? timeout : AbortSignal.any([options.signal, timeout])
  let response: Response
  try {
    response = await transport(url.href, { method: 'GET', credentials: 'omit', redirect: 'error', signal })
  } catch { throw new JubianError('NETWORK_ERROR') }
  if (!response.ok) {
    await response.body?.cancel().catch(() => {})
    throw new JubianError('NETWORK_ERROR')
  }
  const reader = response.body?.getReader()
  if (!reader) reject()
  const chunks: Uint8Array[] = []
  let size = 0
  let exceeded = false
  try {
    for (;;) {
      const chunk = await reader.read()
      if (chunk.done) break
      size += chunk.value.byteLength
      if (size > maximum) { exceeded = true; reject() }
      chunks.push(chunk.value)
    }
  } catch (error) {
    await reader.cancel().catch(() => {})
    throw error instanceof JubianError && !exceeded ? error : new JubianError('CONTRACT_CHANGED')
  } finally { reader.releaseLock() }
  const merged = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) { merged.set(chunk, offset); offset += chunk.byteLength }
  const decoded = decodeHeader(merged)
  if (decoded.kind !== options.kind) reject()
  return { bytes: merged, media_type: decoded.media_type, kind: decoded.kind,
    sha256: `sha256:${createHash('sha256').update(merged).digest('hex')}` }
}
