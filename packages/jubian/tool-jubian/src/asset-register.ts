/** Image registration reconciles exact uploaded-image identities and preserves original-key receipts. */
import { JubianError, type JubianClient, type JubianLedger, type JubianLedgerRecord } from '@deepseek-ai/dsh-jubian'
import { readAssetList, readAssetPage, readGeneratedImage, wireText } from '@deepseek-ai/dsh-jubian-api'
import { bodyHash, need, requireKey, writeUnderLedger, type WriteOutcome } from './write.ts'
import { assetRegistrationReceiptPath, newAssetRegistrationReceipt, readAssetRegistrationReceipt,
  saveAssetRegistrationReceipt, prepareAssetRegistrationReceiptDirectory, withAssetRegistrationReceiptLock,
  type AssetRegistrationReceipt, type AssetRegistrationReceiptBinding,
  type RegisteredImageAsset } from './asset-register-receipt.ts'

/** Deployment limits for a complete project asset inventory. */
export interface AssetRegistrationScanOptions { pageSize: number; pageLimit: number }

/** Explicit uploaded image registration; this operation never starts image generation. */
export interface ImageAssetRegistrationArgs {
  script_id: number
  asset_type: number
  asset_name: string
  asset_url: string
  idempotency_key: string
}

/**
 * Resolve bounded inventory pagination before accepting registrations.
 * @param config - Deployment page size and maximum page count; absent fields use the documented defaults.
 * @returns Validated scan limits.
 */
export function resolveAssetRegistrationScanOptions(config: {
  assetRegistrationPageSize?: number
  assetRegistrationPageLimit?: number
} = {}): AssetRegistrationScanOptions {
  const pageSize = config.assetRegistrationPageSize ?? 1000
  const pageLimit = config.assetRegistrationPageLimit ?? 100
  if (!Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 1000
    || !Number.isSafeInteger(pageLimit) || pageLimit < 1 || pageLimit > 100) {
    throw new JubianError('INVALID_ARGUMENT', 'assetRegistrationPageSize must be 1..1000 and assetRegistrationPageLimit must be 1..100')
  }
  return { pageSize, pageLimit }
}

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
function changed(detail: string): never { throw new JubianError('CONTRACT_CHANGED', detail) }
function bindingOf(args: ImageAssetRegistrationArgs): AssetRegistrationReceiptBinding {
  if (!Number.isSafeInteger(args.script_id) || args.script_id <= 0 || !args.asset_name.trim()
    || (args.asset_type !== 1 && args.asset_type !== 2 && args.asset_type !== 3)) {
    throw new JubianError('INVALID_ARGUMENT', 'Image registration requires a positive script_id, nonempty name and asset_type 1, 2 or 3')
  }
  let url: URL
  try { url = new URL(args.asset_url) }
  catch (_error) { throw new JubianError('INVALID_ARGUMENT', 'asset_url must be an uploaded HTTPS image URL') }
  if (url.protocol !== 'https:' || url.username || url.password || url.hash || args.asset_url.includes('\\')) {
    throw new JubianError('INVALID_ARGUMENT', 'asset_url must be a credential-free uploaded HTTPS image URL')
  }
  const body = { scriptId: args.script_id, assetName: args.asset_name, assetType: args.asset_type, isLocal: 1, url: args.asset_url }
  return { key: requireKey(args.idempotency_key), requestHash: bodyHash(body), scriptId: args.script_id,
    assetType: args.asset_type, name: args.asset_name, url: args.asset_url }
}

async function inventory(client: JubianClient, binding: AssetRegistrationReceiptBinding, limits: AssetRegistrationScanOptions) {
  const assets: ReturnType<typeof readAssetList>['rows'] = [], seen = new Set<number>()
  let total: number | undefined
  for (let page = 1; page <= limits.pageLimit; page++) {
    const query = new URLSearchParams({ scriptId: String(binding.scriptId), assetType: String(binding.assetType),
      isParent: '1', pageNum: String(page), pageSize: String(limits.pageSize) })
    const { data } = await client.request({ method: 'GET', path: `/aigc/asset/list?${query}` })
    if (!object(data) || !Array.isArray(data.rows) || typeof data.total !== 'number'
      || !Number.isSafeInteger(data.total) || data.total < 0) changed('Image registration inventory lacks explicit rows or total')
    if (data.rows.some((value: unknown) => object(value) && value.scriptId !== undefined
      && wireText(value.scriptId) !== String(binding.scriptId))) changed('Image registration inventory contains another project')
    const current = readAssetList(data)
    total ??= current.total
    if (total !== current.total || current.rows.length > limits.pageSize
      || current.rows.some(asset => seen.has(asset.asset_id))
      || new Set(current.rows.map(asset => asset.asset_id)).size !== current.rows.length) {
      changed('Image registration inventory changed or repeated identities during pagination')
    }
    for (const asset of current.rows) { assets.push(asset); seen.add(asset.asset_id) }
    if (seen.size === total) return assets
    if (seen.size > total || current.rows.length === 0) break
  }
  return changed('Image registration inventory is incomplete; no new asset identity can be claimed')
}

