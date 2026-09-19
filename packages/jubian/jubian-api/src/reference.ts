/**
 * Local reference images and the frontend's own object-storage upload contract.
 *
 * `gpt-image-2` accepts reference images only as HTTPS URLs, so a local file has
 * to reach the bucket the workbench itself uploads to before it can be named in
 * `/aigc/asset`. Two facts from that path are reproduced here rather than
 * guessed: the destination is read from the public app bundle at call time (its
 * values are not stable constants), and both edges of the image must be
 * multiples of 16.
 *
 * No image codec is implemented here — this package deliberately adds no
 * runtime dependency — so these functions only *read* what a file already is:
 * its container format and its true pixel size. Re-encoding an image that fails
 * the alignment rule is the caller's step, and the object key, request
 * signature and target URL are built here so that step stays a pure function.
 */
import { createHash, createHmac } from 'node:crypto'
import { JubianError } from '@deepseek-ai/dsh-jubian'

function invalid(): never { throw new JubianError('CONTRACT_CHANGED') }

/**
 * The edge alignment the provider's image pipeline requires.
 *
 * A reference whose width or height is not a multiple of this is normalized by
 * the workbench's own client before upload; an unaligned file is not the
 * verified path.
 */
export const REFERENCE_ALIGNMENT = 16

/** Object-key prefix every workbench-uploaded reference image uses. */
export const REFERENCE_OBJECT_PREFIX = 'prod/sys-material-image'

/** The container formats the workbench accepts for a local reference image. */
export type ReferenceFormat = 'jpeg' | 'png' | 'webp'

/** One local reference image, as its own header describes it. */
export interface ReferenceImage {
  /** Container format detected from the file's magic bytes, never from its name. */
  format: ReferenceFormat
  /** True pixel width read from the container header. */
  width: number
  /** True pixel height read from the container header. */
  height: number
  /** The media type an upload must declare for this format. */
  content_type: string
  /** The lower-case file extension the object key uses. */
  extension: string
}

/** The upload destination the workbench's own bundle configures at runtime. */
export interface TosUploadConfig {
  access_key_id: string
  access_key_secret: string
  region: string
  bucket: string
  /** Bucket origin without a scheme, e.g. `tos-cn-beijing.volces.com`. */
  endpoint: string
}

/** One signed object upload, ready to be handed to `fetch`. */
export interface TosSignedPut {
  /** Absolute `https://` URL including the object key. */
  url: string
  /** Every header the signature covers, plus the signature itself. */
  headers: Record<string, string>
}

/** The one reference-material item shape `/aigc/asset` accepts. */
export interface ReferenceMaterialItem {
  materialUrl: string
  materialType: 'image'
  sortOrder: number
}

const FORMATS: Record<ReferenceFormat, { content_type: string; extension: string }> = {
  jpeg: { content_type: 'image/jpeg', extension: '.jpg' },
  png: { content_type: 'image/png', extension: '.png' },
  webp: { content_type: 'image/webp', extension: '.webp' },
}

function be16(bytes: Uint8Array, offset: number): number {
  const high = bytes[offset], low = bytes[offset + 1]
  if (high === undefined || low === undefined) invalid()
  return (high << 8) | low
}

function be32(bytes: Uint8Array, offset: number): number {
  const a = bytes[offset], b = bytes[offset + 1], c = bytes[offset + 2], d = bytes[offset + 3]
  if (a === undefined || b === undefined || c === undefined || d === undefined) invalid()
  return ((a << 24) | (b << 16) | (c << 8) | d) >>> 0
}

function le24(bytes: Uint8Array, offset: number): number {
  const a = bytes[offset], b = bytes[offset + 1], c = bytes[offset + 2]
  if (a === undefined || b === undefined || c === undefined) invalid()
  return (a | (b << 8) | (c << 16)) >>> 0
}

function ascii(bytes: Uint8Array, offset: number, length: number): string {
  return String.fromCharCode(...bytes.subarray(offset, offset + length))
}

