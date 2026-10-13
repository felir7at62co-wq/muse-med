/** Current shared-project asset references, inspected without writes or deletion authority. */
import type { JubianClient } from '@deepseek-ai/dsh-jubian'
import { JubianError } from '@deepseek-ai/dsh-jubian'
import { readVoiceSlot } from '@deepseek-ai/dsh-jubian-api'
import { realpath } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { configuredVoiceProfiles, ProjectFiles } from './matching.ts'

type Row = Record<string, unknown>
type InventoryRow = Row & { id: number }
type InventoryKind = 'asset' | 'material' | 'episode' | 'storyboard'
/** Read bounds supplied by validated deployment configuration. */
export interface SharedUsageLimits { pageSize: number; pageLimit: number; outputLimit: number }
/** Exact asset or explicit character identity; names never select a person. */
export interface SharedUsageFilter {
  asset_id?: number
  character_id?: string
  /** Shared output offset across the independently sorted result arrays. */
  output_offset?: number
}
/** An incomplete read or an identity ambiguity; no diagnostic authorizes deletion. */
export interface SharedUsageIssue { code: string; message: string; inventory: string; ids: number[] }
/** One exact asset bound to one current storyboard package, regardless of repeated material rows. */
export interface SharedAssetUse {
  asset_id: number
  material_ids: number[]
  storyboard_id: number
  storyboard_name: string | null
  episode_id: number | null
  episode_number: number | null
  episode_name: string | null
  status: 'current_remote_package_reference'
}
/** A current remote asset; unknown counts remain null instead of becoming zero. */
export interface SharedAssetSummary {
  asset_id: number
  name: string | null
  asset_type: number | null
  urls: string[]
  character_id: string | null
  voice_period_id: string | null
  identity_source: 'remote_voice_tag' | 'local_manifest' | 'unknown'
  current_local_voice: boolean
  package_count: number | null
  observed_package_count: number
  delete_allowed: false
}
/** Same project/person/period metadata identifies candidates, not interchangeable acoustic content. */
export interface SharedVoiceDuplicates {
  character_id: string
  voice_period_id: string
  asset_ids: number[]
  preferred_asset_id: number | null
  current_local_asset_ids: number[]
  selection: 'retain_local_adopted' | 'most_current_packages_then_lowest_id' | 'inspection_incomplete'
  speaker_verified: false
  delete_allowed: false
}
/** Bounded current bindings; historical tasks and other computers' local plans are not enumerated. */
export interface SharedUsagePreview {
  method: 'shared_usage_preview'
  script_id: number
  /** Whether the inventory and reference reads support exact current-package counts. */
  complete: boolean
  /** Whether the selected identities and returned arrays cover the whole requested query. */
  query_complete: boolean
  stable_inventory: boolean
  assets: SharedAssetSummary[]
  uses: SharedAssetUse[]
  duplicate_audio_groups: SharedVoiceDuplicates[]
  issues: SharedUsageIssue[]
  totals: { assets: number; uses: number; duplicate_audio_groups: number; issues: number }
  truncated: boolean
  /** Cross-page evidence; only matching hashes may combine into one inspected query. */
  pagination: { output_offset: number; output_limit: number; next_offset: number | null; query_sha256: string }
  coverage: {
    current_remote_packages: boolean
    /** Every live role and voice asset has an explicit character identity in the stable inventory. */
    character_identity_complete: boolean
    historical_generation_tasks: false
    other_computers_local_plans: false
    other_accounts_voice_defaults: false
    atomic_remote_snapshot: false
  }
  read_only: true
  local_writes: 0
  remote_writes: 0
  paid_requests: 0
  next: string
}

