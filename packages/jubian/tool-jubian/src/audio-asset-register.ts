/** Audio-library registration reconciles exact requests and shared voice slots through complete inventories. */
import { JubianError } from '@deepseek-ai/dsh-jubian'
import type { JubianClient, JubianLedger } from '@deepseek-ai/dsh-jubian'
import { encodeVoiceSlot } from './voice-slot.ts'
import { getAudioAsset, listAudioAssets } from './audio-asset-read.ts'
import type { AudioAsset } from './audio-asset-read.ts'
import type { AudioReferenceScanOptions } from './audio-asset-delete.ts'
import { bodyHash, need, requireKey, writeUnderLedger } from './write.ts'
import { VoiceCoordinationUnavailableError } from './voice-coordination.ts'
import type { VoiceCoordinator, VoiceCoordinationState, VoiceCoordinationUnavailableCode } from './voice-coordination.ts'
import type { MuseVoiceSlotRequest } from '@deepseek-ai/dsh-muse-account'

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
  return assets.filter(asset => asset.voice_slot_tag === slot && asset.liveness !== 'deleted').sort((left, right) => left.asset_id - right.asset_id)[0]
}
async function sharedResult(client: JubianClient, assets: AudioAsset[], slot: string, createdId: number | null,
  preferred?: AudioAsset): Promise<Record<string, unknown>> {
  const candidate = preferred ?? canonicalVoice(assets, slot)
  const removed = assets.filter(asset => asset.voice_slot_tag === slot && asset.liveness === 'deleted')
    .sort((left, right) => left.asset_id - right.asset_id)[0]
  if (candidate === undefined && removed !== undefined) throw new VoiceReferencePending('asset-deleted', removed.asset_id)
  if (candidate !== undefined && assets.some(asset => asset.asset_id === candidate.asset_id && asset.liveness === 'deleted')) {
    throw new VoiceReferencePending('asset-deleted', candidate.asset_id)
  }
  const canonical = candidate === undefined ? undefined : await verifyExistingAsset(client, candidate)
  const duplicates = assets.filter(asset => asset.voice_slot_tag === slot && asset.asset_id !== canonical?.asset_id)
    .sort((left, right) => left.asset_id - right.asset_id)
  return { voice_slot_tag: slot, canonical_voice_asset_id: canonical?.asset_id ?? null,
    canonical_voice_asset: canonical ?? null, registration_created_asset_id: createdId,
    reuse_current: canonical !== undefined && canonical.asset_id !== createdId, duplicate_assets: duplicates,
    shared_slot_verified: canonical !== undefined, speaker_verified: false, atomic_registration: false,
    next: canonical === undefined
      ? '尚未读到该角色、时期的共享音频条目；沿用原 key 对账，不重新登记。'
      : '已对照到同角色、同人生时期的当前复用候选；必须 audio_get 回读、试听核对说话人和时期。'
        + '若别人的资产成为当前条目，将本地候选归档。重复远端条目只列出，不自动删除。'
        + 'exclusive_registration=true 表示共享协调已确认该声线；新客户端首次登记受协调保护，供应商接口与旧客户端仍非原子登记。' }
}

async function verifyExistingAsset(client: JubianClient,
  expected: Pick<AudioAsset, 'script_id' | 'asset_id' | 'name' | 'url' | 'voice_slot_tag' | 'character_id' | 'voice_period_id' | 'liveness'>): Promise<AudioAsset> {
  if (expected.liveness === 'deleted') throw new VoiceReferencePending('asset-deleted', expected.asset_id)
  const actual = await getAudioAsset(client, expected.script_id, expected.asset_id)
  if (actual === null) throw new VoiceReferencePending('asset-missing', expected.asset_id)
  if (actual.name !== expected.name || actual.url !== expected.url
    || actual.voice_slot_tag !== expected.voice_slot_tag || actual.character_id !== expected.character_id
    || actual.voice_period_id !== expected.voice_period_id) {
    throw new VoiceReferencePending('asset-identity-changed', expected.asset_id)
  }
  if (actual.liveness !== 'active') {
    throw new VoiceReferencePending(actual.liveness === 'deleted' ? 'asset-deleted' : 'asset-liveness-unknown', expected.asset_id)
  }
  let url: URL
  try { url = new URL(actual.url ?? '') } catch (_error) {
    throw new JubianError('CONTRACT_CHANGED', 'Voice registration readback has no readable HTTPS audio URL; do not replace it automatically')
  }
  if (url.protocol !== 'https:' || !url.hostname || url.username || url.password || url.hash || actual.url?.includes('\\')) {
    throw new JubianError('CONTRACT_CHANGED', 'Voice registration readback URL is not credential-free HTTPS')
  }
  return actual
}
async function verifiedReady(client: JubianClient, state: VoiceCoordinationState): Promise<AudioAsset> {
  return await verifyExistingAsset(client, need(state.asset))
}

