/** Boundary validation for character-library reads and offline pending ingest. */
import { createHash } from 'node:crypto'
import sharp from 'sharp'
import { CharacterLibraryError } from './errors.ts'
import type { CharacterLibraryPrefix } from './types.ts'

const DISPLAY_CONTROL = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u

/**
 * Reject an invalid domain request with its public operation stage.
 * @param stage - Operation whose request failed validation.
 * @returns Never; this function always throws.
 */
export function failRequest(
  stage: 'browse' | 'detail' | 'preview' | 'recommend',
): never {
  throw new CharacterLibraryError('INVALID_REQUEST', stage)
}

/**
 * Require a bounded object key without traversal or display controls.
 * @param key - Untrusted key to validate.
 * @param prefix - Optional required reviewed prefix.
 * @returns A type assertion for a safe key, or throws on invalid input.
 */
export function assertSafeKey(key: unknown, prefix?: CharacterLibraryPrefix): asserts key is string {
  if (typeof key !== 'string' || key.length === 0 || key.length > 1024
    || key.includes('\\') || DISPLAY_CONTROL.test(key)
    || key.split('/').some(part => part === '.' || part === '..')) {
    throw new CharacterLibraryError('LIST_FAILED', 'browse')
  }
  if (prefix !== undefined && !key.startsWith(prefix)) {
    throw new CharacterLibraryError('LIST_FAILED', 'browse')
  }
}

/**
 * Identify a direct metadata record below a reviewed collection prefix.
 * @param key - Validated object key to inspect.
 * @param prefix - Reviewed collection prefix.
 * @returns Whether the key names a direct metadata.json record.
 */
export function metadataCandidate(key: string, prefix: CharacterLibraryPrefix): boolean {
  if (key === prefix) return false
  const suffix = key.slice(prefix.length)
  if (suffix.endsWith('/')) {
    const segments = suffix.slice(0, -1).split('/')
    if (segments.some(part => !part)) throw new CharacterLibraryError('LIST_FAILED', 'browse')
    return false
  }
  const segments = suffix.split('/')
  if (segments.some(part => !part)) throw new CharacterLibraryError('LIST_FAILED', 'browse')
  return segments.length === 2
    && /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(segments[0] ?? '')
    && segments[1] === 'metadata.json'
}

/**
 * Trim and bound a user-provided text field.
 * @param value - Untrusted text value.
 * @param max - Maximum accepted trimmed length.
 * @param stage - Operation whose input is validated.
 * @param optional - Whether an undefined value is accepted.
 * @returns Validated text or undefined when optional and absent.
 */
export function boundedText(
  value: unknown,
  max: number,
  stage: 'browse' | 'recommend',
  optional = false,
): string | undefined {
  if (value === undefined && optional) return undefined
  if (typeof value !== 'string') throw new CharacterLibraryError('INVALID_REQUEST', stage)
  const trimmed = value.trim()
  if (!trimmed || trimmed.length > max || DISPLAY_CONTROL.test(trimmed)) {
    throw new CharacterLibraryError('INVALID_REQUEST', stage)
  }
  return trimmed
}

/**
 * Validate a bounded list of unique text fields.
 * @param value - Optional untrusted list.
 * @param maxItems - Maximum number of list entries.
 * @param maxLength - Maximum trimmed length for each entry.
 * @param stage - Operation whose input is validated.
 * @returns Trimmed unique entries, or an empty list when absent.
 */
export function boundedList(
  value: readonly string[] | undefined,
  maxItems: number,
  maxLength: number,
  stage: 'recommend',
): readonly string[] {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.length > maxItems) {
    throw new CharacterLibraryError('INVALID_REQUEST', stage)
  }
  const items = value.map(item => boundedText(item, maxLength, stage) as string)
  if (new Set(items).size !== items.length) throw new CharacterLibraryError('INVALID_REQUEST', stage)
  return items
}

/** Supported image type derived from source bytes. */
export interface DetectedImage {
  readonly mediaType: 'image/jpeg' | 'image/png' | 'image/webp'
  readonly extension: 'jpg' | 'png' | 'webp'
}

const MAX_DECODE_PIXELS = 40_000_000
const IMAGE_DECODE_TIMEOUT_SECONDS = 5
const DECODED_FORMATS = {
  jpeg: { mediaType: 'image/jpeg', extension: 'jpg' },
  png: { mediaType: 'image/png', extension: 'png' },
  webp: { mediaType: 'image/webp', extension: 'webp' },
} as const satisfies Record<string, DetectedImage>