type IdentityRead = { status: 'matching'; asset: RegisteredImageAsset } | { status: 'asset_missing' | 'identity_mismatch' }
async function materialUrlMatches(client: JubianClient, binding: AssetRegistrationReceiptBinding, assetId: number): Promise<boolean> {
  const { data } = await client.request({ method: 'GET', path: `/aigc/material/getGeneratedImageByAssetId?assetId=${assetId}` })
  const material = Array.isArray(data) ? data.length === 1 ? data[0] : undefined : data
  if (!object(material) || wireText(material.assetId) !== String(assetId)
    || (material.scriptId !== undefined && wireText(material.scriptId) !== String(binding.scriptId))) return false
  return readGeneratedImage(material).url === binding.url
}
async function readIdentity(client: JubianClient, binding: AssetRegistrationReceiptBinding, assetId: number,
  limits: AssetRegistrationScanOptions, listedInProject: boolean): Promise<IdentityRead> {
  const { data } = await client.request({ method: 'GET', path: `/aigc/asset/${assetId}` })
  if (data === null) return { status: 'asset_missing' }
  if (!object(data)) return changed('Image registration detail is unreadable')
  const asset = readAssetPage(data)
  if (asset.asset_id !== assetId || (data.scriptId !== undefined && wireText(data.scriptId) !== String(binding.scriptId))
    || asset.asset_type !== binding.assetType
    || asset.name !== binding.name
    || data.delFlag === 1 || data.delFlag === '1' || data.deleted === true) return { status: 'identity_mismatch' }
  if (data.scriptId === undefined && !listedInProject) {
    const current = await inventory(client, binding, limits)
    if (!current.some(candidate => candidate.asset_id === assetId && candidate.asset_type === binding.assetType
      && candidate.name === binding.name)) return { status: 'identity_mismatch' }
  }
  const parentUrl = data.assetUrl ?? data.url
  const urlMatches = parentUrl === undefined || parentUrl === null
    ? await materialUrlMatches(client, binding, assetId) : parentUrl === binding.url
  if (!urlMatches) return { status: 'identity_mismatch' }
  return { status: 'matching', asset: { asset_id: assetId, script_id: binding.scriptId,
    asset_type: binding.assetType, name: binding.name, url: binding.url } }
}

function checkRecord(record: JubianLedgerRecord | undefined, binding: AssetRegistrationReceiptBinding): void {
  if (record !== undefined && (record.method !== 'asset_register' || record.request_sha256 !== binding.requestHash
    || (record.script_id !== null && record.script_id !== binding.scriptId) || record.outcome === 'not_sent')) {
    changed('Idempotency key belongs to a different image registration request')
  }
}
function replayOutcome(record: JubianLedgerRecord | undefined): WriteOutcome {
  return { replayed: true, outcome: record?.outcome === 'accepted' ? 'accepted' : 'unknown',
    response_sha256: record?.response_sha256 ?? null, data: null }
}

type ReceiptStatus = 'verified' | 'unconfirmed' | 'ambiguous' | 'identity_mismatch' | 'asset_missing' | 'receipt_missing'
function resultOf(outcome: WriteOutcome, path: string, status: ReceiptStatus, asset: RegisteredImageAsset | null,
  matching: RegisteredImageAsset[] = [], error?: JubianError): Record<string, unknown> {
  const verified = status === 'verified'
  return { ...outcome, status, receipt_path: path, created_asset_id: asset?.asset_id ?? null,
    new_asset_ids: verified && !outcome.replayed && asset !== null ? [asset.asset_id] : [],
    matching_assets: matching, verified_readback: verified,
    ...(error === undefined ? {} : { reconciliation_error: { name: error.name, code: error.code } }),
    next: verified
      ? '资产已按项目、类别、名称和图片地址回读核对；保留原 idempotency_key。这仅核对登记图片，不代表已采用为正式主体素材。没有发起图片生成，费用以账户账单为准。'
      : asset !== null
        ? '保留原登记回执中的资产 ID，但当前资产缺失、身份改变或尚不能回读确认；不要复用或替换它。沿用原 key 只读核对，不重新登记。'
        : '登记结果尚无法唯一确定：没有认领其他新增资产。保留原 idempotency_key，使用 list/get 只读核对；不要换 key 或重复登记。' }
}

