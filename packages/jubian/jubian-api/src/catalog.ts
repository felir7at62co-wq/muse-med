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