const PNG_COLOR_DEPTHS = new Set([
  '0:1', '0:2', '0:4', '0:8', '0:16',
  '2:8', '2:16',
  '3:1', '3:2', '3:4', '3:8',
  '4:8', '4:16',
  '6:8', '6:16',
])

function bytesAt(data: Uint8Array, offset: number, expected: readonly number[]): boolean {
  return expected.every((value, index) => data[offset + index] === value)
}

function textAt(data: Uint8Array, offset: number, expected: string): boolean {
  for (let index = 0; index < expected.length; index++) {
    if (data[offset + index] !== expected.charCodeAt(index)) return false
  }
  return true
}

function byte(data: Uint8Array, offset: number): number {
  const value = data[offset]
  /* v8 ignore next -- each parser checks the enclosing fixed header or chunk before reading it. */
  if (value === undefined) return 0
  return value
}

function uint16be(data: Uint8Array, offset: number): number {
  return (byte(data, offset) << 8) | byte(data, offset + 1)
}

function uint16le(data: Uint8Array, offset: number): number {
  return byte(data, offset) | (byte(data, offset + 1) << 8)
}

function uint24le(data: Uint8Array, offset: number): number {
  return byte(data, offset) | (byte(data, offset + 1) << 8) | (byte(data, offset + 2) << 16)
}

function uint32be(data: Uint8Array, offset: number): number {
  return byte(data, offset) * 0x1000000
    + (byte(data, offset + 1) << 16)
    + (byte(data, offset + 2) << 8)
    + byte(data, offset + 3)
}

function uint32le(data: Uint8Array, offset: number): number {
  return byte(data, offset)
    + (byte(data, offset + 1) << 8)
    + (byte(data, offset + 2) << 16)
    + byte(data, offset + 3) * 0x1000000
}