function object(value: unknown): Row | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Row : undefined
}
function positive(value: unknown): number | undefined {
  const number = typeof value === 'string' && /^[1-9][0-9]*$/.test(value) ? Number(value) : value
  return typeof number === 'number' && Number.isSafeInteger(number) && number > 0 ? number : undefined
}
function text(value: unknown): string | null { return typeof value === 'string' && value.trim() ? value : null }
function idOf(row: Row, kind: InventoryKind): number | undefined {
  if (row.id !== undefined && row[`${kind}Id`] !== undefined && positive(row.id) !== positive(row[`${kind}Id`])) return undefined
  return positive(row.id ?? row[`${kind}Id`])
}
const issueMessages = {
  UNREADABLE_PAGE: 'The provider page needs readable rows and an exact nonnegative total.',
  CHANGING_PAGE: 'The provider total changed or a page exceeded the requested size.',
  INVALID_PAGE_IDENTITY: 'A provider row has a missing, contradictory, repeated or foreign identity.',
  INCOMPLETE_PAGE: 'The provider rows do not reach the declared inventory total.',
  PAGE_LIMIT: 'The configured page limit was reached before the inventory was complete.',
  UNREADABLE_CONFIG: 'The saved package model configuration is not a readable object.',
  REFERENCE_FIELDS_MISSING: 'The package omitted both saved material reference lists.',
  UNREADABLE_REFERENCES: 'A package material reference list is not a readable array.',
  UNREADABLE_REFERENCE: 'A package material reference is not a readable object.',
  INVALID_REFERENCE_IDENTITY: 'A package reference has contradictory IDs or URLs, or an unreadable media type.',
  AMBIGUOUS_REFERENCE_URL: 'Several assets share this reference URL; an exact parent or material ID is required.',
  UNRESOLVED_REFERENCE: 'The exact package reference does not resolve to a current asset of the declared media type.',
  CONTRADICTORY_MATERIAL_URL: 'The specified material ID belongs to a different URL from the package reference.',
  FOREIGN_LOCAL_MANIFEST: 'The local manifest names a different remote project.',
  LOCAL_ASSET_IDENTITY_CONTRADICTION: 'The local character mapping does not match the official remote category, material, name or URL.',
  AMBIGUOUS_LOCAL_CHARACTER: 'The local manifest assigns the same asset to more than one character identity.',
  LOCAL_VOICE_IDENTITY_CONTRADICTION: 'The locally adopted voice conflicts with its shared character or life-period metadata.',
  INVENTORY_CHANGED: 'The second complete inventory read differs from the first or cannot be completed.',
  ASSET_LIVENESS_UNKNOWN: 'The provider asset omitted a readable removal flag.',
  MATERIAL_PARENT_UNRESOLVED: 'A material names a parent that is absent from the current live asset inventory.',
  UNREADABLE_EPISODE_ID: 'The package episode ID cannot be read; its episode remains unknown.',
  CHARACTER_FILTER_PARTIAL: 'This character query includes only explicitly identified role and voice assets; unmapped assets remain queryable by exact asset ID.',
}
function issue(issues: SharedUsageIssue[], code: keyof typeof issueMessages, inventory: string, ids: number[] = []): void {
  issues.push({ code, message: issueMessages[code], inventory, ids })
}
function parsed(value: unknown): unknown {
  if (typeof value !== 'string') return value
  try { return JSON.parse(value) }
  catch (_error) { return false }
}

