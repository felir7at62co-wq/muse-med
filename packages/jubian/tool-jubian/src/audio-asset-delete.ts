/** Inspected deletion of project audio assets after current role and card references are removed. */
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { JubianError } from '@deepseek-ai/dsh-jubian'
import type { JubianClient, JubianLedger } from '@deepseek-ai/dsh-jubian'
import { stableSha256 } from '@deepseek-ai/dsh-jubian-api'
import { getAudioAsset, listAudioAssetMaterialUrls } from './audio-asset-read.ts'
import type { AudioAsset } from './audio-asset-read.ts'
import { atomicWriteJson, positiveInteger, validateProjectBinding } from './native.ts'
import { readPreparedJson } from './prepared-file.ts'
import { bodyHash, need, requireKey, writeUnderLedger } from './write.ts'
import { withAudioDeletionLock } from './audio-operation-lock.ts'

type Row = Record<string, unknown>

/** Resolved limits for complete remote card-reference inspection. */
export interface AudioReferenceScanOptions { pageSize: number; pageLimit: number }

/** Inputs for inspecting or applying one project-bound audio-library deletion. */
export interface AudioAssetDeleteArgs {
  method: string
  script_id?: number
  project_dir?: string
  asset_id?: number
  delete_reason?: string
  authorization_basis?: string
  checked_audio_asset_id?: number
  preview_path?: string
  idempotency_key?: string
}

interface References { characters: Row[]; storyboards: Row[]; complete: true }
interface Plan {
  version: 1
  operation: 'audio_asset_delete'
  script_id: number
  asset: AudioAsset
  asset_urls: string[]
  references: References
  delete_reason: string
  authorization_basis: string
  fingerprint: string
}
function fail(detail: string): never { throw new JubianError('CONTRACT_CHANGED', detail) }
function invalid(detail: string): never { throw new JubianError('INVALID_ARGUMENT', detail) }
function row(value: unknown): Row {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('Unreadable audio reference record')
  return value as Row
}
function parsed(value: unknown): unknown {
  if (typeof value !== 'string') return value
  try { return JSON.parse(value) }
  catch (_error) { return fail('Unreadable audio reference JSON; complete inspection is required') }
}
function requiredText(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) invalid(`${field} must identify the authorized audio deletion`)
  return value.trim()
}

/**
 * Resolve deployment bounds before inspecting references.
 * @param config - Page size and maximum pages configured on the Jubian plugin.
 * @returns Validated complete-scan limits.
 */
export function resolveAudioReferenceScanOptions(config: {
  audioReferencePageSize?: number
  audioReferencePageLimit?: number
} = {}): AudioReferenceScanOptions {
  const pageSize = config.audioReferencePageSize ?? 1000
  const pageLimit = config.audioReferencePageLimit ?? 100
  if (!Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 1000
    || !Number.isSafeInteger(pageLimit) || pageLimit < 1 || pageLimit > 100) {
    invalid('audioReferencePageSize must be 1..1000 and audioReferencePageLimit must be 1..100')
  }
  return { pageSize, pageLimit }
}