const PENDING_REASONS: Record<VoiceCoordinationUnavailableCode | 'busy' | 'unconfirmed', string> = {
  'sign-in-required': '当前 Muse 未登录或登录已过期；后续需要复用共享声线时再恢复登录。',
  'account-changed': '执行期间 Muse 账号发生变化；在当前账号回读原操作与共享音频，不重新登记。',
  'not-configured': '当前运行环境尚未提供共享声线登记服务；没有降级为无协调登记。',
  network: '共享登记网络请求暂未确认；只查询原操作或已有共享音频，不补发登记。',
  unavailable: '共享登记暂不可用；保留候选，后续只核对原操作。',
  busy: '其他成员正在登记该角色、该人生时期的声线；回读已有音频，等待其结果，不竞争登记。',
  unconfirmed: '共享登记尚未给出可提交许可；保留原操作与候选。',
}
function coordinationPending(status: 'coordination_unavailable' | 'coordination_busy' | 'coordination_pending', key: string,
  reason: keyof typeof PENDING_REASONS, state?: VoiceCoordinationState): Record<string, unknown> {
  return { replayed: false, outcome: 'not_submitted', status, verified_readback: false,
    created_asset_id: null, new_asset_ids: [], matching_assets: [], paid_requests: 0,
    coordination_state: state?.state ?? 'unavailable', reason_code: reason, original_idempotency_key: key,
    work_can_continue: true, failure_scope: 'voice_registration', submission_attempted: false, retry_registration: false,
    blocking_state: state?.blocking_state ?? null, exclusive_registration: false,
    next: PENDING_REASONS[reason] + '仅本次声线登记待处理。停止重复登记、不换 key，保留本地候选和原 idempotency_key；'
      + '继续无此参考音频的已授权初始视频或其他独立工作，不把此等待当成整集制作门禁。' }
}

type VoiceReferencePendingReason = 'asset-missing' | 'asset-deleted' | 'asset-liveness-unknown' | 'asset-identity-changed'
class VoiceReferencePending extends Error {
  constructor(readonly reason: VoiceReferencePendingReason, readonly assetId: number) { super('Voice reference requires read-only reconciliation') }
}
interface RegistrationArgs {
  script_id: number
  asset_name: string
  asset_url: string
  idempotency_key: string | undefined
  character_id?: string
  voice_period_id?: string
}
interface RegistrationAttempt { submitted: boolean; replayed: boolean; createdId: number | null; outcome: 'not_submitted' | 'accepted' | 'unknown' }
function referencePending(error: VoiceReferencePending, key: string, attempt: RegistrationAttempt): Record<string, unknown> {
  return { status: 'voice_reference_pending', outcome: attempt.outcome, reason_code: error.reason, verified_readback: false,
    canonical_voice_asset_id: null, canonical_voice_asset: null, shared_slot_verified: false, reuse_current: false,
    registration_created_asset_id: attempt.createdId, created_asset_id: attempt.createdId,
    replayed: attempt.replayed, submission_attempted: attempt.submitted, retry_registration: false,
    pending_asset_id: error.assetId, original_idempotency_key: key, paid_requests: 0,
    work_can_continue: true, failure_scope: 'voice_registration',
    next: '这次声线资产还不能确认为当前可用参考。保留本地候选和原 idempotency_key，按精确 audio_get 核对缺失、删除、状态或身份变化；'
      + '不复用、不归档候选、不自动补发登记、不换 key。继续不依赖此声线的其他独立已授权工作。' }
}

/**
 * Register one uploaded voice and identify it by exact name, URL and project readback.
 * Optional character_id and voice_period_id together add a reserved, project-scoped voice-slot
 * suffix. A complete inventory excludes deleted rows; the lowest remaining slot candidate must
 * independently GET back with unchanged identity, URL and explicit active deletion evidence before
 * reuse. A slot with missing, deleted, ambiguous or changed evidence does not authorize replacement.
 * Shared post-send and coordination-ready results perform the same exact active readback;
 * after POST it reports the lowest slot ID and duplicates separately from the submitted URL's
 * uniquely identified addition. New shared-slot POSTs require a durable server start permission;
 * a submitted or ambiguous operation only reconciles. Legacy clients can still create duplicates,
 * and none are deleted automatically. Slot metadata is not evidence of sound quality. Missing,
 * deleted, uncertain or changed same-project voice references return a scoped pending result;
 * they cannot be adopted or trigger automatic replacement, and independent work may continue.
 * A claimed key only reconciles; changed requests cannot reuse that key.
 * @param client - Provider asset transport.
 * @param ledger - Durable registration claims.
 * @param args - Explicit project, voice name, uploaded HTTPS URL, stable key and optional shared voice identity.
 * @param limits - Resolved bounds for the complete before/after inventories.
 * @param coordinator - Current Muse account's shared registration provider; required only for a new slot POST.
 * @returns Registration outcome, submitted request identity, current slot candidate and actual inventory evidence.
 */
