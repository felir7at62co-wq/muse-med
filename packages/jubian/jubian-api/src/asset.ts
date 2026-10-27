/**
 * Asset and material reads: the remote source of truth a shot match selects from.
 *
 * `is_local` mirrors the provider's `isLocal` flag and `status` mirrors
 * `hsAssetStatus`; both are carried through so a caller can apply its own
 * admission rules without re-reading the raw payload.
 *
 * The asset and material endpoints spell the display name `assetName` and the
 * file `assetUrl`; a reader accepts those first and keeps the spelling the
 * earlier captures showed.
 */
import { readPayload } from './reading.ts'
import { invalid, wireObject as object, wireRows as rowsOf, wireTotal as totalOf, wirePositiveId as id, wireNullableText as nullableText } from './wire.ts'

function flag(value: unknown): boolean {
  return value === 1 || value === true
}

/** One asset row as this plugin exposes it. */
export interface AssetRow { asset_id: number; name: string | null; asset_type: number | null }

/** One asset with its local-upload flag and remote status. */
export interface AssetDetail extends AssetRow { is_local: boolean; status: string | null }

/** Provider image task facts; failure text is classified without copying remote messages. */
export interface ImageGeneration {
  status: 'pending' | 'succeeded' | 'failed' | 'unknown'
  task_id: number | null
  result_id: number | null
  error_code: 'reference_limit' | 'content_refused' | 'insufficient_credits' | 'provider_failure' | null
  max_reference_images: number | null
}

/**
 * Read an image task result independently of whether it has produced a usable image.
 * @param data - Generated-image endpoint data, with provider task status when available.
 * @returns Task identity and classified failure, or null for older URL-only responses.
 */
export function readImageGeneration(data: unknown): ImageGeneration | null {
  return readPayload('readImageGeneration', data, () => {
    const row = Array.isArray(data) ? object(data[0]) : object(data)
    const remoteStatus = nullableText(row.resultStatus)
    if (remoteStatus === null) return null
    const state = remoteStatus.trim().toLowerCase()
    const status = state === 'failed' || state === 'succeeded' ? state
      : ['submit', 'waiting', 'pending', 'running', 'processing'].includes(state) ? 'pending' : 'unknown'
    const message = nullableText(row.resultMsg) ?? ''
    const maximum = /最多输入([1-9][0-9]*)张图/.exec(message)
    const limit = maximum === null ? null : Number(maximum[1])
    const maxReferenceImages = status === 'failed' && limit !== null && Number.isSafeInteger(limit) ? limit : null
    return { status, task_id: row.taskId === undefined || row.taskId === null ? null : id(row.taskId),
      result_id: row.resultId === undefined || row.resultId === null ? null : id(row.resultId),
      error_code: status === 'failed' ? maxReferenceImages !== null ? 'reference_limit'
        : /request was rejected by the safety system/i.test(message) ? 'content_refused'
          : /用户额度不足|余额不足|insufficient (?:credits|balance|quota)/iu.test(message)
            ? 'insufficient_credits' : 'provider_failure' : null,
      max_reference_images: maxReferenceImages }
  })
}

/** One material row from the project's subject setting. */
export interface MaterialRow {
  material_id: number
  asset_id: number | null
  name: string | null
  url: string | null
  material_type: number | null
  is_used: boolean
  status: string | null
}

/**
 * Read one page of the project's assets.
 * @param data - Envelope `data` from `/aigc/asset/list`.
 * @returns The page total and its mapped asset rows.
 */
export function readAssetList(data: unknown): { total: number; rows: AssetRow[] } {
  return readPayload('readAssetList', data, () => {
    const rows = rowsOf(data)
    return { total: totalOf(data, rows.length), rows: rows.map(row => ({ asset_id: id(row.id ?? row.assetId),
      name: nullableText(row.assetName ?? row.name), asset_type: typeof row.assetType === 'number' ? row.assetType : null })) }
  })
}

/**
 * Read one asset, keeping the flags an admission rule needs.
 * @param data - Envelope `data` from `/aigc/asset/{assetId}`.
 * @returns The asset's identity plus its local and Hosting status flags.
 */
export function readAssetPage(data: unknown): AssetDetail {
  return readPayload('readAssetPage', data, () => {
    const row = object(data)
    return { asset_id: id(row.id ?? row.assetId), name: nullableText(row.assetName ?? row.name),
      asset_type: typeof row.assetType === 'number' ? row.assetType : null,
      is_local: flag(row.isLocal), status: nullableText(row.hsAssetStatus) }
  })
}

/**
 * Read the project's subject-setting materials.
 * @param data - Envelope `data` from `/aigc/material/list`.
 * @returns The page total and its mapped material rows.
 */
export function readMaterialList(data: unknown): { total: number; rows: MaterialRow[] } {
  return readPayload('readMaterialList', data, () => {
    const rows = rowsOf(data)
    return { total: totalOf(data, rows.length), rows: rows.map(row => ({
      material_id: id(row.id ?? row.materialId),
      asset_id: row.assetId === undefined || row.assetId === null ? null : id(row.assetId),
      name: nullableText(row.assetName ?? row.materialName ?? row.name),
      url: nullableText(row.assetUrl ?? row.materialUrl ?? row.url),
      material_type: typeof row.materialType === 'number' ? row.materialType
        : typeof row.assetType === 'number' ? row.assetType : null,
      is_used: flag(row.isUsed), status: nullableText(row.hsAssetStatus) })) }
  })
}

/**
 * Read the generated image reference for one asset.
 *
 * The endpoint answers with the asset's generated images as a list, and each row
 * carries the material id as `id` and the file as `assetUrl`. Both the list and
 * the single-object form are accepted; other observed spellings (`url`,
 * `materialUrl`, `materialId`) still read, because the same endpoint answered
 * with them before. A list must contain exactly one row: provider order cannot
 * establish which of several generated images belongs to the requested task.
 * @param data - Envelope `data` from `/aigc/material/getGeneratedImageByAssetId`.
 * @returns The reference URL and its material id when the provider sent one.
 * @throws {JubianError} `CONTRACT_CHANGED` when a list is empty or ambiguous, or the row has no usable URL.
 */
export function readGeneratedImage(data: unknown): { url: string; material_id: number | null } {
  return readPayload('readGeneratedImage', data, () => {
    const row = Array.isArray(data)
      ? data.length === 1 ? object(data[0]) : invalid()
      : object(data)
    const url = row.assetUrl ?? row.url ?? row.materialUrl
    if (typeof url !== 'string' || !url.trim()) invalid()
    const materialId = row.id ?? row.materialId
    return { url, material_id: materialId === undefined || materialId === null ? null : id(materialId) }
  })
}