function positive(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1) invalid()
  return value
}

function startsWith(bytes: Uint8Array, signature: number[]): boolean {
  return signature.every((value, index) => bytes[index] === value)
}

/** JPEG frame markers that carry the sample dimensions. */
const JPEG_SOF_MARKERS = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf])

function jpegSize(bytes: Uint8Array): { width: number; height: number } {
  let offset = 2
  while (offset + 3 < bytes.length) {
    if (bytes[offset] !== 0xff) {
      offset += 1
      continue
    }
    const marker = bytes[offset + 1]
    if (marker === undefined) break
    // Fill bytes and standalone markers carry no length field.
    if (marker === 0xff || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd9)) {
      offset += marker === 0xff ? 1 : 2
      continue
    }
    // The scan starts here, so a frame header would already have been seen.
    if (marker === 0xda) invalid()
    const length = be16(bytes, offset + 2)
    if (length < 2) invalid()
    if (JPEG_SOF_MARKERS.has(marker)) return { height: be16(bytes, offset + 5), width: be16(bytes, offset + 7) }
    offset += 2 + length
  }
  return invalid()
}

function pngSize(bytes: Uint8Array): { width: number; height: number } {
  if (!startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]) || ascii(bytes, 12, 4) !== 'IHDR') invalid()
  return { width: be32(bytes, 16), height: be32(bytes, 20) }
}

function webpSize(bytes: Uint8Array): { width: number; height: number } {
  if (ascii(bytes, 0, 4) !== 'RIFF' || ascii(bytes, 8, 4) !== 'WEBP') invalid()
  const chunk = ascii(bytes, 12, 4)
  if (chunk === 'VP8 ') {
    // Lossy frame header: a 3-byte start code then two 14-bit dimensions.
    return { width: be16(bytes, 26) & 0x3fff, height: be16(bytes, 28) & 0x3fff }
  }
  if (chunk === 'VP8L') {
    if (bytes[20] !== 0x2f) invalid()
    const b0 = bytes[21] ?? invalid(), b1 = bytes[22] ?? invalid(), b2 = bytes[23] ?? invalid(), b3 = bytes[24] ?? invalid()
    return { width: 1 + (b0 | ((b1 & 0x3f) << 8)), height: 1 + (((b1 >> 6) & 0x03) | (b2 << 2) | ((b3 & 0x0f) << 10)) }
  }
  if (chunk === 'VP8X') return { width: le24(bytes, 24) + 1, height: le24(bytes, 27) + 1 }
  return invalid()
}

/**
 * Read the container format and true pixel size of one reference image.
 *
 * The size comes from the file's own header, not from its name or from a claim
 * the caller makes, because the alignment rule below is enforced on real pixels.
 * @param bytes - The complete file contents.
 * @returns The detected format and the header's width and height.
 * @throws {JubianError} `CONTRACT_CHANGED` when the format is unsupported or the header is malformed.
 */
export function readReferenceImage(bytes: Uint8Array): ReferenceImage {
  const size = startsWith(bytes, [0xff, 0xd8]) ? jpegSize(bytes)
    : startsWith(bytes, [0x89, 0x50, 0x4e, 0x47]) ? pngSize(bytes)
      : ascii(bytes, 0, 4) === 'RIFF' ? webpSize(bytes) : invalid()
  const format: ReferenceFormat = startsWith(bytes, [0xff, 0xd8]) ? 'jpeg'
    : startsWith(bytes, [0x89, 0x50, 0x4e, 0x47]) ? 'png' : 'webp'
  const descriptor = FORMATS[format]
  return { format, width: positive(size.width), height: positive(size.height),
    content_type: descriptor.content_type, extension: descriptor.extension }
}

/**
 * Round one edge to the nearest multiple of {@link REFERENCE_ALIGNMENT}.
 * @param value - A pixel width or height.
 * @returns The nearest multiple of 16, never below 16 — the rule the workbench's own client applies.
 */