interface Inventory { rows: InventoryRow[]; complete: boolean }
async function inventory(client: JubianClient, scriptId: number, kind: InventoryKind,
  limits: SharedUsageLimits, issues: SharedUsageIssue[], signal: AbortSignal | undefined): Promise<Inventory> {
  const collected: InventoryRow[] = [], seen = new Set<number>()
  let expected: number | undefined
  for (let page = 1; page <= limits.pageLimit; page++) {
    signal?.throwIfAborted()
    const { data } = await client.request({ method: 'GET', path:
      `/aigc/${kind}/list?scriptId=${scriptId}&pageNum=${page}&pageSize=${limits.pageSize}`,
    ...(signal === undefined ? {} : { signal }) })
    signal?.throwIfAborted()
    const carrier = object(data)
    if (!carrier || !Array.isArray(carrier.rows) || typeof carrier.total !== 'number'
      || !Number.isSafeInteger(carrier.total) || carrier.total < 0) {
      issue(issues, 'UNREADABLE_PAGE', kind); return { rows: collected, complete: false }
    }
    expected ??= carrier.total
    if (expected !== carrier.total || carrier.rows.length > limits.pageSize) {
      issue(issues, 'CHANGING_PAGE', kind); return { rows: collected, complete: false }
    }
    for (const value of carrier.rows) {
      const row = object(value), id = row && idOf(row, kind)
      if (!row || id === undefined || seen.has(id) || (row.scriptId !== undefined && positive(row.scriptId) !== scriptId)
        || (kind === 'storyboard' && row.scriptId === undefined)) {
        issue(issues, 'INVALID_PAGE_IDENTITY', kind, id === undefined ? [] : [id]); return { rows: collected, complete: false }
      }
      seen.add(id); collected.push({ ...row, id })
    }
    if (seen.size === expected) return { rows: collected, complete: true }
    if (!carrier.rows.length || seen.size > expected) {
      issue(issues, 'INCOMPLETE_PAGE', kind); return { rows: collected, complete: false }
    }
  }
  issue(issues, 'PAGE_LIMIT', kind); return { rows: collected, complete: false }
}
function fingerprint(rows: InventoryRow[]): string {
  return JSON.stringify(rows.toSorted((left, right) => left.id - right.id))
}
function urlsOf(row: Row, keys: readonly string[]): string[] {
  return [...new Set(keys.map(key => text(row[key])).filter((value): value is string => value !== null))].sort()
}
function category(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1 && value <= 4 ? value : null
}
function referenceLists(board: Row, issues: SharedUsageIssue[], boardId: number): Row[] {
  const configValue = parsed(board.modelConfig), config = object(configValue)
  if (configValue !== undefined && configValue !== null && !config) issue(issues, 'UNREADABLE_CONFIG', 'storyboard', [boardId])
  const values = [board.storyboardMaterialList, config?.materialList]
  if (values.every(value => value === undefined || value === null)) issue(issues, 'REFERENCE_FIELDS_MISSING', 'storyboard', [boardId])
  const result: Row[] = []
  for (const value of values) {
    if (value === undefined || value === null) continue
    const list = parsed(value)
    if (!Array.isArray(list)) { issue(issues, 'UNREADABLE_REFERENCES', 'storyboard', [boardId]); continue }
    for (const entry of list) {
      const row = object(entry)
      if (!row) issue(issues, 'UNREADABLE_REFERENCE', 'storyboard', [boardId])
      else result.push(row)
    }
  }
  return result
}

interface ReferenceIndex {
  assetsByUrl: Map<string, SharedAssetSummary[]>
  materialById: Map<number, InventoryRow>
  materialIdsByParentUrl: Map<string, number[]>
}
function parentUrlKey(assetId: number, url: string): string { return JSON.stringify([assetId, url]) }
function referenceTargets(reference: Row, boardId: number, index: ReferenceIndex,
  issues: SharedUsageIssue[]): { asset: SharedAssetSummary; materialIds: number[] } | undefined {
  const urlValues = urlsOf(reference, ['materialUrl', 'assetUrl', 'url'])
  const [url, ...otherUrls] = urlValues
  const parentValues = [reference.materialAssetId, reference.assetId].filter(value => value !== undefined && value !== null)
  const parents = parentValues.map(positive)
  const material = reference.materialId === undefined || reference.materialId === null ? undefined : positive(reference.materialId)
  if (url === undefined || otherUrls.length !== 0 || parents.some(value => value === undefined) || new Set(parents).size > 1
    || (reference.materialId !== undefined && reference.materialId !== null && material === undefined)
    || !['image', 'audio'].includes(String(reference.materialType))) {
    issue(issues, 'INVALID_REFERENCE_IDENTITY', 'storyboard', [boardId]); return undefined
  }
  const matchingMaterial = material === undefined ? undefined : index.materialById.get(material)
  const candidates = (index.assetsByUrl.get(url) ?? []).filter(asset => (parents.length === 0 || parents[0] === asset.asset_id)
    && (material === undefined || positive(matchingMaterial?.assetId) === asset.asset_id)
    && (reference.materialType === 'audio' ? asset.asset_type === 4 : asset.asset_type !== null && asset.asset_type !== 4),
  )
  const [asset] = candidates
  if (asset === undefined || candidates.length !== 1) {
    issue(issues, candidates.length > 1 ? 'AMBIGUOUS_REFERENCE_URL' : 'UNRESOLVED_REFERENCE', 'storyboard',
      [boardId, ...candidates.map(asset => asset.asset_id)]); return undefined
  }
  const materialIds = (index.materialIdsByParentUrl.get(parentUrlKey(asset.asset_id, url)) ?? [])
    .filter(id => material === undefined || material === id)
  if (material !== undefined && !materialIds.includes(material)) {
    issue(issues, 'CONTRADICTORY_MATERIAL_URL', 'storyboard', [boardId, material]); return undefined
  }
  return { asset, materialIds }
}

