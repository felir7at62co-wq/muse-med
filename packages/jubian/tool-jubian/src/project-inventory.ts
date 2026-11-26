/** Validated project inventory reads shared by production and storyboard recovery. */
import type { JubianClient } from '@deepseek-ai/dsh-jubian'
import { readAssetList, readEpisodes, readMaterialList, readStoryboardPage } from '@deepseek-ai/dsh-jubian-api'

type Row = Record<string, unknown>

// These defaults also bound project inventories used by free storyboard readback.
export const defaultProjectInventoryLimits = { pageSize: 100, pageLimit: 20 } as const

function object(value: unknown): Row {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid project inventory response')
  return value as Row
}

/** Read all asset or subject pages, refusing duplicate or incomplete inventory evidence.
 * @param client - Authenticated transport.
 * @param scriptId - Bound remote project.
 * @param kind - Provider inventory being read.
 * @param pageSize - Configured page size.
 * @param pageLimit - Maximum pages to acquire.
 * @param signal - Optional cancellation checked before every page.
 * @returns Original validated inventory rows.
 */
export async function productionRows(client: JubianClient, scriptId: number, kind: 'asset' | 'material' | 'storyboard' | 'episode',
  pageSize: number, pageLimit: number, signal?: AbortSignal): Promise<Row[]> {
  const result: Row[] = [], seen = new Set<number>()
  let total: number | null = null
  for (let page = 1; page <= pageLimit; page++) {
    signal?.throwIfAborted()
    const { data } = await client.request({ method: 'GET',
      path: `/aigc/${kind}/list?scriptId=${scriptId}&pageNum=${page}&pageSize=${pageSize}`, ...(signal === undefined ? {} : { signal }) })
    const payload = object(data)
    const parsed = kind === 'asset' ? readAssetList(data) : kind === 'material' ? readMaterialList(data)
      : kind === 'episode' ? readEpisodes(data) : readStoryboardPage(data, scriptId)
    if (!Array.isArray(payload.rows) || typeof payload.total !== 'number' || !Number.isSafeInteger(payload.total)
      || payload.total < 0 || typeof parsed.total !== 'number' || total !== null && total !== parsed.total) {
      throw new Error('Project inventory pagination is incomplete or changed; read the inventory again')
    }
    if (payload.rows.length > pageSize) throw new Error('Provider inventory page exceeds the configured acquisition bound')
    total = parsed.total
    for (const value of payload.rows) {
      const row = object(value), id = Number(row.id)
      if (!Number.isSafeInteger(id) || id < 1 || seen.has(id)) throw new Error('Duplicate or invalid project inventory identity')
      if (row.scriptId !== undefined && Number(row.scriptId) !== scriptId) throw new Error('Project inventory contains a foreign asset')
      seen.add(id); result.push(row)
    }
    if (result.length === total) return result
    if (!payload.rows.length || result.length > total) break
  }
  throw new Error('Project inventory exceeds the configured page limit or is incomplete; no complete-inventory claim is available')
}
