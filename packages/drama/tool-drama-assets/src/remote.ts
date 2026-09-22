/**
 * The two remote reads the comparison is made of, over the shared Jubian
 * transport.
 *
 * `readAssetList` and `readMaterialList` validate each page and map it to the
 * fields a selection decision needs. This comparison needs fields those mappings
 * do not carry: the asset row's `delFlag` decides whether the asset still exists,
 * and the material row's `createTime` is part of the evidence the pipeline's own
 * report script reads. Both readers stay the authority on what a page is — a page
 * they reject fails the call — and the extra provider fields are read from the
 * rows they accepted.
 *
 * Every page is read, not just the first: a project whose assets outgrew one page
 * would otherwise be reconciled against a fraction of itself, which is the same
 * class of quiet under-reporting this comparison exists to catch.
 *
 * @module @deepseek-ai/dsh-tool-drama-assets/remote
 */

import type { JubianClient } from '@deepseek-ai/dsh-jubian'
import { readAssetList, readMaterialList } from '@deepseek-ai/dsh-jubian-api'
import type { RemoteAsset, RemoteMaterial } from './types.ts'

/** Page size every read asks for: the provider's own documented maximum. */
const PAGE_SIZE = 1000

/** One page of a provider list, validated by its reader: the mapped rows and the declared total. */
interface ReadPage {
  /** The mapped rows the reader accepted, in provider order. */
  readonly rows: readonly object[]
  /** Total the provider declared for the whole list. */
  readonly total: number
}

/** One provider text field, or undefined for a value that is not text. */
function textOf(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined
}

/** One provider `assetName` field, read under either spelling the provider uses. */
function nameOf(row: Record<string, unknown>): string | undefined {
  return textOf(row['assetName']) ?? textOf(row['name'])
}

/** One provider `assetType` field, or undefined for a value that is not a number. */
function typeOf(row: Record<string, unknown>): number | undefined {
  return typeof row['assetType'] === 'number' ? row['assetType'] : undefined
}

/**
 * Read one accepted asset row's comparison fields.
 * @param mapped - The row as {@link readAssetList} mapped it.
 * @param raw - The same row as the provider sent it.
 * @returns The asset's id and the optional provider fields the evidence quotes.
 */
function assetOf(mapped: Record<string, unknown>, raw: Record<string, unknown>): RemoteAsset {
  return { asset_id: mapped['asset_id'] as number, del_flag: textOf(raw['delFlag']),
    name: nameOf(raw), asset_type: typeOf(raw), url: textOf(raw['url']),
    create_time: textOf(raw['createTime']) }
}

/**
 * Read one accepted material row's comparison fields.
 * @param mapped - The row as {@link readMaterialList} mapped it.
 * @param raw - The same row as the provider sent it.
 * @returns The material's id and the optional provider fields the evidence quotes.
 */
function materialOf(mapped: Record<string, unknown>, raw: Record<string, unknown>): RemoteMaterial {
  return { material_id: mapped['material_id'] as number,
    asset_id: (mapped['asset_id'] ?? null) as number | null, name: nameOf(raw),
    asset_type: typeOf(raw), is_used: raw['isUsed'] === 1,
    hs_asset_status: textOf(raw['hsAssetStatus']), url: textOf(raw['assetUrl']),
    create_time: textOf(raw['createTime']) }
}

/**
 * Read every page of one provider list endpoint.
 *
 * The reader's mapped rows are the provider's rows by index, so a mapped row
 * carries its own raw row alongside it and no field is ever read from a page the
 * reader did not accept.
 * @param client - Jubian transport.
 * @param path - The endpoint's path and query; `pageNum` and `pageSize` are added per page.
 * @param read - The reader that validates one page and maps its rows.
 * @param reduce - Maps one accepted row, its reader's mapping and its raw row, to the comparison fields.
 * @returns Every accepted row of every page, in provider order.
 */
async function readPages<Row>(
  client: JubianClient,
  path: string,
  read: (data: unknown) => ReadPage,
  reduce: (mapped: Record<string, unknown>, raw: Record<string, unknown>) => Row,
): Promise<Row[]> {
  const collected: Row[] = []
  let pageNum = 1
  for (;;) {
    const response = await client.request({ method: 'GET', path: `${path}&pageNum=${pageNum}&pageSize=${PAGE_SIZE}` })
    const page = read(response.data)
    const raw = (response.data as { rows: Record<string, unknown>[] }).rows
    // The reader's rows are the provider's rows by index, so every mapped row has a
    // raw row at the same index.
    collected.push(...page.rows.map((mapped, index) =>
      reduce(mapped as Record<string, unknown>, raw[index] as Record<string, unknown>)))
    if (page.rows.length < PAGE_SIZE || collected.length >= page.total) return collected
    pageNum += 1
  }
}

/**
 * Read every asset the remote project holds, removed rows included.
 *
 * The `delFlag` filter belongs to the comparison rather than here: a removed
 * asset is still a row this read returns, and only the comparison knows that a
 * removed asset is not an asset.
 * @param client - Jubian transport.
 * @param scriptId - Project to list.
 * @returns The project's assets with their comparison fields.
 */
export async function readRemoteAssets(client: JubianClient, scriptId: number): Promise<RemoteAsset[]> {
  return await readPages(client, `/aigc/asset/list?scriptId=${scriptId}`, readAssetList, assetOf)
}

/**
 * Read every material of the remote project's subject setting.
 *
 * The provider offers an `isUsed=1` filter and this read does not use it: the
 * comparison must keep the used rows and the alive rows apart, and a filter
 * applied here would make the two counts one fact.
 * @param client - Jubian transport.
 * @param scriptId - Project to list.
 * @returns The project's materials with their comparison fields.
 */
export async function readRemoteMaterials(client: JubianClient, scriptId: number): Promise<RemoteMaterial[]> {
  return await readPages(client, `/aigc/material/list?scriptId=${scriptId}`, readMaterialList, materialOf)
}
