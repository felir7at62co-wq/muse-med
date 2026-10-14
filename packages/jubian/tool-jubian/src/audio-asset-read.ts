/** Audio asset identities from the provider's project asset endpoints. */
import { JubianError } from '@deepseek-ai/dsh-jubian'
import type { JubianClient } from '@deepseek-ai/dsh-jubian'
import { readVoiceSlot } from './voice-slot.ts'

/** One project audio asset; duration is unavailable until a media read measures the sample. */
export interface AudioAsset {
  asset_id: number
  script_id: number
  asset_type: 4
  name: string | null
  url: string | null
  audio_duration: number | null
  is_local: boolean
  /** Provider deletion evidence; active requires delFlag=0 without conflicting deletion, absence is unknown. */
  liveness?: 'active' | 'deleted' | 'unknown'
  /** Stable character ID decoded from a canonical project-bound voice suffix; absent on legacy or malformed names. */
  character_id?: string
  /** Explicit life period decoded with the shared character ID; not inferred from a human name. */
  voice_period_id?: string
  /** Canonical shared-identity suffix; it is metadata, not evidence of speaker quality. */
  voice_slot_tag?: string
}

/** Explicit page selection for the project's audio parents. */
export interface AudioAssetListArgs {
  script_id: number
  page_num: number
  page_size: number
  asset_name?: string | undefined
}

/** A remote page with evidence of whether it contains the entire matching inventory. */
export interface AudioAssetPage {
  script_id: number
  page_num: number
  page_size: number
  total: number
  returned: number
  /** True only for a first page containing every matching parent. */
  complete: boolean
  has_more: boolean
  assets: AudioAsset[]
}

function fail(detail: string): never { throw new JubianError('CONTRACT_CHANGED', detail) }

function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) fail('Unreadable audio asset payload')
  return value as Record<string, unknown>
}

function identity(value: unknown): number {
  const candidate = typeof value === 'string' && /^[1-9][0-9]*$/.test(value) ? Number(value) : value
  if (typeof candidate !== 'number' || !Number.isSafeInteger(candidate) || candidate < 1) fail('Unreadable audio asset identity')
  return candidate
}

function optionalText(value: unknown): string | null {
  if (value === undefined || value === null) return null
  if (typeof value !== 'string') fail('Unreadable audio asset text field')
  return value.trim() ? value : null
}

function deletionEvidence(source: Record<string, unknown>): Pick<AudioAsset, 'liveness'> {
  const flag = source.delFlag, deleted = source.deleted
  if (flag === undefined && deleted === undefined) return {}
  if ([flag, deleted].some(value => value === 1 || value === '1' || value === true)) return { liveness: 'deleted' }
  if ((flag === 0 || flag === '0')
    && (deleted === undefined || deleted === 0 || deleted === '0' || deleted === false)) {
    return { liveness: 'active' }
  }
  return { liveness: 'unknown' }
}

/**
 * Read an audio parent from an already accepted provider payload, checking its project and category.
 * audio_duration is null; callers measure the sample through a media read. Deletion fields are
 * projected independently: absent or ambiguous evidence never establishes an active shared voice.
 * @param data - Envelope data from a project asset read.
 * @param scriptId - Project that must own the asset.
 * @param assetId - Exact requested identity, when reading a single asset.
 * @returns The audio identity and its media URL, which may be unavailable.
 */
export function readAudioAsset(data: unknown, scriptId: number, assetId?: number): AudioAsset {
  const source = record(data)
  const id = identity(source.id)
  const project = identity(source.scriptId)
  if (project !== scriptId || (assetId !== undefined && id !== assetId) || source.assetType !== 4) {
    fail('Audio asset identity, project or category mismatch')
  }
  const name = optionalText(source.assetName) ?? optionalText(source.name)
  return { asset_id: id, script_id: project, asset_type: 4, name,
    url: optionalText(source.assetUrl) ?? optionalText(source.url), audio_duration: null,
    is_local: source.isLocal === 1 || source.isLocal === true, ...deletionEvidence(source), ...readVoiceSlot(name, scriptId) }
}