function referencesAsset(value: unknown, urls: string[]): boolean {
  const item = row(value)
  if (item.materialType === 'audio' && (typeof item.materialUrl !== 'string' || !item.materialUrl.trim())) {
    fail('Unreadable card audio URL; complete inspection is required')
  }
  return item.materialType === 'audio' && typeof item.materialUrl === 'string' && urls.includes(item.materialUrl)
}
function cardUses(board: Row, urls: string[]): boolean {
  const config = parsed(board.modelConfig)
  const lists = [parsed(board.storyboardMaterialList), config === null || config === undefined ? undefined : row(config).materialList]
  if (lists.every(list => list === undefined || list === null)) fail('Incomplete card reference fields; complete inspection is required')
  return lists.some((list) => {
    if (list === undefined || list === null) return false
    const decoded = parsed(list)
    if (!Array.isArray(decoded)) fail('Unreadable card material list; complete inspection is required')
    return decoded.some(item => referencesAsset(item, urls))
  })
}
async function inspectReferences(client: JubianClient, root: string, asset: AudioAsset,
  urls: string[], limits: AudioReferenceScanOptions): Promise<References> {
  const config = row(JSON.parse((await readFile(join(root, 'project_config.json'), 'utf8')).replace(/^\uFEFF/, '')))
  const bible = config.project_bible === undefined ? {} : row(config.project_bible)
  const characters = bible.characters ?? []
  if (!Array.isArray(characters)) fail('Unreadable project voice bindings')
  const bindings: Row[] = []
  for (const value of characters) {
    const character = row(value)
    if (character.voice_profile === undefined) continue
    const voice = row(character.voice_profile)
    if (voice.reference_audio_asset_id === asset.asset_id
      || (typeof voice.reference_audio === 'string' && urls.includes(voice.reference_audio))) {
      bindings.push({ character_id: character.character_id, name: character.name ?? null })
    }
  }
  const storyboards: Row[] = [], seen = new Set<number>()
  let expectedTotal: number | undefined
  for (let page = 1; page <= limits.pageLimit; page++) {
    const data = row((await client.request({ method: 'GET', path:
      `/aigc/storyboard/list?scriptId=${asset.script_id}&pageNum=${page}&pageSize=${limits.pageSize}` })).data)
    if (!Array.isArray(data.rows) || typeof data.total !== 'number' || !Number.isSafeInteger(data.total) || data.total < 0) {
      fail('Incomplete card reference scan: rows and total are required')
    }
    expectedTotal ??= data.total
    if (expectedTotal !== data.total || data.rows.length > limits.pageSize) fail('Incomplete or changing card reference scan')
    for (const value of data.rows) {
      const board = row(value), id = positiveInteger(board.id)
      if (positiveInteger(board.scriptId) !== asset.script_id || seen.has(id)) fail('Incomplete or foreign card reference scan')
      seen.add(id)
      if (cardUses(board, urls)) storyboards.push({ storyboard_id: id, name: board.storyboardName ?? null })
    }
    if (seen.size === expectedTotal) return { characters: bindings, storyboards, complete: true }
    if (!data.rows.length || seen.size > expectedTotal) fail('Incomplete card reference scan')
  }
  return fail('Incomplete card reference scan: increase audioReferencePageLimit before deleting')
}
async function assetUrls(client: JubianClient, asset: AudioAsset): Promise<string[]> {
  if (asset.url !== null) {
    let url: URL
    try { url = new URL(asset.url) }
    catch (_error) { return fail('Audio parent URL is unreadable; complete inspection is required') }
    if (url.protocol !== 'https:' || !url.hostname || url.username || url.password || url.hash || asset.url.includes('\\')) {
      fail('Audio parent URL must be credential-free HTTPS; complete inspection is required')
    }
  }
  const materials = await listAudioAssetMaterialUrls(client, asset.script_id, asset.asset_id)
  const urls = [...new Set([...materials.urls, ...(asset.url === null ? [] : [asset.url])])].sort()
  if (!urls.length) fail('Audio asset has no readable media URLs; reference inspection cannot establish absence')
  return urls
}

/**
 * Require the model to review the exact audio-library deletion preview.
 * @param value - Arguments observed by the tool hook and deletion executor.
 * @returns A correction for an unreviewed apply, or undefined for other calls.
 */
export function audioDeletionInspectionReason(value: unknown): string | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const args = row(value)
  if (args.method !== 'audio_delete_apply') return undefined
  if (typeof args.preview_path !== 'string' || !Number.isSafeInteger(args.checked_audio_asset_id)) {
    return '删除音频检查：先 audio_delete_preview，核对项目、资产 ID、名称、音频地址与角色及分镜引用；'
      + '确认是用户要求删除的素材，再传 checked_audio_asset_id 和原预览 fingerprint。'
  }
  return undefined
}

/**
 * Inspect or delete one unused audio asset; ambiguous responses are reconciled without another DELETE.
 * @param client - Provider transport for audio assets and project card references.
 * @param ledger - Durable identity of the exact removal request.
 * @param args - Bound project, reviewed asset identity and deletion authorization.
 * @param limits - Resolved complete-reference scan bounds.
 * @returns Inspection details or independently reported request and deletion readback outcomes.
 */
