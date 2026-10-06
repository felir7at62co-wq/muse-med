/** Shared provider-field readers; endpoint readers own their diagnostics. */
import { JubianError } from '@deepseek-ai/dsh-jubian'

/**
 * Reject an unreadable provider field.
 * @returns Never returns.
 */
export function invalid(): never { throw new JubianError('CONTRACT_CHANGED') }

/**
 * Read a non-array provider record.
 * @param value - Wire value.
 * @returns Record or throws.
 */
export function wireObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid()
  return value as Record<string, unknown>
}

/**
 * Read a provider page.
 * @param value - Wire page.
 * @returns Validated records or throws.
 */
export function wireRows(value: unknown): Record<string, unknown>[] {
  const record = wireObject(value)
  if (!Array.isArray(record.rows)) invalid()
  return record.rows.map(wireObject)
}

/**
 * Read a safe page count.
 * @param value - Wire page.
 * @param fallback - Missing-count value.
 * @returns Safe count.
 */
export function wireTotal(value: unknown, fallback: number): number {
  const record = wireObject(value)
  return typeof record.total === 'number' && Number.isSafeInteger(record.total) ? record.total : fallback
}

/**
 * Read a strict positive identifier.
 * @param value - Number or decimal string.
 * @returns Identifier or throws.
 */
export function wirePositiveId(value: unknown): number {
  const candidate = typeof value === 'string' && /^[1-9][0-9]*$/.test(value) ? Number(value) : value
  if (typeof candidate !== 'number' || !Number.isSafeInteger(candidate) || candidate < 1) invalid()
  return candidate
}

/**
 * Read optional text.
 * @param value - Wire value.
 * @returns Nonblank text or null.
 */
export function wireNullableText(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null
}

/**
 * Read a positive integer accepting padded decimal strings.
 * @param value - Wire value.
 * @returns Integer or throws.
 */
export function wireInteger(value: unknown): number {
  const candidate = typeof value === 'string' && /^[0-9]+$/.test(value.trim()) ? Number(value.trim()) : value
  if (typeof candidate !== 'number' || !Number.isSafeInteger(candidate) || candidate < 1) invalid()
  return candidate
}

/**
 * Read a credential-free HTTPS URL.
 * @param value - Wire value.
 * @returns Accepted URL or null.
 */
export function wireHttpsUrl(value: unknown): string | null {
  if (typeof value !== 'string') return null
  try {
    const url = new URL(value)
    return url.protocol === 'https:' && url.hostname && !url.username && !url.password && !value.includes('\\')
      ? value : null
  } catch (_error) { /* Malformed provider URLs have no accepted HTTPS value. */ return null }
}