async function localIdentities(files: ProjectFiles, config: Row, assets: SharedAssetSummary[],
  materialById: Map<number, InventoryRow>, issues: SharedUsageIssue[]): Promise<void> {
  let manifest: Row | undefined
  try { manifest = await files.json('assets_manifest.json') }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
  if (manifest !== undefined) {
    if (positive(manifest.script_id) !== positive(config.jubian_script_id)) issue(issues, 'FOREIGN_LOCAL_MANIFEST', 'local')
    else {
      const values = [manifest.items, manifest.lead_readonly_records].flatMap((value): unknown[] => {
        const entries: unknown[] = Array.isArray(value) ? value : []
        return entries
      })
      for (const asset of assets) {
        if (asset.identity_source === 'remote_voice_tag') continue
        const candidates = values.map(object).filter((row): row is Row => row !== undefined
          && positive(row.jubian_asset_id) === asset.asset_id && text(row.character_id) !== null)
        const rows = candidates.filter(row => asset.asset_type === 1 && row.official === true
          && ['character', '角色', '人物'].includes(String(row.type))
          && (row.name === undefined || row.name === asset.name)
          && (() => {
            const material = materialById.get(positive(row.jubian_material_id) ?? 0)
            return material !== undefined && positive(material.assetId) === asset.asset_id && text(row.url) !== null
              && urlsOf(material, ['assetUrl', 'materialUrl', 'url']).includes(String(row.url))
          })())
        if (rows.length !== candidates.length) issue(issues, 'LOCAL_ASSET_IDENTITY_CONTRADICTION', 'local', [asset.asset_id])
        const identities = [...new Set(rows.map(row => String(row.character_id)))]
        if (identities.length > 1) issue(issues, 'AMBIGUOUS_LOCAL_CHARACTER', 'local', [asset.asset_id])
        else for (const identity of identities) { asset.character_id = identity; asset.identity_source = 'local_manifest' }
      }
    }
  }
  const characters = object(config.project_bible)?.characters
  if (characters !== undefined && !Array.isArray(characters)) throw new JubianError('INVALID_ARGUMENT', 'Project characters must be an array')
  for (const value of characters ?? []) {
    const character = object(value)
    if (!character || !text(character.character_id)) throw new JubianError('INVALID_ARGUMENT', 'Project voices need explicit character identity')
    for (const voice of configuredVoiceProfiles(character)) {
      const asset = assets.find(entry => entry.asset_id === positive(voice.profile.reference_audio_asset_id))
      if (!asset || !asset.urls.includes(text(voice.profile.reference_audio) ?? '')) continue
      if (asset.identity_source === 'remote_voice_tag' && (asset.character_id !== character.character_id || asset.voice_period_id !== voice.voice_period_id)) {
        issue(issues, 'LOCAL_VOICE_IDENTITY_CONTRADICTION', 'local', [asset.asset_id]); continue
      }
      asset.current_local_voice = true
    }
  }
}

