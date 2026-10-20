/** Quotes one upscale from the exact live model row used to build its request. */
import { JubianError } from '@deepseek-ai/dsh-jubian'
import type { PostProcessModel } from '@deepseek-ai/dsh-jubian-api'

function invalid(): never { throw new JubianError('CONTRACT_CHANGED', 'Invalid live upscale price') }

/** Round a positive decimal price up to cents without binary floating-point multiplication. */
function amountOf(price: number): string {
  const decimal = String(price)
  const exponentAt = decimal.indexOf('e')
  const coefficient = (exponentAt < 0 ? decimal : decimal.slice(0, exponentAt)).split('.')
  const digits = BigInt(coefficient.join(''))
  const exponent = exponentAt < 0 ? 0 : Number(decimal.slice(exponentAt + 1))
  const scale = (coefficient[1]?.length ?? 0) - exponent - 2
  const factor = 10n ** BigInt(Math.abs(scale))
  const cents = scale > 0 ? (digits + factor - 1n) / factor : digits * factor
  if (cents > BigInt(Number.MAX_SAFE_INTEGER)) invalid()
  return `${String(cents / 100n)}.${String(cents % 100n).padStart(2, '0')}`
}

/**
 * Read the selected live row's per-clip CNY reservation.
 * @param catalogue - The same taskType 20 response used to resolve the request's selectors.
 * @param selected - Exact model, platform and standard selected from that response.
 * @returns A per-clip quote rounded up to cents, or no amount when pricing is absent or its unit is unsupported.
 *   An absent quote leaves the existing operator-approved estimate policy to the budget checker.
 * @throws {JubianError} CONTRACT_CHANGED for a missing row or an invalid or unsafe price.
 */
export function readUpscaleQuote(catalogue: unknown, selected: PostProcessModel): { amount?: string; unit?: string } {
  if (!Array.isArray(catalogue)) invalid()
  const row = catalogue.find((value: unknown): value is Record<string, unknown> => {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
    const record = value as Record<string, unknown>
    return record.modelId === selected.modelId && record.platformId === selected.platformId
      && (record.id ?? record.standardId) === selected.standardId
  })
  if (row === undefined) invalid()
  const price = row.unitPrice
  if (price === undefined || price === null) return {}
  if (typeof price !== 'number' || !Number.isFinite(price) || price <= 0) invalid()
  if (row.unit !== '元/条') return {}
  return { amount: amountOf(price), unit: 'CNY' }
}
