/** Reconcile ambiguous free storyboard creation using the original ledger and a complete project listing. */
import type { JubianClient, JubianLedger } from '@deepseek-ai/dsh-jubian'
import { readStoryboard, stableSha256 } from '@deepseek-ai/dsh-jubian-api'
import { productionRows } from './project-inventory.ts'
import { bodyHash } from './write.ts'

type Readback =
  | { status: 'verified_matching_card'; storyboard_id: number }
  | { status: 'reconcile_required'; storyboard_id: null; reason: string }

type ReconcileCard = (key: string, body: Record<string, unknown>) => Promise<Readback>

function unresolved(reason: string): Readback {
  return { status: 'reconcile_required', storyboard_id: null, reason }
}

function modelConfig(value: unknown): Record<string, unknown> {
  const parsed: unknown = typeof value === 'string' ? JSON.parse(value) : value
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Missing saved card configuration')
  return parsed as Record<string, unknown>
}

/**
 * Create one readback pass shared across the unresolved items of an already-finished batch.
 * @param client - Authenticated provider transport.
 * @param ledger - Original free-write ledger.
 * @param scriptId - Exact validated project.
 * @param limits - The deployment bounds for complete project inventory reads.
 * @param signal - Cancellation of provider reads.
 * @returns One read-only check for an item and the matching card ID when unique.
 */
export function storyboardCreateReadback(client: JubianClient, ledger: JubianLedger, scriptId: number,
  limits: { pageSize: number; pageLimit: number }, signal?: AbortSignal): ReconcileCard {
  let inventory: ReturnType<typeof productionRows> | undefined
  return async (key, body) => {
    try {
      signal?.throwIfAborted()
      const record = await ledger.find(key)
      if (record?.method !== 'storyboard_create' || record.script_id !== scriptId || record.request_sha256 !== bodyHash(body)) {
        return unresolved('original_intent_unverified')
      }
      const rows = await (inventory ??= productionRows(client, scriptId, 'storyboard', limits.pageSize, limits.pageLimit, signal))
      const namedCards = rows.filter(row => row.storyboardName === body.storyboardName)
      if (namedCards.some(card => card.episodeId === null || card.episodeId === undefined)) {
        return unresolved('matching_card_episode_unknown')
      }
      const candidates = namedCards.filter(row => Number(row.episodeId) === Number(body.episodeId))
      if (candidates.length !== 1) return unresolved(candidates.length === 0 ? 'matching_card_not_visible' : 'multiple_matching_cards')
      const id = Number(candidates[0]?.id)
      const detail = await client.request({ method: 'GET', path: `/aigc/storyboard/${id}`, ...(signal === undefined ? {} : { signal }) })
      const card = readStoryboard(detail.data, id)
      const saved = modelConfig(card.snapshot.modelConfig), original = modelConfig(body.modelConfig)
      if (card.script_id !== scriptId || Number(card.snapshot.episodeId) !== Number(body.episodeId)
        || card.name !== body.storyboardName || String(card.snapshot.sortOrder) !== String(body.sortOrder)
        || card.material_keys.length > 0
        || Object.entries(original).some(([field, value]) => !Object.hasOwn(saved, field)
          || stableSha256(saved[field]) !== stableSha256(value))) {
        return unresolved('card_details_differ')
      }
      return { status: 'verified_matching_card', storyboard_id: card.storyboard_id }
    } catch {
      return unresolved(signal?.aborted ? 'readback_cancelled' : 'readback_unavailable')
    }
  }
}