function duplicateGroups(assets: SharedAssetSummary[], complete: boolean): SharedVoiceDuplicates[] {
  const grouped = new Map<string, { character_id: string; voice_period_id: string; assets: SharedAssetSummary[] }>()
  for (const asset of assets) {
    if (asset.asset_type !== 4 || asset.identity_source !== 'remote_voice_tag') continue
    const key = JSON.stringify([asset.character_id, asset.voice_period_id]), group = grouped.get(key)
      ?? { character_id: String(asset.character_id), voice_period_id: String(asset.voice_period_id), assets: [] }
    group.assets.push(asset); grouped.set(key, group)
  }
  const result: SharedVoiceDuplicates[] = []
  for (const group of grouped.values()) {
    const rows = group.assets
    if (rows.length < 2) continue
    const adopted = rows.filter(row => row.current_local_voice).map(row => row.asset_id).sort((a, b) => a - b)
    let preferred = rows.reduce((left, right) => left.observed_package_count > right.observed_package_count
      || left.observed_package_count === right.observed_package_count && left.asset_id < right.asset_id ? left : right).asset_id
    for (const id of adopted) preferred = id
    result.push({ character_id: group.character_id, voice_period_id: group.voice_period_id,
      asset_ids: rows.map(row => row.asset_id).sort((a, b) => a - b),
      preferred_asset_id: !complete || adopted.length > 1 ? null : preferred,
      current_local_asset_ids: adopted, selection: !complete ? 'inspection_incomplete' : adopted.length ? 'retain_local_adopted' : 'most_current_packages_then_lowest_id',
      speaker_verified: false, delete_allowed: false })
  }
  return result
}

/**
 * Inspect complete current project bindings and compare a second inventory read before counting packages.
 * @param client - Authenticated read-only provider transport.
 * @param projectDir - Local project root containing its explicit remote project binding.
 * @param filter - Optional exact asset or character selector, applied after full inventory inspection.
 * @param limits - Configured pagination and output bounds; exhausted scans remain incomplete.
 * @param signal - Optional caller cancellation; cancels the current request and prevents further pages.
 * @returns Current package uses and non-deleting duplicate recommendations with explicit coverage limits.
 */