async function reconcile(client: JubianClient, binding: AssetRegistrationReceiptBinding,
  limits: AssetRegistrationScanOptions, path: string, receipt: AssetRegistrationReceipt,
  outcome: WriteOutcome): Promise<Record<string, unknown>> {
  try {
    if (receipt.verified_asset !== null) {
      const readback = await readIdentity(client, binding, receipt.verified_asset.asset_id, limits, false)
      return resultOf(outcome, path, readback.status === 'matching' ? 'verified' : readback.status,
        receipt.verified_asset, readback.status === 'matching' ? [readback.asset] : [])
    }
    const before = new Set(receipt.before_asset_ids), matched: RegisteredImageAsset[] = []
    const after = await inventory(client, binding, limits)
    for (const candidate of after) {
      if (before.has(candidate.asset_id) || candidate.asset_type !== binding.assetType || candidate.name !== binding.name) continue
      const readback = await readIdentity(client, binding, candidate.asset_id, limits, true)
      if (readback.status === 'matching') matched.push(readback.asset)
    }
    const asset = matched[0]
    if (asset === undefined || matched.length > 1) {
      return resultOf(outcome, path, asset === undefined ? 'unconfirmed' : 'ambiguous', null, matched)
    }
    const recorded = await withAssetRegistrationReceiptLock(path, async () => {
      const current = await readAssetRegistrationReceipt(path, binding)
      if (current === null) return changed('Image registration receipt disappeared during reconciliation; retain the original key and do not resend')
      if (current.verified_asset !== null) return current.verified_asset
      await saveAssetRegistrationReceipt(path, { ...current, verified_asset: asset })
      return asset
    })
    if (recorded.asset_id !== asset.asset_id) {
      return await reconcile(client, binding, limits, path, { ...receipt, verified_asset: recorded }, outcome)
    }
    return resultOf(outcome, path, 'verified', recorded, [recorded])
  } catch (error) {
    if (!(error instanceof JubianError)) throw error
    return resultOf(outcome, path, 'unconfirmed', receipt.verified_asset, [], error)
  }
}

/**
 * Register an uploaded image once and reconcile only exact new parent identities.
 * Complete inventory evidence is saved before dispatch. Same-key calls validate the original
 * project and request hash and retain the first verified ID even if its current remote identity
 * changes. A receipt without a ledger intent can compete for the original atomic claim; only its
 * winner dispatches. An existing intent only reconciles. Missing legacy receipts cannot establish
 * historical creation.
 * @param client - Provider transport; all verification uses read-only asset endpoints.
 * @param ledger - Account-scoped write ledger and private receipt owner.
 * @param args - Original project, image category, name, uploaded HTTPS URL and idempotency key.
 * @param limits - Resolved complete-inventory bounds.
 * @returns Independent write outcome and current readback status; ambiguous identities are never claimed.
 */
export async function registerImageAsset(client: JubianClient, ledger: JubianLedger, args: ImageAssetRegistrationArgs,
  limits: AssetRegistrationScanOptions): Promise<Record<string, unknown>> {
  const binding = bindingOf(args), path = assetRegistrationReceiptPath(ledger, binding.key)
  let receipt = await readAssetRegistrationReceipt(path, binding), record = await ledger.find(binding.key)
  checkRecord(record, binding)
  if (receipt === null && record !== undefined) return resultOf(replayOutcome(record), path, 'receipt_missing', null)
  if (receipt === null) {
    const before = await inventory(client, binding, limits)
    await prepareAssetRegistrationReceiptDirectory(path)
    const claimed = await withAssetRegistrationReceiptLock(path, async () => {
      const existing = await readAssetRegistrationReceipt(path, binding), latest = await ledger.find(binding.key)
      checkRecord(latest, binding)
      if (existing !== null || latest !== undefined) return { receipt: existing, record: latest }
      const created = newAssetRegistrationReceipt(binding, before.map(asset => asset.asset_id))
      await saveAssetRegistrationReceipt(path, created)
      return { receipt: created, record: latest }
    })
    receipt = claimed.receipt; record = claimed.record
  }
  if (receipt === null) return resultOf(replayOutcome(record), path, 'receipt_missing', null)
  let outcome = replayOutcome(record)
  if (record === undefined) {
    let dispatched = false
    try {
      outcome = await writeUnderLedger(ledger, binding.key, 'asset_register', () => ({ scriptId: binding.scriptId,
        assetName: binding.name, assetType: binding.assetType, isLocal: 1, url: binding.url }), async (body) => {
        dispatched = true
        return await client.request({ method: 'POST', path: '/aigc/asset', body: need(body) })
      }, undefined, { scriptId: binding.scriptId, verifyReplayBody: true })
    } catch (error) {
      if (!dispatched || !(error instanceof JubianError)) throw error
      outcome = { ...replayOutcome(await ledger.find(binding.key)), replayed: false }
    }
  }
  return await reconcile(client, binding, limits, path, receipt, outcome)
}