export function alignReferenceEdge(value: number): number {
  return Math.max(REFERENCE_ALIGNMENT, Math.round(value / REFERENCE_ALIGNMENT) * REFERENCE_ALIGNMENT)
}

/**
 * Decide whether one image already satisfies the alignment rule.
 * @param image - A parsed reference image.
 * @returns The aligned size, and whether the file already has exactly that size.
 */
export function alignedReferenceSize(image: Pick<ReferenceImage, 'width' | 'height'>):
{ width: number; height: number; aligned: boolean } {
  const width = alignReferenceEdge(image.width), height = alignReferenceEdge(image.height)
  return { width, height, aligned: width === image.width && height === image.height }
}

/**
 * Build the object key one reference image is uploaded under.
 * @param now - The moment the key is minted; its local date is part of the key prefix.
 * @param token - A unique hex token, so two uploads never collide.
 * @param extension - The file extension including its dot, e.g. `.jpg`.
 * @returns The full object key inside the bucket.
 */
export function buildReferenceObjectKey(now: Date, token: string, extension: string): string {
  if (!/^[0-9a-f]{8,}$/i.test(token) || !/^\.[a-z0-9]{2,5}$/.test(extension)) invalid()
  const date = [now.getFullYear(), now.getMonth() + 1, now.getDate()]
    .map((part, index) => (index === 0 ? String(part) : String(part).padStart(2, '0'))).join('/')
  return `${REFERENCE_OBJECT_PREFIX}/${date}/${token.toLowerCase()}${extension}`
}

/**
 * Locate the frontend's entry script in its own HTML.
 * @param html - The document returned for the workbench root URL.
 * @param frontendUrl - The origin the document came from, used to resolve a relative source.
 * @returns The absolute URL of the `app.<hash>.js` entry script.
 * @throws {JubianError} `CONTRACT_CHANGED` when no entry script is present.
 */
export function extractAppScriptUrl(html: string, frontendUrl: string): string {
  for (const match of html.matchAll(/<script[^>]+src=(?:"([^"]+)"|'([^']+)'|([^\s>]+))/gi)) {
    const source = match.slice(1).find(value => value)
    if (source !== undefined && /\/static\/js\/app\.[^/]+\.js$/.test(source)) return new URL(source, frontendUrl).toString()
  }
  return invalid()
}

/**
 * Read the upload destination out of the frontend bundle.
 *
 * The workbench holds no server-side upload token: its own bundle carries the
 * object-storage configuration, and the app fetches that bundle from its own
 * origin. The values are therefore read from the live bundle rather than stored
 * here, and a layout change fails closed instead of uploading somewhere else.
 * @param appJs - The text of the frontend's entry bundle.
 * @returns The bucket, region, endpoint and access pair the current bundle configures.
 * @throws {JubianError} `CONTRACT_CHANGED` when the bundle's upload module cannot be located.
 */