/**
 * Read one exact project audio identity; only successful data:null establishes absence.
 * @param client - Authenticated provider transport.
 * @param scriptId - Project that must own the asset.
 * @param assetId - Exact audio parent identity.
 * @returns The validated audio asset, or null when the provider states it is absent.
 */
export async function getAudioAsset(client: JubianClient, scriptId: number, assetId: number): Promise<AudioAsset | null> {
  const { data } = await client.request({ method: 'GET', path: `/aigc/asset/${assetId}` })
  return data === null ? null : readAudioAsset(data, scriptId, assetId)
}

/**
 * List audio parents with the provider's total and explicit page completeness.
 * Missing pagination fields, repeated identities and inconsistent totals reject the read.
 * @param client - Authenticated provider transport.
 * @param args - Project, page selection and optional asset name filter.
 * @returns The validated audio page; complete states whether this page covers the matching inventory.
 */
export async function listAudioAssets(client: JubianClient, args: AudioAssetListArgs): Promise<AudioAssetPage> {
  const query = new URLSearchParams({ scriptId: String(args.script_id), assetType: '4', isParent: '1',
    pageNum: String(args.page_num), pageSize: String(args.page_size) })
  if (args.asset_name !== undefined) query.set('assetName', args.asset_name)
  const { data } = await client.request({ method: 'GET', path: `/aigc/asset/list?${query}` })
  const page = record(data)
  if (!Array.isArray(page.rows) || typeof page.total !== 'number' || !Number.isSafeInteger(page.total) || page.total < 0) {
    fail('Audio asset page lacks readable rows or total')
  }
  const assets = page.rows.map((value: unknown) => readAudioAsset(value, args.script_id))
  const returned = assets.length
  const offset = (args.page_num - 1) * args.page_size
  if (returned > args.page_size || (returned > 0 && offset + returned > page.total)
    || new Set(assets.map(asset => asset.asset_id)).size !== returned) {
    fail('Audio asset page identities or total are inconsistent')
  }
  return { script_id: args.script_id, page_num: args.page_num, page_size: args.page_size,
    total: page.total, returned, complete: args.page_num === 1 && returned === page.total,
    has_more: offset + returned < page.total, assets }
}

/** URLs from one explicit unpaged material array; no audio sample duration is inferred. */
export interface AudioAssetMaterialUrls { urls: string[]; material_count: number; complete: true }

function materialUrl(value: unknown): string {
  const text = optionalText(value)
  if (text === null) fail('Audio asset material is missing assetUrl')
  let url: URL
  try { url = new URL(text) }
  catch (_error) { return fail('Audio asset material assetUrl is unreadable') }
  if (url.protocol !== 'https:' || !url.hostname || url.username || url.password || url.hash || text.includes('\\')) {
    fail('Audio asset material assetUrl must be credential-free HTTPS')
  }
  return text
}

/**
 * Enumerate a parent's material URLs through the provider's unpaged project-material endpoint.
 * Only an explicit array establishes completeness. Unreadable rows and missing URLs reject the
 * whole read; parent and project fields are checked when present and are never invented.
 * @param client - Authenticated provider transport.
 * @param scriptId - Project supplied to the material query.
 * @param assetId - Parent supplied to the material query.
 * @returns Sorted unique URLs and the number of material rows, including repeated URLs.
 */
export async function listAudioAssetMaterialUrls(client: JubianClient, scriptId: number, assetId: number):
Promise<AudioAssetMaterialUrls> {
  const query = new URLSearchParams({ assetId: String(assetId), scriptId: String(scriptId) })
  const response = await client.request({ method: 'GET', path: `/aigc/material/selectNoPage?${query}` })
  const values = Array.isArray(response.data) ? response.data
    : response.envelope_layout === 'array-single' ? [response.data]
      : fail('Audio asset materials require a complete unpaged array')
  const urls = values.map((value: unknown) => {
    const material = record(value)
    if ((material.assetId !== undefined && identity(material.assetId) !== assetId)
      || (material.scriptId !== undefined && identity(material.scriptId) !== scriptId)) {
      fail('Audio asset material parent or project mismatch')
    }
    return materialUrl(material.assetUrl)
  })
  return { urls: [...new Set(urls)].sort(), material_count: values.length, complete: true }
}
