/** Audio-library registration reconciles exact names and URLs through a complete inventory. */
import { JubianError } from '@deepseek-ai/dsh-jubian'
import type { JubianClient, JubianLedger } from '@deepseek-ai/dsh-jubian'
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

/**
 * Register one uploaded voice and identify it by exact name, URL and project readback.
 * A claimed key only reconciles; changed requests cannot reuse that key.
 * @param client - Provider asset transport.
 * @param ledger - Durable registration claims.
 * @param args - Explicit project, voice version name, uploaded HTTPS URL and stable key.
 * @param limits - Resolved bounds for the complete before/after inventories.
 * @returns Registration outcome, uniquely matched identity and actual inventory evidence.
 */
export async function registerAudioAsset(client: JubianClient, ledger: JubianLedger, args: {
  script_id: number
  asset_name: string
  asset_url: string
  idempotency_key: string | undefined
}, limits: AudioReferenceScanOptions): Promise<Record<string, unknown>> {
  const key = requireKey(args.idempotency_key)
  let url: URL
  try { url = new URL(args.asset_url) } catch (_error) { throw new JubianError('INVALID_ARGUMENT', 'asset_url must be an uploaded HTTPS audio URL') }
  if (url.protocol !== 'https:' || url.username || url.password || url.hash || !args.asset_name.trim()) {
    throw new JubianError('INVALID_ARGUMENT', 'asset_name and an uploaded HTTPS audio URL are required')
  }
  const body = { scriptId: args.script_id, assetName: args.asset_name, assetType: 4, isLocal: 1, url: args.asset_url }
  const prior = await ledger.find(key)
  if (prior !== undefined && (prior.method !== 'asset_register' || prior.script_id !== args.script_id
    || prior.request_sha256 !== bodyHash(body))) {
    throw new JubianError('CONTRACT_CHANGED', 'Idempotency key belongs to a different audio registration request')
  }
  const before = prior === undefined ? await inventory(client, args.script_id, limits) : []
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
  const matched = after.filter(asset => asset.name === args.asset_name && asset.url === args.asset_url)
  const created = replayed ? matched : matched.filter(asset => !before.some(old => old.asset_id === asset.asset_id))
  return { replayed, outcome: responseStatus, verified_readback: created.length === 1,
    created_asset_id: created.length === 1 ? (created[0] as AudioAsset).asset_id : null,
    new_asset_ids: replayed ? [] : created.map(asset => asset.asset_id),
    matching_assets: matched, paid_requests: 0,
    next: created.length === 1
      ? '音频资产已回读核对名称、项目、类别与 URL。试听认可后保存角色声线，再用原卡 audio_preview/audio_apply 绑定；没有生成音频或视频。'
      : '无法唯一确定本次音频资产；沿用原 key，用 audio_list/audio_get 核对实际名称与 URL，不猜 ID、不重新登记。' }
}