export function extractTosUploadConfig(appJs: string): TosUploadConfig {
  const start = appJs.indexOf('"6c3d":function')
  const end = start < 0 ? -1 : appJs.indexOf('},"6ea0":function', start)
  if (start < 0 || end < 0) invalid()
  const module = appJs.slice(start, end)
  const patterns: Record<keyof TosUploadConfig, RegExp> = {
    access_key_id: /o=\([^,]+,"([^"]+)"\)/,
    access_key_secret: /s="([^"]+)"/,
    region: /r="([^"]+)"/,
    bucket: /u="([^"]+)"/,
    endpoint: /l="([^"]+)"/,
  }
  const read = (field: keyof TosUploadConfig): string => {
    const matched = patterns[field].exec(module)?.[1]
    if (matched === undefined || !matched.trim()) invalid()
    return matched
  }
  return { access_key_id: read('access_key_id'), access_key_secret: read('access_key_secret'),
    region: read('region'), bucket: read('bucket'),
    endpoint: read('endpoint').replace(/^https?:\/\//, '').replace(/\/+$/, '') }
}

/** Everything one signed object upload is built from. */
export interface TosPutRequest {
  config: TosUploadConfig
  /** Object key inside the bucket. */
  key: string
  /** The exact bytes that will be sent. */
  payload: Uint8Array
  /** Media type declared for those bytes. */
  content_type: string
  /** Request time; part of the signature and of its expiry window. */
  now: Date
}

function sha256Hex(value: Uint8Array | string): string {
  return createHash('sha256').update(value).digest('hex')
}

function hmac(key: Uint8Array | string, value: string): Buffer {
  return createHmac('sha256', key).update(value).digest()
}

function encodeKey(key: string): string {
  if (!key || key.startsWith('/') || key.includes('..')) invalid()
  return key.split('/').map(segment => (segment ? encodeURIComponent(segment) : invalid())).join('/')
}

function amzDate(now: Date): { stamp: string; date: string } {
  const iso = now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '')
  return { stamp: iso, date: iso.slice(0, 8) }
}

/**
 * Sign one object `PUT` with the scheme the workbench's bundle uses.
 *
 * The scheme is the provider's own V4 variant, reproduced here from the SDK the
 * live bundle ships rather than from the AWS documentation it resembles: the
 * payload is declared with the literal `UNSIGNED-PAYLOAD` (never hashed), only
 * `host` and the `x-tos-*` headers take part in the signature, and the signing
 * key chain starts from the secret itself with no algorithm prefix. Those three
 * details are exactly what a from-memory SigV4 implementation gets wrong — a
 * wrong one produces `SignatureDoesNotMatch` and no upload.
 * @param request - Destination config, object key, payload, media type and time.
 * @returns The absolute upload URL and every header, including `Authorization`.
 */
export function signTosObjectPut(request: TosPutRequest): TosSignedPut {
  const host = `${request.config.bucket}.${request.config.endpoint}`
  const path = `/${encodeKey(request.key)}`
  const { stamp, date } = amzDate(request.now)
  const scope = `${date}/${request.config.region}/tos/request`
  const payloadHash = 'UNSIGNED-PAYLOAD'
  const canonical: Record<string, string> = {
    host,
    'x-tos-content-sha256': payloadHash,
    'x-tos-date': stamp,
  }
  const names = Object.keys(canonical).sort()
  const signedHeaders = names.join(';')
  const canonicalHeaders = names.map(name => `${name}:${canonical[name] ?? ''}\n`).join('')
  const canonicalRequest = ['PUT', path, '', canonicalHeaders, signedHeaders, payloadHash].join('\n')
  const stringToSign = ['TOS4-HMAC-SHA256', stamp, scope, sha256Hex(canonicalRequest)].join('\n')
  const signingKey = hmac(hmac(hmac(hmac(request.config.access_key_secret, date),
    request.config.region), 'tos'), 'request')
  const signature = createHmac('sha256', signingKey).update(stringToSign).digest('hex')
  return {
    url: `https://${host}${path}`,
    headers: {
      'content-type': request.content_type,
      ...canonical,
      Authorization: `TOS4-HMAC-SHA256 Credential=${request.config.access_key_id}/${scope}, `
        + `SignedHeaders=${signedHeaders}, Signature=${signature}`,
    },
  }
}

/**
 * Build the one material item an asset request carries for an uploaded reference.
 * @param materialUrl - The HTTPS URL the upload returned.
 * @param sortOrder - One-based position, which is the generation's own reference order.
 * @returns The exact three-field item `/aigc/asset` accepts for a local upload.
 */
export function referenceMaterialItem(materialUrl: string, sortOrder: number): ReferenceMaterialItem {
  if (!/^https:\/\/[^\s\\#]+$/.test(materialUrl)) invalid()
  if (!Number.isSafeInteger(sortOrder) || sortOrder < 1) invalid()
  return { materialUrl, materialType: 'image', sortOrder }
}
