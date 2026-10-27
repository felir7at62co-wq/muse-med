/** A budget estimate from one unambiguous live subtitle-erasure rate. */
export interface EraseRateEstimate {
  readonly amount: string
  readonly unit: 'CNY'
  readonly rate: number
  readonly durationSeconds: number
  readonly assumedMinutes: number
}

/**
 * Estimate a per-minute erasure from the exact model row and source duration.
 * The rate and duration are rounded upward separately; the provider's actual
 * minimums, rounding and final charge are not established by this estimate.
 * @param catalogue - The taskType 10 catalogue returned by the provider.
 * @param request - The resolved erasure request, including its source duration.
 * @returns A positive estimate, or undefined when the rate is absent, zero, ambiguous or unsupported.
 */
export function estimateEraseRate(catalogue: unknown, request: Record<string, unknown>): EraseRateEstimate | undefined {
  if (!Array.isArray(catalogue)) return undefined
  const matches = catalogue.filter((value): value is Record<string, unknown> => {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
    const row = value as Record<string, unknown>
    return row.modelId === request.modelId && row.platformId === request.platformId
      && (row.id ?? row.standardId) === request.standardId
  })
  const row = matches[0]
  if (row === undefined || matches.length !== 1) return undefined
  const duration = request.duration
  if (row.unit !== '元/分钟' || typeof row.unitPrice !== 'number' || !Number.isFinite(row.unitPrice)
    || row.unitPrice <= 0 || typeof duration !== 'number' || !Number.isFinite(duration) || duration <= 0) return undefined
  const centsPerMinute = Math.ceil(row.unitPrice * 100)
  const minutes = Math.ceil(duration / 60)
  const cents = centsPerMinute * minutes
  if (!Number.isSafeInteger(centsPerMinute) || !Number.isSafeInteger(minutes)
    || !Number.isSafeInteger(cents) || cents <= 0) return undefined
  return { amount: (cents / 100).toFixed(2), unit: 'CNY', rate: row.unitPrice,
    durationSeconds: duration, assumedMinutes: minutes }
}
