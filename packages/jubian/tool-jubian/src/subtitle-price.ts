/** Conservative CNY reservation from the selected live subtitle-erasure catalogue row. */
import { JubianError } from '@deepseek-ai/dsh-jubian'
import type { PostProcessModel } from '@deepseek-ai/dsh-jubian-api'

function invalid(): never { throw new JubianError('CONTRACT_CHANGED', 'Invalid live subtitle-erasure price') }

function centsOf(price: number, quantity: number): number {
  const match = /^(\d+)(?:\.(\d+))?$/.exec(String(price))
  if (match === null) invalid()
  const fraction = match[2] ?? ''
  const numerator = BigInt(`${match[1]}${fraction}`) * BigInt(quantity) * 100n
  const divisor = 10n ** BigInt(fraction.length)
  const cents = (numerator + divisor - 1n) / divisor
  if (cents > BigInt(Number.MAX_SAFE_INTEGER)) invalid()
  return Number(cents)
}

/**
 * Accept a zero quote only for the exact known free Fire route in the live catalogue.
 * Other zero-priced rows retain a one-cent reservation.
 * For minute pricing, round usage up to whole minutes because the provider's
 * final duration-rounding rule is not part of the read-only catalogue response.
 * @param catalogue - Live task-type-10 catalogue rows.
 * @param selected - Exact model and platform chosen from those rows.
 * @param duration - Source video duration in seconds.
 * @returns Conservative CNY reservation and its human-readable basis.
 */
export function readSubtitleEraseQuote(catalogue: unknown, selected: PostProcessModel, duration: number):
{ amount: string; unit: 'CNY'; basis: string; verifiedFreeSubtitleErase?: true } {
  if (!Array.isArray(catalogue) || !Number.isFinite(duration) || duration <= 0) invalid()
  const rows = catalogue.filter((value: unknown): value is Record<string, unknown> =>
    value !== null && typeof value === 'object' && !Array.isArray(value))
    .filter(row => row.modelId === selected.modelId && row.platformId === selected.platformId
      && (row.id ?? row.standardId) === selected.standardId)
  const [row] = rows
  if (rows.length !== 1 || row === undefined) invalid()
  const price = row.unitPrice
  if (typeof price !== 'number' || !Number.isFinite(price) || price < 0) invalid()
  let cents: number
  let basis: string
  if (selected.modelId === 'ark-erase-video-subtitle-pro' && row.unit === '元/条') {
    if (selected.platformId === 'AI_MEDIA_KIT' && selected.standardId === 67 && price === 0) {
      return { amount: '0.00', unit: 'CNY', verifiedFreeSubtitleErase: true,
        basis: '火山去字幕实时目录唯一匹配 AI_MEDIA_KIT / 67 / 0 元/条；记账 0.00 CNY，最终结算以供应商账单为准。' }
    }
    cents = Math.max(1, centsOf(price, 1))
    basis = `火山去字幕实时目录 ${price} 元/条；未核实为已知免费路线的零价保护性预留 0.01 CNY，不代表实际结算账单。`
  } else if (selected.modelId === 'quzimuToB' && row.unit === '元/分钟') {
    const minutes = Math.ceil(duration / 60)
    if (!Number.isSafeInteger(minutes)) invalid()
    cents = Math.max(1, centsOf(price, minutes))
    basis = `羽点去字幕实时目录 ${price} 元/分钟；源片 ${duration} 秒按 ${minutes} 整分钟保守预留，实际结算以账单为准。`
  } else invalid()
  return { amount: `${String(Math.floor(cents / 100))}.${String(cents % 100).padStart(2, '0')}`,
    unit: 'CNY', basis }
}
