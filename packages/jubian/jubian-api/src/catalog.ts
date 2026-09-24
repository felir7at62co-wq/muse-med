/**
 * Catalogue, screenplay and episode reads.
 *
 * These readers parse business fields, which the transport deliberately does
 * not. Each one takes an already-validated envelope `data` and either returns
 * the fields it promises or throws `CONTRACT_CHANGED`, so a field the provider
 * adds never breaks a caller.
 */
import { JubianError } from '@deepseek-ai/dsh-jubian'

function invalid(): never { throw new JubianError('CONTRACT_CHANGED') }

function rows(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) invalid()
  return value.map((row) => {
    if (!row || typeof row !== 'object' || Array.isArray(row)) invalid()
    return row as Record<string, unknown>
  })
}

function positiveInteger(value: unknown): number {
  const candidate = typeof value === 'string' && /^[1-9][0-9]*$/.test(value) ? Number(value) : value
  if (typeof candidate !== 'number' || !Number.isSafeInteger(candidate) || candidate < 1) invalid()
  return candidate
}

function optionalText(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null
}

/**
 * Read one of the provider's non-negative integers, which it spells as a number
 * on some rows and as its decimal string on others. A value it does not send, or
 * one that is not a whole non-negative number, reads as `null` rather than
 * failing the page: a field the provider omits never breaks a caller.
 */
function optionalCount(value: unknown): number | null {
  const candidate = typeof value === 'string' && /^(0|[1-9][0-9]*)$/.test(value) ? Number(value) : value
  return typeof candidate === 'number' && Number.isSafeInteger(candidate) && candidate >= 0 ? candidate : null
}

function optionalFlag(value: unknown): boolean | null {
  if (typeof value === 'boolean') return value
  return value === 1 || value === 0 ? value === 1 : null
}

/** Model catalogue selectors, as the provider's own `taskType` numbering. */
export const MODEL_TASK_TYPES = { video: 1, image: 2, subtitleErasure: 10 } as const

/**
 * Return the raw catalogue rows for one task type.
 * @param data - Envelope `data` from `/model/charge/getSelectList`.
 * @returns The rows, unchanged: every selector a caller needs is account state read from here.
 */
export function readModels(data: unknown): Record<string, unknown>[] {
  return rows(data)
}

/**
 * Read the identity fields of one remote screenplay.
 * @param data - Envelope `data` from `/aigc/script/{scriptId}`.
 * @returns The project identity, with the provider's `scriptName` projected as `name` and legacy `name` retained as fallback.
 */
export function readScript(data: unknown): { script_id: number; name: string | null; production_type: number | null } {
  if (!data || typeof data !== 'object' || Array.isArray(data)) invalid()
  const record = data as Record<string, unknown>
  const id = record.id ?? record.scriptId
  if (typeof id !== 'number' && typeof id !== 'string') invalid()
  return { script_id: positiveInteger(id), name: optionalText(record.scriptName) ?? optionalText(record.name),
    production_type: typeof record.productionType === 'number' ? record.productionType : null }
}

/**
 * Read one page of episodes.
 * @param data - Envelope `data` from `/aigc/episode/list`.
 * @returns The page total and its episode rows.
 */
export function readEpisodes(data: unknown): { total: number; rows: { episode_id: number; name: string | null }[] } {
  if (!data || typeof data !== 'object' || Array.isArray(data)) invalid()
  const record = data as Record<string, unknown>
  const list = record.rows
  if (!Array.isArray(list)) invalid()
  return { total: typeof record.total === 'number' && Number.isSafeInteger(record.total) ? record.total : list.length,
    rows: rows(list).map(item => ({ episode_id: positiveInteger(item.id ?? item.episodeId),
      name: optionalText(item.name) })) }
}

/** One screenplay row as `/aigc/script/list` and `/script/center/pool/list` return it. */
export interface ScriptRow {
  /** Provider identity of the screenplay, which every later call addresses it by. */
  script_id: number
  /** `scriptName`, the name the console lists the project under. */
  script_name: string | null
  /** `manuscriptName`, the name the screenplay manuscript itself carries. */
  manuscript_name: string | null
  /** Declared episode count, or null when the row carried no readable number. */
  episode_count: number | null
  /** `scriptStyle`, the provider's own production-style code, or null when the row carried none. */
  script_style: number | null
  /** The pool state name, such as `pending_leader_claim`; null when the row carries none. */
  status: string | null
  /** `canClaim` for the calling account, or null when the row carried no boolean. */
  can_claim: boolean | null
  /** Name of the leader the pool says holds this screenplay, when it names one. */
  claim_leader_name: string | null
  /** Name of the member the pool says holds this screenplay, when it names one. */
  claim_member_name: string | null
}

/** The object holding `rows`: the payload itself, or the `data` it wraps. */
function pageCarrier(data: unknown): Record<string, unknown> {
  if (!data || typeof data !== 'object' || Array.isArray(data)) invalid()
  const record = data as Record<string, unknown>
  if (Array.isArray(record.rows)) return record
  const nested = record.data
  if (nested && typeof nested === 'object' && !Array.isArray(nested)
    && Array.isArray((nested as Record<string, unknown>).rows)) {
    return nested as Record<string, unknown>
  }
  invalid()
}

/**
 * Read one page of screenplays from either list endpoint.
 *
 * These two endpoints are the provider's unwrapped family — `{code, total, rows}`
 * with no `data` — while the single-object endpoints nest their payload, so both
 * spellings are accepted. Anything else fails as `CONTRACT_CHANGED` rather than
 * reading as an empty page: "no screenplay matched" and "this payload was not a
 * list" must not look the same to a caller. `total` is required for the same
 * reason, because it is the only bound on how many pages remain unread.
 * @param data - The unwrapped envelope keys, the enveloped `data`, or a payload
 *   whose own `data` still nests the page.
 * @returns The page's own total and its rows projected onto the fields readers promise.
 */
export function readScriptList(data: unknown): { total: number; rows: ScriptRow[] } {
  const page = pageCarrier(data)
  // Stricter than {@link optionalCount}: a scan's `complete` claim is measured
  // against this number, so a value that is not the provider's own integer total
  // stops the call here rather than reading as a complete single-page scan.
  const total = page.total
  if (typeof total !== 'number' || !Number.isSafeInteger(total) || total < 0) invalid()
  return { total, rows: rows(page.rows).map(item => ({
    script_id: positiveInteger(item.id ?? item.scriptId),
    script_name: optionalText(item.scriptName),
    manuscript_name: optionalText(item.manuscriptName),
    episode_count: optionalCount(item.episodeCount),
    script_style: optionalCount(item.scriptStyle),
    status: optionalText(item.status),
    can_claim: optionalFlag(item.canClaim),
    claim_leader_name: optionalText(item.claimLeaderName),
    claim_member_name: optionalText(item.claimMemberName),
  })) }
}