function validPng(data: Uint8Array): boolean {
  if (data.byteLength < 45
    || !bytesAt(data, 0, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return false
  let offset = 8
  let header = false
  let imageBytes = 0
  while (offset + 12 <= data.byteLength) {
    const length = uint32be(data, offset)
    const end = offset + 12 + length
    if (end > data.byteLength) return false
    if (!header) {
      if (length !== 13 || !textAt(data, offset + 4, 'IHDR')) return false
      const width = uint32be(data, offset + 8)
      const height = uint32be(data, offset + 12)
      if (width === 0 || height === 0
        || !PNG_COLOR_DEPTHS.has(`${String(data[offset + 17])}:${String(data[offset + 16])}`)
        || data[offset + 18] !== 0 || data[offset + 19] !== 0
        || (data[offset + 20] !== 0 && data[offset + 20] !== 1)) return false
      header = true
    } else if (textAt(data, offset + 4, 'IHDR')) {
      return false
    }
    if (textAt(data, offset + 4, 'IDAT')) imageBytes += length
    if (textAt(data, offset + 4, 'IEND')) {
      return length === 0 && imageBytes > 0 && end === data.byteLength
    }
    offset = end
  }
  return false
}

const JPEG_FRAME_MARKERS = new Set([
  0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7,
  0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf,
])

function jpegMarkerAfterScan(data: Uint8Array, start: number): number {
  let offset = start
  let entropy = false
  while (offset < data.byteLength) {
    if (data[offset] !== 0xff) {
      entropy = true
      offset++
      continue
    }
    const markerOffset = offset
    while (data[offset] === 0xff) offset++
    const marker = data[offset]
    if (marker === 0x00 || marker !== undefined && marker >= 0xd0 && marker <= 0xd7) {
      if (marker === 0x00) entropy = true
      offset++
      continue
    }
    return marker === undefined || !entropy ? -1 : markerOffset
  }
  return -1
}

function validJpeg(data: Uint8Array): boolean {
  if (data.byteLength < 23 || !bytesAt(data, 0, [0xff, 0xd8])) return false
  let offset = 2
  let frame = false
  let scan = false
  while (offset < data.byteLength) {
    if (data[offset++] !== 0xff) return false
    while (data[offset] === 0xff) offset++
    const marker = data[offset++]
    if (marker === 0xd9) return frame && scan && offset === data.byteLength
    if (marker === undefined || marker === 0x00 || marker === 0x01 || marker === 0xd8
      || marker >= 0xd0 && marker <= 0xd7 || offset + 2 > data.byteLength) return false
    const length = uint16be(data, offset)
    const end = offset + length
    if (length < 2 || end > data.byteLength) return false
    if (JPEG_FRAME_MARKERS.has(marker)) {
      const components = data[offset + 7]
      if (frame || components === undefined || components === 0 || length !== 8 + 3 * components
        || uint16be(data, offset + 3) === 0 || uint16be(data, offset + 5) === 0) return false
      frame = true
    }
    if (marker === 0xda) {
      const components = data[offset + 2]
      if (!frame || components === undefined || components === 0 || length !== 6 + 2 * components) {
        return false
      }
      scan = true
      offset = jpegMarkerAfterScan(data, end)
      if (offset < 0) return false
    } else {
      offset = end
    }
  }
  return false
}

function validWebp(data: Uint8Array): boolean {
  if (data.byteLength < 26 || !textAt(data, 0, 'RIFF') || !textAt(data, 8, 'WEBP')
    || uint32le(data, 4) + 8 !== data.byteLength) return false
  let offset = 12
  let canvas: readonly [number, number] | undefined
  let image: readonly [number, number] | undefined
  while (offset < data.byteLength) {
    if (offset + 8 > data.byteLength) return false
    const length = uint32le(data, offset + 4)
    const body = offset + 8
    const end = body + length
    const paddedEnd = end + (length & 1)
    if (paddedEnd > data.byteLength) return false
    if (textAt(data, offset, 'VP8X')) {
      if (canvas !== undefined || offset !== 12 || length !== 10
        || (byte(data, body) & 0xc1) !== 0
        || data[body + 1] !== 0 || data[body + 2] !== 0 || data[body + 3] !== 0) return false
      canvas = [uint24le(data, body + 4) + 1, uint24le(data, body + 7) + 1]
    } else if (textAt(data, offset, 'VP8 ')) {
      if (image !== undefined || length < 11 || !bytesAt(data, body + 3, [0x9d, 0x01, 0x2a])) return false
      const width = uint16le(data, body + 6) & 0x3fff
      const height = uint16le(data, body + 8) & 0x3fff
      if (width === 0 || height === 0) return false
      image = [width, height]
    } else if (textAt(data, offset, 'VP8L')) {
      if (image !== undefined || length < 6 || data[body] !== 0x2f
        || (byte(data, body + 4) & 0xe0) !== 0) {
        return false
      }
      image = [
        1 + byte(data, body + 1) + ((byte(data, body + 2) & 0x3f) << 8),
        1 + (byte(data, body + 2) >> 6) + (byte(data, body + 3) << 2)
          + ((byte(data, body + 4) & 0x0f) << 10),
      ]
    }
    offset = paddedEnd
  }
  return image !== undefined && (canvas === undefined
    || canvas[0] === image[0] && canvas[1] === image[1])
}

/**
 * Detect a structurally bounded supported image with non-zero dimensions.
 * @param data - Source image bytes to inspect.
 * @returns Detected image type, or null for invalid or unsupported bytes.
 */
export function detectImage(data: Uint8Array): DetectedImage | null {
  if (validJpeg(data)) {
    return { mediaType: 'image/jpeg', extension: 'jpg' }
  }
  if (validPng(data)) {
    return { mediaType: 'image/png', extension: 'png' }
  }
  if (validWebp(data)) {
    return { mediaType: 'image/webp', extension: 'webp' }
  }
  return null
}

/**
 * Fully decode a structurally supported image within fixed resource limits.
 * @param data - Source image bytes to decode.
 * @returns Decoded image type, or null for invalid or unsupported bytes.
 */
export async function detectDecodableImage(data: Uint8Array): Promise<DetectedImage | null> {
  try {
    const image = sharp(data, {
      animated: true,
      failOn: 'warning',
      limitInputPixels: MAX_DECODE_PIXELS,
      limitInputChannels: 4,
      sequentialRead: true,
    }).timeout({ seconds: IMAGE_DECODE_TIMEOUT_SECONDS })
    const metadata = await image.metadata()
    if (metadata.format !== 'jpeg' && metadata.format !== 'png' && metadata.format !== 'webp') {
      return null
    }
    await image.raw().toBuffer()
    return DECODED_FORMATS[metadata.format]
  } catch {
    return null
  }
}

/**
 * Compute a lowercase SHA-256 hex digest of source bytes.
 * @param data - Bytes to hash.
 * @returns SHA-256 digest in hexadecimal form.
 */
export function digest(data: Uint8Array): string {
  return createHash('sha256').update(data).digest('hex')
}
