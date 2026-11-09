/** Skill-only cloud records and identifiers, independent of local archive identities. */
import { brandString, type Branded } from '@deepseek-ai/dsh-brand'
import { isDeepStrictEqual } from 'node:util'
import { marketManifest, marketRecord } from './format.ts'
import type { MarketLimits, MarketManifest } from './types.ts'

/** Opaque cloud publication identity; local release identities remain archive SHA-256. */
export type MarketPublicationId = Branded<'MarketPublicationId'>
/** One invited publishing team. */
export type MarketPublisherId = Branded<'MarketPublisherId'>
/** An original account-scoped upload attempt retained across uncertain responses. */
export type MarketUploadRequestId = Branded<'MarketUploadRequestId'>
/** Account identity asserted by the authenticated Muse gateway. */
export type MarketAccountId = Branded<'MarketAccountId'>
/** Explicit owner submission or administrator moderation action. */
export type MarketReviewAction = 'submit' | 'approve' | 'reject' | 'withdraw'

/** Gateway authority at request admission; never accepted from public request JSON. */
export interface MarketActor {
  readonly id: MarketAccountId
  readonly username: string
  readonly admin: boolean
}

/** Immutable archive metadata and the separately revisioned moderation state. */
export interface MarketPublication {
  readonly id: MarketPublicationId
  readonly publisherId: MarketPublisherId
  readonly publisher: string
  readonly manifest: MarketManifest
  readonly sha256: string
  readonly bytes: number
  readonly status: 'draft' | 'pending' | 'published' | 'rejected' | 'withdrawn'
  readonly reviewNote: string
  readonly revision: number
  readonly createdAt: string
}

/** Current publishing memberships without cookies or account secrets. */
export interface MarketIdentity {
  readonly publishers: readonly { readonly id: MarketPublisherId; readonly title: string }[]
  readonly admin: boolean
}

/** Credential-free cloud refusal with an explicit HTTP status. */
export class MarketCloudError extends Error {
  /**
   * @param code - Stable public refusal reason.
   * @param status - HTTP status used by the cloud carrier.
   * @param options - Internal cause when supplied; omission retains no cause.
   */
  constructor(readonly code: string, readonly status: number, options?: ErrorOptions) {
    super(code, options)
    this.name = 'MarketCloudError'
  }
}

function exact(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key))
}
function label(value: unknown, maximum: number): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= maximum
}
function publicationStatus(value: unknown): value is MarketPublication['status'] {
  return value === 'draft' || value === 'pending' || value === 'published' || value === 'rejected' || value === 'withdrawn'
}
function hex(value: unknown, length: number, code: string): string {
  if (typeof value !== 'string' || value.length !== length || !/^[a-f0-9]+$/u.test(value)) throw new MarketCloudError(code, 400)
  return value
}

/** Parse a cloud publication id without admitting local archive hashes.
 * @param value - Untrusted JSON or path value.
 * @returns A validated cloud identity.
 */
export function parseMarketPublicationId(value: unknown): MarketPublicationId {
  return brandString<MarketPublicationId>(hex(value, 32, 'invalid-publication'))
}

/** Parse a publishing-team id.
 * @param value - Untrusted JSON or header value.
 * @returns A validated team identity.
 */
export function parseMarketPublisherId(value: unknown): MarketPublisherId {
  return brandString<MarketPublisherId>(hex(value, 32, 'invalid-publisher'))
}

/** Parse an account id from the private gateway assertion.
 * @param value - Untrusted decoded assertion value.
 * @returns The validated Muse account identity.
 */
export function parseMarketAccountId(value: unknown): MarketAccountId {
  return brandString<MarketAccountId>(hex(value, 16, 'invalid-account'))
}

/** Parse the caller's original upload key.
 * @param value - Untrusted header or Remote argument.
 * @returns The unchanged validated attempt identity.
 */
export function parseMarketUploadRequestId(value: unknown): MarketUploadRequestId {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{8,100}$/u.test(value)) throw new MarketCloudError('invalid-request-id', 400)
  return brandString<MarketUploadRequestId>(value)
}

/** Validate the gateway's complete authority assertion.
 * @param value - Decoded private assertion JSON.
 * @returns Only the account facts asserted by the gateway.
 */
export function parseMarketActor(value: unknown): MarketActor {
  if (!marketRecord(value) || !exact(value, ['id', 'username', 'admin'])
    || !label(value.username, 32) || typeof value.admin !== 'boolean') throw new MarketCloudError('invalid-actor', 400)
  return { id: parseMarketAccountId(value.id), username: value.username, admin: value.admin }
}

/** Validate a complete cloud record against local archive admission limits.
 * @param value - Decoded wire or durable record.
 * @param limits - Resolved manifest and archive bounds.
 * @returns A validated Skill-only publication with separate moderation identity.
 */
export function parseMarketPublication(value: unknown, limits: MarketLimits): MarketPublication {
  try {
    if (!marketRecord(value) || !exact(value, ['id', 'publisherId', 'publisher', 'manifest', 'sha256', 'bytes',
      'status', 'reviewNote', 'revision', 'createdAt']) || !label(value.publisher, 100)
      || typeof value.sha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(value.sha256)
      || typeof value.bytes !== 'number' || !Number.isSafeInteger(value.bytes) || value.bytes < 1 || value.bytes > limits.archiveBytes
      || !publicationStatus(value.status)
      || typeof value.reviewNote !== 'string' || value.reviewNote.length > 2000
      || typeof value.revision !== 'number' || !Number.isSafeInteger(value.revision) || value.revision < 1
      || typeof value.createdAt !== 'string' || !Number.isFinite(Date.parse(value.createdAt))
      || new Date(value.createdAt).toISOString() !== value.createdAt
      || Buffer.byteLength(JSON.stringify(value.manifest)) > limits.recordBytes) throw new Error('Invalid cloud record')
    const manifest = marketManifest(value.manifest)
    if (!isDeepStrictEqual(value.manifest, manifest)) throw new Error('Unexpected cloud manifest fields')
    return { id: parseMarketPublicationId(value.id), publisherId: parseMarketPublisherId(value.publisherId),
      publisher: value.publisher, manifest, sha256: value.sha256, bytes: value.bytes, status: value.status,
      reviewNote: value.reviewNote, revision: value.revision, createdAt: value.createdAt }
  } catch (error) {
    if (error instanceof MarketCloudError && error.code === 'invalid-response') throw error
    throw new MarketCloudError('invalid-response', 502)
  }
}

/** Validate memberships returned by the account-authorized catalog.
 * @param value - Decoded identity JSON.
 * @returns Publishing teams and administrator status without credentials.
 */
export function parseMarketIdentity(value: unknown): MarketIdentity {
  try {
    if (!marketRecord(value) || !exact(value, ['publishers', 'admin']) || !Array.isArray(value.publishers)
      || typeof value.admin !== 'boolean') throw new MarketCloudError('invalid-response', 502)
    const publishers = value.publishers.map((row: unknown) => {
      if (!marketRecord(row) || !exact(row, ['id', 'title']) || !label(row.title, 100)) throw new MarketCloudError('invalid-response', 502)
      return { id: parseMarketPublisherId(row.id), title: row.title }
    })
    if (new Set(publishers.map(row => row.id)).size !== publishers.length) throw new MarketCloudError('invalid-response', 502)
    return { publishers, admin: value.admin }
  } catch (error) { throw new MarketCloudError('invalid-response', 502, { cause: error }) }
}