export async function audioAssetDeleteMethod(client: JubianClient, ledger: JubianLedger,
  args: AudioAssetDeleteArgs, limits: AudioReferenceScanOptions): Promise<Row> {
  const inspectionReason = audioDeletionInspectionReason(args)
  if (inspectionReason) invalid(inspectionReason)
  const scriptId = positiveInteger(need(args.script_id, 'script_id'))
  const assetId = positiveInteger(need(args.asset_id, 'asset_id'))
  const binding = await validateProjectBinding(need(args.project_dir, 'project_dir'), scriptId)
  if (args.method === 'audio_delete_preview') {
    const asset = await getAudioAsset(client, scriptId, assetId)
    if (asset === null) invalid('Audio asset is absent; choose an existing audio asset')
    const urls = await assetUrls(client, asset)
    const unsigned: Omit<Plan, 'fingerprint'> = { version: 1, operation: 'audio_asset_delete', script_id: scriptId,
      asset, asset_urls: urls, references: await inspectReferences(client, binding.project_root, asset, urls, limits),
      delete_reason: requiredText(args.delete_reason, 'delete_reason'),
      authorization_basis: requiredText(args.authorization_basis, 'authorization_basis') }
    const plan: Plan = { ...unsigned, fingerprint: stableSha256(unsigned) }
    const path = join(binding.project_root, 'video_tasks', `${plan.fingerprint}.audio-asset-delete.prepared.json`)
    await atomicWriteJson(path, plan)
    return { ...plan, preview_path: path, paid_requests: 0, status: 'inspection_required',
      next: '核对是否为用户授权删除的音频。仍有角色或分镜引用时，先替换或移除引用，再重新 preview；删除不可恢复。' }
  }
  if (args.method !== 'audio_delete_apply') invalid('Unknown audio deletion method')
  const key = requireKey(args.idempotency_key)
  const raw = row(await readPreparedJson(binding.project_root, key, need(args.preview_path, 'preview_path'), 'audio-asset-delete'))
  const { fingerprint, ...unsigned } = raw
  if (raw.version !== 1 || raw.operation !== 'audio_asset_delete' || raw.script_id !== scriptId
    || row(raw.asset).asset_id !== assetId || fingerprint !== key || stableSha256(unsigned) !== key) {
    fail('Audio deletion preview fingerprint/project/asset mismatch')
  }
  if (positiveInteger(args.checked_audio_asset_id) !== assetId) invalid('删除检查：checked_audio_asset_id must match the inspected audio asset')
  const request = { script_id: scriptId, asset_id: assetId, fingerprint: key }
  const prior = await ledger.find(key)
  let replayed = prior !== undefined
  let responseStatus = prior?.outcome ?? 'unknown'
  if (prior !== undefined) {
    if (prior.method !== 'asset_remove' || prior.script_id !== scriptId || prior.request_sha256 !== bodyHash(request)) {
      fail('Audio deletion key belongs to another operation')
    }
  }
  const perform = async (): Promise<Row> => {
    if (prior === undefined) {
      const asset = await getAudioAsset(client, scriptId, assetId)
      if (asset === null || stableSha256(asset) !== stableSha256(raw.asset)) fail('Stale audio deletion preview: asset changed')
      const urls = await assetUrls(client, asset)
      if (stableSha256(urls) !== stableSha256(raw.asset_urls)) fail('Stale audio deletion preview: media versions changed')
      const references = await inspectReferences(client, binding.project_root, asset, urls, limits)
      if (references.characters.length || references.storyboards.length) invalid('音频仍被角色或分镜引用；先替换或移除 reference，再重新预览')
      if (stableSha256(references) !== stableSha256(raw.references)) fail('Stale audio deletion preview: references changed')
      const send = { started: false }
      try {
        const result = await writeUnderLedger(ledger, key, 'asset_remove', () => request,
          () => {
            send.started = true
            return client.request({ method: 'DELETE', path: `/aigc/asset/removeAsset/${assetId}?scriptId=${scriptId}&isParent=1` })
          },
          undefined, { scriptId, verifyReplayBody: true })
        responseStatus = result.outcome
        replayed = result.replayed
      } catch (error) {
        if (!send.started) throw error
        responseStatus = 'unknown'
      }
    }
    let status = 'unknown', verifiedReadback = false
    try {
      status = await getAudioAsset(client, scriptId, assetId) === null ? 'deleted' : 'still_present'
      verifiedReadback = status === 'deleted'
    } catch (_error) {
      status = 'unknown'
    }
    return { status, asset_id: assetId, replayed, response_status: responseStatus,
      verified_readback: verifiedReadback, paid_requests: 0,
      next: '以回读结果为准。unknown 保留原 key 对账，不换 key 重删；删除资产不取消生成任务或退费，也不重建历史视频。' }
  }
  return prior === undefined ? withAudioDeletionLock(binding.project_root, scriptId, perform) : perform()
}
