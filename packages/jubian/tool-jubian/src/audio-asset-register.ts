/** Audio-library registration reconciles exact requests and shared voice slots through complete inventories. */
import { JubianError } from '@deepseek-ai/dsh-jubian'
import type { JubianClient, JubianLedger } from '@deepseek-ai/dsh-jubian'
import { encodeVoiceSlot } from './voice-slot.ts'
import { listAudioAssets } from './audio-asset-read.ts'
import type { AudioAsset } from './audio-asset-read.ts'
import type { AudioReferenceScanOptions } from './audio-asset-delete.ts'
import { bodyHash, need, requireKey, writeUnderLedger } from './write.ts'

async function inventory(client: JubianClient, scriptId: number, limits: AudioReferenceScanOptions): Promise<AudioAsset[]> {
  const assets: AudioAsset[] = []
  const seen = new Set<number>()
  let total: number | undefined
  for (let page = 1; page <= limits.pageLimit; page++) {
    const result = await listAudioAssets(client, { script_id: scriptId, page_num: page, page_size: limits.pageSize })
    total ??= result.total
    if (total !== result.total || result.assets.some(asset => seen.has(asset.asset_id))) {
      throw new JubianError('CONTRACT_CHANGED', 'Audio registration inventory changed during pagination')
    }
    for (const asset of result.assets) { assets.push(asset); seen.add(asset.asset_id) }
    if (seen.size === total) return assets
    if (!result.returned) break
  }
  throw new JubianError('CONTRACT_CHANGED', 'Incomplete audio registration inventory; no identity can be claimed')
}

const SLOT_TAG = '⟦muse-voice:'
function voiceSlot(args: { script_id: number; asset_name: string; character_id?: string; voice_period_id?: string }): string | undefined {
  if (args.asset_name.includes(SLOT_TAG)) throw new JubianError('INVALID_ARGUMENT', 'asset_name cannot supply a reserved Muse voice slot tag')
  if (args.character_id === undefined && args.voice_period_id === undefined) return undefined
  if (typeof args.character_id !== 'string' || !args.character_id.trim()
    || typeof args.voice_period_id !== 'string' || !args.voice_period_id.trim()) {
    throw new JubianError('INVALID_ARGUMENT', 'Shared voice registration requires nonempty character_id and voice_period_id together')
  }
  return encodeVoiceSlot(args.script_id, args.character_id, args.voice_period_id)
}
function canonicalVoice(assets: AudioAsset[], slot: string): AudioAsset | undefined {
  return assets.filter(asset => asset.voice_slot_tag === slot).sort((left, right) => left.asset_id - right.asset_id)[0]
}
function sharedResult(assets: AudioAsset[], slot: string, createdId: number | null): Record<string, unknown> {
  const canonical = canonicalVoice(assets, slot)
  if (canonical !== undefined) {
    let url: URL
    try { url = new URL(canonical.url ?? '') } catch (_error) {
      throw new JubianError('CONTRACT_CHANGED', 'The shared voice slot has no readable audio URL; do not register a replacement automatically')
    }
    if (url.protocol !== 'https:' || !url.hostname || url.username || url.password || url.hash || canonical.url?.includes('\\')) {
      throw new JubianError('CONTRACT_CHANGED', 'The shared voice slot URL is not credential-free HTTPS')
    }
  }
  const duplicates = assets.filter(asset => asset.voice_slot_tag === slot && asset.asset_id !== canonical?.asset_id)
    .sort((left, right) => left.asset_id - right.asset_id)
  return { voice_slot_tag: slot, canonical_voice_asset_id: canonical?.asset_id ?? null,
    canonical_voice_asset: canonical ?? null, registration_created_asset_id: createdId,
    reuse_current: canonical !== undefined && canonical.asset_id !== createdId, duplicate_assets: duplicates,
    shared_slot_verified: canonical !== undefined, speaker_verified: false, atomic_registration: false,
    next: canonical === undefined
      ? '尚未读到该角色、时期的共享音频条目；沿用原 key 对账，不重新登记。'
      : '完整音频库已对照到同角色、同人生时期条目，最低资产 ID 为当前复用候选；必须 audio_get 回读、试听核对说话人和时期。'
        + '若别人的资产成为当前条目，将本地候选归档。重复远端条目只列出，不自动删除；登记不是跨电脑原子操作。' }
}

