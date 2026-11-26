/** Private image-registration receipts retain request identity and the first verified asset across restarts. */
import { createHash } from 'node:crypto'
import { mkdir, readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { z } from 'zod'
import { withFileLock, writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import { JubianError, type JubianLedger } from '@deepseek-ai/dsh-jubian'

const positiveId = z.number().int().positive().max(Number.MAX_SAFE_INTEGER)
const assetIdentity = z.object({ asset_id: positiveId, script_id: positiveId,
  asset_type: z.union([z.literal(1), z.literal(2), z.literal(3)]), name: z.string(), url: z.string() }).strict()
const receiptSchema = z.object({ version: z.literal(1), key_sha256: z.string().regex(/^[a-f0-9]{64}$/),
  request_sha256: z.string().regex(/^sha256:[a-f0-9]{64}$/), script_id: positiveId,
  before_asset_ids: z.array(positiveId).refine(ids => new Set(ids).size === ids.length),
  verified_asset: assetIdentity.nullable() }).strict()

/** Exact project, category and uploaded image represented by one remote parent asset. */
export type RegisteredImageAsset = z.infer<typeof assetIdentity>

/** Versioned request evidence written before dispatch; verified_asset is assigned at most once. */
export type AssetRegistrationReceipt = z.infer<typeof receiptSchema>

/** Request fields required to validate a stored registration receipt. */
export interface AssetRegistrationReceiptBinding {
  key: string
  requestHash: string
  scriptId: number
  assetType: 1 | 2 | 3
  name: string
  url: string
}

function storageFailure(operation: string, cause: unknown): JubianError {
  const failure = new JubianError('CONTRACT_CHANGED', `Image registration receipt ${operation} failed; retain the original idempotency_key, inspect its receipt and ledger, and do not resend or choose another key`)
  failure.cause = cause
  return failure
}

/**
 * Create the private receipt directory before acquiring a writer lock.
 * @param path - Versioned receipt location.
 * @throws {JubianError} CONTRACT_CHANGED when receipt storage is unavailable.
 */
export async function prepareAssetRegistrationReceiptDirectory(path: string): Promise<void> {
  try { await mkdir(dirname(path), { recursive: true, mode: 0o700 }) }
  catch (error) { throw storageFailure('directory creation', error) }
}

/**
 * Coordinate receipt writers while preserving typed operation failures.
 * @param path - Receipt whose file operations must be serialized.
 * @param operation - File-only read and commit operation; network calls remain outside this lock.
 * @returns The operation's result after lock release.
 * @throws {JubianError} CONTRACT_CHANGED for lock acquisition or release failures.
 */
export async function withAssetRegistrationReceiptLock<T>(path: string, operation: () => Promise<T>): Promise<T> {
  try { return await withFileLock(path, operation) }
  catch (error) {
    if (error instanceof JubianError) throw error
    throw storageFailure('writer coordination', error)
  }
}

/**
 * Locate one versioned receipt without using the caller's key as a path component.
 * @param ledger - Account-scoped ledger owning the receipt directory.
 * @param key - Original registration key.
 * @returns Absolute private receipt path.
 */
export function assetRegistrationReceiptPath(ledger: JubianLedger, key: string): string {
  return join(ledger.root, 'asset-registration-receipts', `${createHash('sha256').update(key).digest('hex')}.v1.json`)
}

/**
 * Build the pre-dispatch evidence for a registration whose complete inventory has been read.
 * @param binding - Exact original request and key.
 * @param beforeIds - Every asset ID in the complete pre-dispatch inventory.
 * @returns An unverified receipt; creating this value performs no write.
 */
export function newAssetRegistrationReceipt(binding: AssetRegistrationReceiptBinding, beforeIds: number[]): AssetRegistrationReceipt {
  return { version: 1, key_sha256: createHash('sha256').update(binding.key).digest('hex'),
    request_sha256: binding.requestHash, script_id: binding.scriptId, before_asset_ids: beforeIds, verified_asset: null }
}

/**
 * Read and validate a receipt; only ENOENT means no receipt exists.
 * @param path - Private versioned receipt location.
 * @param binding - Current request, which must match the original request exactly.
 * @returns Validated evidence, or null for an absent file.
 * @throws {JubianError} CONTRACT_CHANGED for malformed, unsupported or mismatched evidence.
 */
export async function readAssetRegistrationReceipt(path: string,
  binding: AssetRegistrationReceiptBinding): Promise<AssetRegistrationReceipt | null> {
  let text: string
  try { text = await readFile(path, 'utf8') }
  catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return null
    throw storageFailure('read', error)
  }
  let value: unknown
  try { value = JSON.parse(text) }
  catch (_error) { throw new JubianError('CONTRACT_CHANGED', 'Image registration receipt is not readable JSON; retain the original key and do not resend') }
  const parsed = receiptSchema.safeParse(value)
  if (!parsed.success) throw new JubianError('CONTRACT_CHANGED', 'Image registration receipt is invalid or unsupported; retain the original key and do not resend')
  const receipt = parsed.data, asset = receipt.verified_asset
  if (receipt.key_sha256 !== createHash('sha256').update(binding.key).digest('hex')
    || receipt.request_sha256 !== binding.requestHash || receipt.script_id !== binding.scriptId
    || (asset !== null && (asset.script_id !== binding.scriptId || asset.asset_type !== binding.assetType
      || asset.name !== binding.name || asset.url !== binding.url || receipt.before_asset_ids.includes(asset.asset_id)))) {
    throw new JubianError('CONTRACT_CHANGED', 'Image registration receipt belongs to a different request or has inconsistent asset evidence')
  }
  return receipt
}

/**
 * Atomically replace a receipt while its caller holds the receipt's writer lock.
 * @param path - Versioned receipt location.
 * @param receipt - Complete validated next value.
 */
export async function saveAssetRegistrationReceipt(path: string, receipt: AssetRegistrationReceipt): Promise<void> {
  try { await writeFileAtomic(path, `${JSON.stringify(receipt)}\n`, { mode: 0o600, dirMode: 0o700 }) }
  catch (error) { throw storageFailure('write', error) }
}