export async function registerAudioAsset(client: JubianClient, ledger: JubianLedger, args: RegistrationArgs,
  limits: AudioReferenceScanOptions, coordinator?: VoiceCoordinator): Promise<Record<string, unknown>> {
  const attempt: RegistrationAttempt = { submitted: false, replayed: false, createdId: null, outcome: 'not_submitted' }
  try { return await registerAudioAssetAttempt(client, ledger, args, limits, coordinator, attempt) }
  catch (error) {
    if (error instanceof VoiceReferencePending) return referencePending(error, requireKey(args.idempotency_key), attempt)
    throw error
  }
}
async function registerAudioAssetAttempt(client: JubianClient, ledger: JubianLedger, args: RegistrationArgs,
  limits: AudioReferenceScanOptions, coordinator: VoiceCoordinator | undefined,
  attempt: RegistrationAttempt): Promise<Record<string, unknown>> {
  const key = requireKey(args.idempotency_key)
  let url: URL
  try { url = new URL(args.asset_url) } catch (_error) { throw new JubianError('INVALID_ARGUMENT', 'asset_url must be an uploaded HTTPS audio URL') }
  if (url.protocol !== 'https:' || url.username || url.password || url.hash || !args.asset_name.trim()) {
    throw new JubianError('INVALID_ARGUMENT', 'asset_name and an uploaded HTTPS audio URL are required')
  }
  const slot = voiceSlot(args)
  const name = slot === undefined ? args.asset_name : `${args.asset_name} ${slot}`
  const body = { scriptId: args.script_id, assetName: name, assetType: 4, isLocal: 1, url: args.asset_url }
  let prior = await ledger.find(key)
  if (prior !== undefined && (prior.method !== 'asset_register' || prior.script_id !== args.script_id
    || prior.request_sha256 !== bodyHash(body))) {
    throw new JubianError('CONTRACT_CHANGED', 'Idempotency key belongs to a different audio registration request')
  }
  const before = prior === undefined ? await inventory(client, args.script_id, limits) : []
  if (prior === undefined) {
    prior = await ledger.find(key)
    if (prior !== undefined && (prior.method !== 'asset_register' || prior.script_id !== args.script_id
      || prior.request_sha256 !== bodyHash(body))) {
      throw new JubianError('CONTRACT_CHANGED', 'Idempotency key belongs to a different audio registration request')
    }
  }
  if (prior?.outcome === 'not_sent') {
    throw new JubianError('CONTRACT_CHANGED', 'Audio registration cannot use an image-generation pre-dispatch recovery state')
  }
  attempt.replayed = prior !== undefined
  attempt.outcome = prior === undefined ? 'not_submitted' : prior.outcome ?? 'unknown'
  if (prior === undefined && slot !== undefined && before.some(asset => asset.voice_slot_tag === slot)
    && await ledger.find(key) === undefined) {
    return { replayed: false, outcome: 'not_submitted', status: 'reuse_current', verified_readback: true,
      created_asset_id: null, new_asset_ids: [], matching_assets: [], paid_requests: 0,
      ...await sharedResult(client, before, slot, null) }
  }
  const scope: MuseVoiceSlotRequest | undefined = slot === undefined ? undefined : {
    action: prior === undefined ? 'acquire' : 'read', script_id: args.script_id,
    character_id: need(args.character_id), voice_period_id: need(args.voice_period_id), operation_key: key }
  let coordination: VoiceCoordinationState | undefined
  let ready: AudioAsset | undefined
  if (scope !== undefined) {
    if (coordinator === undefined && prior === undefined) return coordinationPending('coordination_unavailable', key, 'not-configured')
    if (coordinator !== undefined) {
      try { coordination = await coordinator.request(scope) }
      catch (error) {
        if (error instanceof JubianError && error.code === 'CONTRACT_CHANGED') throw error
        if (prior === undefined) return coordinationPending('coordination_unavailable', key,
          error instanceof VoiceCoordinationUnavailableError ? error.code : 'unavailable')
      }
    }
    if (coordination?.state === 'ready') {
      ready = await verifiedReady(client, coordination)
      if (prior === undefined) return { replayed: false, outcome: 'not_submitted', status: 'reuse_current',
        verified_readback: true, created_asset_id: null, new_asset_ids: [], matching_assets: [], paid_requests: 0,
        coordination_state: 'ready', exclusive_registration: true, ...await sharedResult(client, before, slot as string, null, ready) }
    }
    if (prior === undefined && coordination?.state === 'busy') return coordinationPending('coordination_busy', key, 'busy', coordination)
    if (prior === undefined && coordination?.state !== 'reserved' && coordination?.state !== 'submitted') {
      return coordinationPending('coordination_pending', key, 'unconfirmed', coordination)
    }
  }
  let responseStatus = prior?.outcome ?? 'unknown'
  let replayed = prior !== undefined
  if (prior === undefined && (scope === undefined || coordination?.state === 'reserved')) {
    const send = { started: false }
    try {
      const result = await writeUnderLedger(ledger, key, 'asset_register', () => body, async (payload) => {
        if (scope !== undefined) {
          const lease = need(coordination?.lease_id)
          const started = await need(coordinator).request({ ...scope, action: 'start', lease_id: lease })
          if (started.state !== 'submitted' || started.owner_operation !== true || started.lease_id !== lease || started.started_now !== true) {
            throw new JubianError('CONTRACT_CHANGED', 'Shared voice registration start was already used or the lease changed; reconcile only')
          }
          coordination = started
        }
        send.started = true
        attempt.submitted = true
        attempt.outcome = 'unknown'
        return await client.request({ method: 'POST', path: '/aigc/asset', body: need(payload) })
      }, undefined, { scriptId: args.script_id, verifyReplayBody: true })
      responseStatus = result.outcome
      replayed = result.replayed
      attempt.replayed = replayed
      attempt.outcome = result.outcome
      if (result.replayed && scope !== undefined) {
        try { await need(coordinator).request({ ...scope, action: 'abandon', lease_id: need(coordination?.lease_id) }) }
        catch (_error) { /* An unsubmitted reservation may expire; a claimed original key still cannot send. */ }
      }
    } catch (error) {
      if (!send.started) {
        if (scope !== undefined && !(error instanceof JubianError && error.code === 'CONTRACT_CHANGED')) {
          return coordinationPending('coordination_unavailable', key,
            error instanceof VoiceCoordinationUnavailableError ? error.code : 'unavailable')
        }
        throw error
      }
    }
  }
  const after = await inventory(client, args.script_id, limits)
  const matched = after.filter(asset => asset.name === name && asset.url === args.asset_url)
  const created = replayed ? matched : matched.filter(asset => !before.some(old => old.asset_id === asset.asset_id))
  const createdAsset = created.length === 1 ? created[0] : undefined
  const createdId = createdAsset?.asset_id ?? null
  attempt.createdId = createdId
  if (createdAsset !== undefined && scope !== undefined && coordinator !== undefined && coordination?.state === 'submitted'
    && coordination.owner_operation === true && coordination.lease_id !== undefined) {
    try {
      await verifyExistingAsset(client, createdAsset)
      coordination = await coordinator.request({ ...scope, action: 'complete', lease_id: coordination.lease_id, asset_id: createdAsset.asset_id })
      if (coordination.state !== 'ready') throw new JubianError('CONTRACT_CHANGED', 'Shared voice completion is not ready')
      ready = await verifiedReady(client, coordination)
    } catch (error) {
      if (error instanceof JubianError && error.code === 'CONTRACT_CHANGED') throw error
      // Remote registration may be complete; retain its original operation for read-only reconciliation.
    }
  }
  return { replayed, outcome: responseStatus, verified_readback: created.length === 1,
    created_asset_id: createdId, new_asset_ids: replayed ? [] : created.map(asset => asset.asset_id),
    matching_assets: matched, paid_requests: 0,
    next: created.length === 1
      ? '音频资产已回读核对名称、项目、类别与 URL。试听认可后保存角色声线，再用原卡 audio_preview/audio_apply 绑定；没有生成音频或视频。'
      : '无法唯一确定本次音频资产；沿用原 key，用 audio_list/audio_get 核对实际名称与 URL，不猜 ID、不重新登记。',
    ...(slot === undefined ? {} : { ...await sharedResult(client, after, slot, createdId, ready),
      coordination_state: coordination?.state ?? 'unavailable', exclusive_registration: coordination?.state === 'ready' }) }
}