export async function sharedUsagePreview(client: JubianClient, projectDir: string, filter: SharedUsageFilter,
  limits: SharedUsageLimits, signal?: AbortSignal): Promise<SharedUsagePreview> {
  signal?.throwIfAborted()
  if (filter.asset_id !== undefined && positive(filter.asset_id) === undefined
    || filter.character_id !== undefined && text(filter.character_id) === null) throw new JubianError('INVALID_ARGUMENT', 'Use exact asset or character identities')
  const outputOffset = filter.output_offset === undefined ? 0 : filter.output_offset
  if (!Number.isSafeInteger(outputOffset) || outputOffset < 0) throw new JubianError('INVALID_ARGUMENT', 'output_offset must be a nonnegative safe integer')
  if (!Number.isSafeInteger(limits.pageSize) || limits.pageSize < 1 || limits.pageSize > 1000
    || !Number.isSafeInteger(limits.pageLimit) || limits.pageLimit < 1
    || !Number.isSafeInteger(limits.outputLimit) || limits.outputLimit < 1) throw new JubianError('INVALID_ARGUMENT', 'Shared usage read bounds must be positive integers; pageSize is at most 1000')
  const files = new ProjectFiles(await realpath(projectDir)), config = await files.json('project_config.json')
  const scriptId = positive(config.jubian_script_id)
  if (scriptId === undefined) throw new JubianError('INVALID_ARGUMENT', 'Project needs a positive jubian_script_id')
  const issues: SharedUsageIssue[] = [], inventories: Record<InventoryKind, Inventory> = {
    asset: { rows: [], complete: false }, material: { rows: [], complete: false },
    episode: { rows: [], complete: false }, storyboard: { rows: [], complete: false },
  }
  const kinds: InventoryKind[] = ['asset', 'material', 'episode', 'storyboard']
  for (const kind of kinds) inventories[kind] = await inventory(client, scriptId, kind, limits, issues, signal)
  for (const kind of kinds) inventories[kind].rows.sort((left, right) => left.id - right.id)
  let stable = Object.values(inventories).every(item => item.complete)
  if (stable) for (const kind of kinds) {
    const second = await inventory(client, scriptId, kind, limits, issues, signal)
    if (!second.complete || fingerprint(second.rows) !== fingerprint(inventories[kind].rows)) {
      stable = false; issue(issues, 'INVENTORY_CHANGED', kind)
    }
  }
  const materialRows = inventories.material.rows, assets: SharedAssetSummary[] = []
  const materialByParent = new Map<number, InventoryRow[]>()
  const index: ReferenceIndex = { assetsByUrl: new Map(), materialById: new Map(), materialIdsByParentUrl: new Map() }
  for (const material of materialRows) {
    const materialId = material.id, parentId = positive(material.assetId)
    index.materialById.set(materialId, material)
    if (parentId === undefined) continue
    const rows = materialByParent.get(parentId) ?? []
    rows.push(material); materialByParent.set(parentId, rows)
    for (const url of urlsOf(material, ['assetUrl', 'materialUrl', 'url'])) {
      const key = parentUrlKey(parentId, url), ids = index.materialIdsByParentUrl.get(key) ?? []
      ids.push(materialId); index.materialIdsByParentUrl.set(key, ids)
    }
  }
  for (const row of inventories.asset.rows) {
    const assetId = row.id
    if (row.delFlag !== '0' && row.delFlag !== 0) {
      if (row.delFlag !== '1' && row.delFlag !== 1) issue(issues, 'ASSET_LIVENESS_UNKNOWN', 'asset', [assetId])
      continue
    }
    const name = text(row.assetName ?? row.name), slot = category(row.assetType) === 4 ? readVoiceSlot(name, scriptId) : undefined
    assets.push({ asset_id: assetId, name, asset_type: category(row.assetType),
      urls: [...new Set([...urlsOf(row, ['assetUrl', 'url']), ...(materialByParent.get(assetId) ?? [])
        .flatMap(material => urlsOf(material, ['assetUrl', 'materialUrl', 'url']))])].sort(),
      character_id: slot?.character_id ?? null, voice_period_id: slot?.voice_period_id ?? null,
      identity_source: slot === undefined ? 'unknown' : 'remote_voice_tag', current_local_voice: false,
      package_count: null, observed_package_count: 0, delete_allowed: false })
  }
  const assetById = new Map(assets.map(asset => [asset.asset_id, asset]))
  for (const asset of assets) for (const url of asset.urls) {
    const rows = index.assetsByUrl.get(url) ?? []
    rows.push(asset); index.assetsByUrl.set(url, rows)
  }
  for (const row of materialRows) if (row.assetId !== null && row.assetId !== undefined && !assetById.has(positive(row.assetId) ?? 0)) {
    issue(issues, 'MATERIAL_PARENT_UNRESOLVED', 'material', [row.id])
  }
  await localIdentities(files, config, assets, index.materialById, issues)
  const episodeRows = inventories.episode.rows, uses: SharedAssetUse[] = []
  for (const board of inventories.storyboard.rows) {
    const boardId = board.id, episodeId = positive(board.episodeId) ?? null
    const episode = episodeRows.find(row => row.id === episodeId)
    if (board.episodeId !== null && board.episodeId !== undefined && episodeId === null) issue(issues, 'UNREADABLE_EPISODE_ID', 'storyboard', [boardId])
    const byAsset = new Map<number, Set<number>>()
    for (const reference of referenceLists(board, issues, boardId)) {
      const target = referenceTargets(reference, boardId, index, issues)
      if (!target) continue
      const materialIds = byAsset.get(target.asset.asset_id) ?? new Set<number>()
      for (const materialId of target.materialIds) materialIds.add(materialId)
      byAsset.set(target.asset.asset_id, materialIds)
    }
    for (const [assetId, materialIds] of byAsset) uses.push({ asset_id: assetId, material_ids: [...materialIds].sort((a, b) => a - b),
      storyboard_id: boardId, storyboard_name: text(board.storyboardName), episode_id: episodeId,
      episode_number: episode === undefined ? null : positive(episode.episodeCount) ?? null,
      episode_name: episode === undefined ? null : text(episode.episodeName ?? episode.name), status: 'current_remote_package_reference' })
  }
  signal?.throwIfAborted()
  await files.unchanged()
  signal?.throwIfAborted()
  const complete = stable && issues.length === 0
  const packageCounts = new Map<number, number>()
  for (const use of uses) packageCounts.set(use.asset_id, (packageCounts.get(use.asset_id) ?? 0) + 1)
  for (const asset of assets) {
    asset.observed_package_count = packageCounts.get(asset.asset_id) ?? 0
    asset.package_count = complete ? asset.observed_package_count : null
  }
  const duplicateAudio = duplicateGroups(assets, complete)
  const unidentified = assets.filter(asset => (asset.asset_type === 1 || asset.asset_type === 4) && asset.character_id === null)
  const characterIdentityComplete = stable && unidentified.length === 0
  const characterFilterPartial = filter.character_id !== undefined && !characterIdentityComplete
  if (characterFilterPartial) issue(issues, 'CHARACTER_FILTER_PARTIAL', 'query', unidentified.map(asset => asset.asset_id))
  const selected = assets.filter(asset => (filter.asset_id === undefined || asset.asset_id === filter.asset_id)
    && (filter.character_id === undefined || asset.character_id === filter.character_id)).sort((a, b) => a.asset_id - b.asset_id)
  const selectedIds = new Set(selected.map(asset => asset.asset_id))
  const selectedUses = uses.filter(use => selectedIds.has(use.asset_id))
    .sort((a, b) => a.storyboard_id - b.storyboard_id || a.asset_id - b.asset_id)
  const selectedGroups = duplicateAudio.filter(group => group.asset_ids.some(id => selectedIds.has(id)))
  const outputEnd = outputOffset + limits.outputLimit
  const maximumRows = Math.max(selected.length, selectedUses.length, selectedGroups.length, issues.length)
  const nextOffset = outputEnd < maximumRows ? outputEnd : null
  const truncated = outputOffset > 0 || outputEnd < maximumRows
  const querySha = createHash('sha256').update(JSON.stringify({ script_id: scriptId,
    selector: { asset_id: filter.asset_id, character_id: filter.character_id },
    inventories: kinds.map(kind => fingerprint(inventories[kind].rows)), input_sha256: [...files.observed.values()].sort(),
    assets: selected, uses: selectedUses, duplicate_audio_groups: selectedGroups, issues, complete })).digest('hex')
  const next = ['Read assets, uses and duplicate_audio_groups as arrays inside this result object.']
  if (!complete) next.push('The inventory or reference inspection is incomplete: null package counts and partial observed counts do not establish zero uses.')
  if (characterFilterPartial) next.push('The character filter covers only identified assets. Query unknown role or voice assets by exact asset_id; unrelated project work can continue.')
  if (truncated) next.push('This page omits rows before or after its output offset; an empty assets array on a later page does not establish asset absence.')
  if (nextOffset !== null) next.push(`Request output_offset=${nextOffset} with the same asset or character selector to continue reading these arrays.`)
  next.push('Combine pages only when pagination.query_sha256 matches; a changed hash requires a fresh query from output_offset=0.')
  next.push('Inspect acoustic suitability before choosing a voice; this preview does not authorize migration or deletion.')
  return { method: 'shared_usage_preview', script_id: scriptId, complete,
    query_complete: complete && !characterFilterPartial && !truncated, stable_inventory: stable,
    assets: selected.slice(outputOffset, outputEnd), uses: selectedUses.slice(outputOffset, outputEnd),
    duplicate_audio_groups: selectedGroups.slice(outputOffset, outputEnd), issues: issues.slice(outputOffset, outputEnd),
    totals: { assets: selected.length, uses: selectedUses.length, duplicate_audio_groups: selectedGroups.length, issues: issues.length },
    truncated,
    pagination: { output_offset: outputOffset, output_limit: limits.outputLimit, next_offset: nextOffset, query_sha256: querySha },
    coverage: { current_remote_packages: complete, character_identity_complete: characterIdentityComplete,
      historical_generation_tasks: false, other_computers_local_plans: false,
      other_accounts_voice_defaults: false, atomic_remote_snapshot: false },
    read_only: true, local_writes: 0, remote_writes: 0, paid_requests: 0,
    next: next.join(' ') }
}
