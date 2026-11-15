import type { ContextPressureProjection } from '@deepseek-ai/dsh-token-meter/client'

/** Context usage rendered by conversation and Chat status surfaces. */
export interface ContextOccupancy {
  percent: number
  usedTokens: number
  contextWindow: number
  workingTokenLimit?: number
}

/**
 * Use a calibrated prepared-request snapshot when paired with a working target;
 * otherwise retain the provider-anchored model-window display.
 * @param pressure - latest token-meter projection.
 * @returns occupancy, or null until numerator and capacity are known.
 */
export function contextOccupancy(
  pressure: ContextPressureProjection | undefined,
): ContextOccupancy | null {
  const workingTokenLimit = pressure?.workingContextTokens === undefined ? undefined : pressure.workingTokenLimit
  const usedTokens = workingTokenLimit === undefined
    ? pressure?.projectedTokens ?? pressure?.pressureTokens
    : pressure?.workingContextTokens
  if (usedTokens === undefined || pressure?.contextWindow === undefined) return null
  return {
    percent: workingTokenLimit === undefined
      ? Math.min(100, Math.round(usedTokens / pressure.contextWindow * 100))
      : Math.round(usedTokens / workingTokenLimit * 100),
    usedTokens,
    contextWindow: pressure.contextWindow,
    ...workingTokenLimit === undefined ? {} : { workingTokenLimit },
  }
}