/**
 * Register one uploaded voice and identify it by exact name, URL and project readback.
 * Optional character_id and voice_period_id together add a reserved, project-scoped voice-slot
 * suffix. A complete inventory reuses the lowest existing asset ID in that slot before POST;
 * after POST it reports the lowest slot ID and duplicates separately from the submitted URL's
 * uniquely identified addition. Independent clients can race and create duplicates; none are
 * deleted automatically. Slot metadata identifies an intended speaker/period, not sound quality.
 * A claimed key only reconciles; changed requests cannot reuse that key.
 * @param client - Provider asset transport.
 * @param ledger - Durable registration claims.
 * @param args - Explicit project, voice name, uploaded HTTPS URL, stable key and optional shared voice identity.
 * @param limits - Resolved bounds for the complete before/after inventories.
 * @returns Registration outcome, submitted request identity, current slot candidate and actual inventory evidence.
 */
export async function registerAudioAsset(client: JubianClient, ledger: JubianLedger, args: {
  script_id: number
  asset_name: string
  asset_url: string
  idempotency_key: string | undefined
  character_id?: string
  voice_period_id?: string
}, limits: AudioReferenceScanOptions): Promise<Record<string, unknown>> {
  const key = requireKey(args.idempotency_key)
  let url: URL
  try { url = new URL(args.asset_url) } catch (_error) { throw new JubianError('INVALID_ARGUMENT', 'asset_url must be an uploaded HTTPS audio URL') }
  if (url.protocol !== 'https:' || url.username || url.password || url.hash || !args.asset_name.trim()) {
    throw new JubianError('INVALID_ARGUMENT', 'asset_name and an uploaded HTTPS audio URL are required')
  }
  const slot = voiceSlot(args)
  const name = slot === undefined ? args.asset_name : `${args.asset_name} ${slot}`
  const body = { scriptId: args.script_id, assetName: name, assetType: 4, isLocal: 1, url: args.asset_url }
  const prior = await ledger.find(key)
  if (prior !== undefined && (prior.method !== 'asset_register' || prior.script_id !== args.script_id
    || prior.request_sha256 !== bodyHash(body))) {
    throw new JubianError('CONTRACT_CHANGED', 'Idempotency key belongs to a different audio registration request')
  }
  const before = prior === undefined ? await inventory(client, args.script_id, limits) : []
  if (prior === undefined && slot !== undefined && canonicalVoice(before, slot) !== undefined && await ledger.find(key) === undefined) {
    return { replayed: false, outcome: 'not_submitted', status: 'reuse_current', verified_readback: true,
      created_asset_id: null, new_asset_ids: [], matching_assets: [], paid_requests: 0,
      ...sharedResult(before, slot, null) }
  }
  let responseStatus = prior?.outcome ?? 'unknown'
  let replayed = prior !== undefined
  if (prior === undefined) {
    const send = { started: false }
    try {
      const result = await writeUnderLedger(ledger, key, 'asset_register', () => body, (payload) => {
        send.started = true
        return client.request({ method: 'POST', path: '/aigc/asset', body: need(payload) })
      }, undefined, { scriptId: args.script_id, verifyReplayBody: true })
      responseStatus = result.outcome
      replayed = result.replayed
    } catch (error) {
      if (!send.started) throw error
    }
  }
  const after = await inventory(client, args.script_id, limits)
  const matched = after.filter(asset => asset.name === name && asset.url === args.asset_url)
  const created = replayed ? matched : matched.filter(asset => !before.some(old => old.asset_id === asset.asset_id))
  const createdId = created.length === 1 ? (created[0] as AudioAsset).asset_id : null
  return { replayed, outcome: responseStatus, verified_readback: created.length === 1,
    created_asset_id: createdId, new_asset_ids: replayed ? [] : created.map(asset => asset.asset_id),
    matching_assets: matched, paid_requests: 0,
    next: created.length === 1
      ? '音频资产已回读核对名称、项目、类别与 URL。试听认可后保存角色声线，再用原卡 audio_preview/audio_apply 绑定；没有生成音频或视频。'
      : '无法唯一确定本次音频资产；沿用原 key，用 audio_list/audio_get 核对实际名称与 URL，不猜 ID、不重新登记。',
    ...(slot === undefined ? {} : sharedResult(after, slot, createdId)) }
}
