/**
 * Asset and material reads: the remote source of truth a shot match selects from.
 *
 * `is_local` mirrors the provider's `isLocal` flag and `status` mirrors
 * `hsAssetStatus`; both are carried through so a caller can apply its own
 * admission rules without re-reading the raw payload.
 */
import { JubianError } from '@deepseek-ai/dsh-jubian'

function invalid(): never { throw new JubianError('CONTRACT_CHANGED') }

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid()
  return value as Record<string, unknown>
}

function rowsOf(value: unknown): Record<string, unknown>[] {
  const record = object(value)
  if (!Array.isArray(record.rows)) invalid()
  return record.rows.map(object)
}

function totalOf(value: unknown, fallback: number): number {
  const record = object(value)
  return typeof record.total === 'number' && Number.isSafeInteger(record.total) ? record.total : fallback
}

function id(value: unknown): number {
  const candidate = typeof value === 'string' && /^[1-9][0-9]*$/.test(value) ? Number(value) : value
  if (typeof candidate !== 'number' || !Number.isSafeInteger(candidate) || candidate < 1) invalid()
  return candidate
}

function nullableText(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null
}

function flag(value: unknown): boolean {
  return value === 1 || value === true
}

/** One asset row as this plugin exposes it. */
export interface AssetRow { asset_id: number; name: string | null; asset_type: number | null }

/** One asset with its local-upload flag and remote status. */
export interface AssetDetail extends AssetRow { is_local: boolean; status: string | null }

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
  const rows = rowsOf(data)
  return { total: totalOf(data, rows.length), rows: rows.map(row => ({ asset_id: id(row.id ?? row.assetId),
    name: nullableText(row.name), asset_type: typeof row.assetType === 'number' ? row.assetType : null })) }
}

/**
 * Read one asset, keeping the flags an admission rule needs.
 * @param data - Envelope `data` from `/aigc/asset/{assetId}`.
 * @returns The asset's identity plus its local and Hosting status flags.
 */
export function readAssetPage(data: unknown): AssetDetail {
  const row = object(data)
  return { asset_id: id(row.id ?? row.assetId), name: nullableText(row.name),
    asset_type: typeof row.assetType === 'number' ? row.assetType : null,
    is_local: flag(row.isLocal), status: nullableText(row.hsAssetStatus) }
}

/**
 * Read the project's subject-setting materials.
 * @param data - Envelope `data` from `/aigc/material/list`.
 * @returns The page total and its mapped material rows.
 */
export function readMaterialList(data: unknown): { total: number; rows: MaterialRow[] } {
  const rows = rowsOf(data)
  return { total: totalOf(data, rows.length), rows: rows.map(row => ({
    material_id: id(row.id ?? row.materialId),
    asset_id: row.assetId === undefined || row.assetId === null ? null : id(row.assetId),
    name: nullableText(row.materialName ?? row.name), url: nullableText(row.materialUrl ?? row.url),
    material_type: typeof row.materialType === 'number' ? row.materialType : null,
    is_used: flag(row.isUsed), status: nullableText(row.hsAssetStatus) })) }
}

/**
 * Read the generated image reference for one asset.
 *
 * The endpoint answers with the asset's generated images as a list, and each row
 * carries the material id as `id` and the file as `assetUrl`. Both the list and
 * the single-object form are accepted; other observed spellings (`url`,
 * `materialUrl`, `materialId`) still read, because the same endpoint answered
 * with them before. An empty list is a failure rather than an empty reference:
 * the caller asked for an image this asset does not have yet.
 * @param data - Envelope `data` from `/aigc/material/getGeneratedImageByAssetId`.
 * @returns The reference URL and its material id when the provider sent one.
 * @throws {JubianError} `CONTRACT_CHANGED` when the payload is neither a non-empty list nor an object,
 *   or when the row it reads carries no usable URL.
 */
export function readGeneratedImage(data: unknown): { url: string; material_id: number | null } {
  const row = Array.isArray(data) ? object(data[0]) : object(data)
  const url = row.assetUrl ?? row.url ?? row.materialUrl
  if (typeof url !== 'string' || !url.trim()) invalid()
  const materialId = row.id ?? row.materialId
  return { url, material_id: materialId === undefined || materialId === null ? null : id(materialId) }
}
