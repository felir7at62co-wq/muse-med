/** Decodable project/character/period metadata stored in remote voice asset names. */
import { Buffer } from 'node:buffer'

/** Explicit voice identity; metadata alone does not verify the sample's speaker or quality. */
export interface VoiceSlotIdentity {
  /** Stable character identity shared by collaborators on this remote project. */
  character_id: string
  /** Explicit life period, independent of costume or emotion. */
  voice_period_id: string
  /** Canonical reserved suffix retaining the exact project and identity tuple. */
  voice_slot_tag: string
}

/**
 * Encode an explicit project, character and life period into a reserved remote asset-name suffix.
 * @param scriptId - Positive remote project ID.
 * @param characterId - Nonempty stable character ID.
 * @param periodId - Nonempty life-period ID.
 * @returns A versioned base64url JSON tuple suffix.
 */
export function encodeVoiceSlot(scriptId: number, characterId: string, periodId: string): string {
  return `⟦muse-voice:v1:${Buffer.from(JSON.stringify([scriptId, characterId, periodId]), 'utf8').toString('base64url')}⟧`
}

/**
 * Decode only canonical voice metadata belonging to the requested project.
 * @param name - Remote human-readable asset name, possibly with a reserved suffix.
 * @param scriptId - Project the remote asset reader independently verified.
 * @returns Exact character/period metadata, or undefined for legacy, malformed or foreign tags.
 */
export function readVoiceSlot(name: string | null, scriptId: number): VoiceSlotIdentity | undefined {
  const encoded = name?.match(/⟦muse-voice:v1:([A-Za-z0-9_-]+)⟧$/)?.[1]
  if (encoded === undefined) return undefined
  let decoded: unknown
  try { decoded = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) }
  catch (_error) { return undefined }
  if (!Array.isArray(decoded) || decoded.length !== 3) return undefined
  const entries: unknown[] = decoded
  const [project, character, period] = entries
  if (typeof project !== 'number' || !Number.isSafeInteger(project) || project < 1 || project !== scriptId
    || typeof character !== 'string' || !character.trim() || typeof period !== 'string' || !period.trim()) return undefined
  const tag = encodeVoiceSlot(project, character, period)
  if (!name?.endsWith(tag)) return undefined
  return { character_id: character, voice_period_id: period, voice_slot_tag: tag }
}
