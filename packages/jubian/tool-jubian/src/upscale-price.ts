/** Quotes one upscale from the exact live model row used to build its request. */
import { JubianError } from '@deepseek-ai/dsh-jubian'
import type { PostProcessModel } from '@deepseek-ai/dsh-jubian-api'

function invalid(): never { throw new JubianError('CONTRACT_CHANGED', 'Invalid live upscale price') }

/** Round a positive decimal price times a whole quantity up to cents without binary floating-point multiplication. */
function amountOf(price: number, quantity: bigint): string {
  const decimal = String(price)
  const exponentAt = decimal.indexOf('e')
  const mantissa = (exponentAt < 0 ? decimal : decimal.slice(0, exponentAt)).split('.')
  const digits = BigInt(mantissa.join('')) * quantity
  const exponent = exponentAt < 0 ? 0 : Number(decimal.slice(exponentAt + 1))
  const scale = (mantissa[1]?.length ?? 0) - exponent - 2
  const factor = 10n ** BigInt(Math.abs(scale))
  const cents = scale > 0 ? (digits + factor - 1n) / factor : digits * factor
  if (cents > BigInt(Number.MAX_SAFE_INTEGER)) invalid()
  return `${String(cents / 100n)}.${String(cents % 100n).padStart(2, '0')}`
}

/**
 * Read the selected output standard's billing coefficient.
 *
 * The catalogue states no coefficient field. MediaKit's live standards carry a
 * small integer in `height` (4 for 1080p, 2 for 720p) with `width` 0, which this
 * reservation reads as the coefficient. The generative MediaKit catalogue
 * instead supplies the already-adjusted 30 fps per-minute price on the standard.
 */
function coefficientOf(row: Record<string, unknown>, videoStandardId: number | null, unitPrice: number): number | undefined {
  const standards: unknown[] = Array.isArray(row.videoStandards) ? row.videoStandards : []
  const matching = standards.filter((value): value is Record<string, unknown> =>
    value !== null && typeof value === 'object' && (value as Record<string, unknown>).id === videoStandardId)
  const [standard] = matching
  if (row.modelId !== 'enhance-video-generative' || row.platformId !== 'AI_MEDIA_KIT') {
    const coefficient = standard?.width === 0 ? standard.height : undefined
    return typeof coefficient === 'number' && Number.isSafeInteger(coefficient) && coefficient > 0 ? coefficient : undefined
  }
  if (standard?.modelId !== row.modelId || matching.length !== 1 || standard.frames !== 30
    || standard.width != null || standard.height != null || typeof standard.resolution !== 'string') return undefined
  const resolution = standard.resolution.toLowerCase()
  const baseCoefficient = resolution === '1080p' ? 2 : resolution === '720p' ? 1 : undefined
  if (baseCoefficient === undefined || standard.price !== unitPrice * baseCoefficient) return undefined
  // The request selects a standard by ID without establishing output FPS.
  // The published 60–120 fps band costs four times the 30 fps band.
  return baseCoefficient * 4
}

/**
 * Read the selected live row's CNY reservation for one upscale.
 *
 * `元/条` reserves the price once. `元/分钟(1系数)` reserves the price times the
 * selected standard's coefficient for every started minute of the source,
 * because the provider's duration rounding is not part of the catalogue.
 * @param catalogue - The same taskType 20 response used to resolve the request's selectors.
 * @param selected - Exact model, platform and standards selected from that response.
 * @param duration - Source video duration in seconds.
 * @returns A quote rounded up to cents, or no amount when pricing is absent, its unit is unsupported or
 *   its coefficient is unreadable. An absent quote leaves the existing operator-approved estimate policy to the budget checker.
 * @throws {JubianError} CONTRACT_CHANGED for a missing row, an invalid or unsafe price, or an unusable duration for a per-minute price.
 */
export function readUpscaleQuote(catalogue: unknown, selected: PostProcessModel, duration: number):
{ amount?: string; unit?: string } {
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
  if (row.unit === '元/条') return { amount: amountOf(price, 1n), unit: 'CNY' }
  if (row.unit !== '元/分钟(1系数)') return {}
  const coefficient = coefficientOf(row, selected.videoStandardId, price)
  if (coefficient === undefined) return {}
  if (!Number.isFinite(duration) || duration <= 0) {
    throw new JubianError('CONTRACT_CHANGED', 'Invalid source duration for a per-minute upscale price')
  }
  return { amount: amountOf(price, BigInt(Math.ceil(duration / 60)) * BigInt(coefficient)), unit: 'CNY' }
}
