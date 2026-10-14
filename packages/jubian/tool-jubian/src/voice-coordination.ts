/** Strict shared-slot responses and the Host-only Muse account adapter. */
import type { Context } from '@deepseek-ai/cordis'
import type { MuseVoiceLeaseId, MuseVoiceSlotRequest } from '@deepseek-ai/dsh-muse-account'
import { JubianError } from '@deepseek-ai/dsh-jubian'
import { encodeVoiceSlot } from './voice-slot.ts'

/** Ready registration metadata; clients still read the actual provider asset. */
export interface CoordinatedVoiceAsset {
  readonly asset_id: number
  readonly script_id: number
  readonly asset_type: 4
  readonly name: string
  readonly url: string
  readonly character_id: string
  readonly voice_period_id: string
  readonly voice_slot_tag: string
}

/** Server disposition for one exact project/person/period and original operation. */
export interface VoiceCoordinationState {
  readonly state: 'reserved' | 'submitted' | 'ready' | 'available' | 'busy'
  readonly script_id: number
  readonly character_id: string
  readonly voice_period_id: string
  readonly lease_id?: MuseVoiceLeaseId
  readonly owner_operation?: boolean
  readonly started_now?: boolean
  readonly blocking_state?: 'reserved' | 'submitted'
  readonly asset?: CoordinatedVoiceAsset
}

/** Exclusive registration coordination, implemented by the current Muse account provider. */
export interface VoiceCoordinator {
  /**
   * Send one original operation without retries; submitted states never authorize another POST.
   * @param request - Exact original operation and current slot identifiers.
   * @returns Validated server disposition without account or provider credentials.
   */
  request(request: MuseVoiceSlotRequest): Promise<VoiceCoordinationState>
}

/** Bounded local reasons that distinguish account, deployment and transport failures. */
export type VoiceCoordinationUnavailableCode = 'sign-in-required' | 'account-changed' | 'not-configured' | 'network' | 'unavailable'

/** A failed coordination request affects only voice registration, never the whole video workflow. */
export class VoiceCoordinationUnavailableError extends Error {
  /** @param code - Fixed local reason; upstream text is never included. */
  constructor(readonly code: VoiceCoordinationUnavailableCode) {
    super(`Shared voice coordination: ${code}`)
  }
}

function unavailableCode(error: unknown): VoiceCoordinationUnavailableCode {
  if (error instanceof Error && 'code' in error) {
    const code = error.code
    if (code === 'sign-in-required' || code === 'account-changed' || code === 'not-configured' || code === 'network') return code
  }
  return 'unavailable'
}

function invalid(): never { throw new JubianError('CONTRACT_CHANGED', 'Unreadable shared voice coordination response') }
function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) invalid()
  return value as Record<string, unknown>
}

/**
 * Validate a wire response against the exact requested project, character and period.
 * @param value - Parsed gateway JSON; arbitrary extra fields are never forwarded.
 * @param request - Original scope that the response must retain.
 * @returns Credential-free state with a strictly verified ready asset identity.
 */
export function readVoiceCoordination(value: unknown, request: MuseVoiceSlotRequest): VoiceCoordinationState {
  const source = record(value)
  const state = source.state
  if ((state !== 'reserved' && state !== 'submitted' && state !== 'ready' && state !== 'available' && state !== 'busy')
    || source.script_id !== request.script_id || source.character_id !== request.character_id
    || source.voice_period_id !== request.voice_period_id
    || (source.owner_operation !== undefined && typeof source.owner_operation !== 'boolean')
    || (source.started_now !== undefined && typeof source.started_now !== 'boolean')
    || (source.started_now === true && (state !== 'submitted' || source.owner_operation !== true))
    || (source.lease_id !== undefined && (typeof source.lease_id !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(source.lease_id)))) invalid()
  if (state === 'reserved' && (source.owner_operation !== true || typeof source.lease_id !== 'string')) invalid()
  if (state === 'busy' && (source.blocking_state !== 'reserved' && source.blocking_state !== 'submitted')) invalid()
  if (state === 'busy' && (source.lease_id !== undefined || source.owner_operation === true)) invalid()
  let asset: CoordinatedVoiceAsset | undefined
  if (state === 'ready') {
    const row = record(source.asset)
    const tag = encodeVoiceSlot(request.script_id, request.character_id, request.voice_period_id)
    if (typeof row.asset_id !== 'number' || !Number.isSafeInteger(row.asset_id) || row.asset_id < 1
      || row.script_id !== request.script_id || row.asset_type !== 4
      || row.character_id !== request.character_id || row.voice_period_id !== request.voice_period_id
      || row.voice_slot_tag !== tag || typeof row.name !== 'string' || !row.name.endsWith(tag)
      || typeof row.url !== 'string' || row.url.includes('\\')) invalid()
    let url: URL
    try { url = new URL(row.url) } catch (_error) { invalid() }
    if (url.protocol !== 'https:' || url.username || url.password || url.hash || !url.hostname) invalid()
    asset = { asset_id: row.asset_id, script_id: request.script_id, asset_type: 4, name: row.name, url: row.url,
      character_id: request.character_id, voice_period_id: request.voice_period_id, voice_slot_tag: tag }
  } else if (source.asset !== undefined) invalid()
  return { state, script_id: request.script_id, character_id: request.character_id, voice_period_id: request.voice_period_id,
    ...(typeof source.lease_id === 'string' ? { lease_id: source.lease_id as MuseVoiceLeaseId } : {}),
    ...(typeof source.owner_operation === 'boolean' ? { owner_operation: source.owner_operation } : {}),
    ...(typeof source.started_now === 'boolean' ? { started_now: source.started_now } : {}),
    ...(state === 'busy' ? { blocking_state: source.blocking_state as 'reserved' | 'submitted' } : {}),
    ...(asset === undefined ? {} : { asset }) }
}

/**
 * Resolve the current Host account for every request without exposing either credential.
 * @param ctx - Jubian tool context with an optional Muse account provider.
 * @param credential - Existing Jubian token resolver, including its workspace policy.
 * @returns Adapter that fails explicitly when account/server coordination is unavailable.
 */
export function museVoiceCoordinator(ctx: Context, credential: () => Promise<string>): VoiceCoordinator {
  return { async request(request) {
    const account = ctx.get('museAccount')
    if (account === undefined) throw new VoiceCoordinationUnavailableError('not-configured')
    let value: unknown
    try { value = await account.requestVoiceSlot(request, await credential()) }
    catch (error) { throw new VoiceCoordinationUnavailableError(unavailableCode(error)) }
    return readVoiceCoordination(value, request)
  } }
}
