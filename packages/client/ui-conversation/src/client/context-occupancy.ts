import type { ContextPressureProjection } from '@deepseek-ai/dsh-token-meter/client'

/** Context usage rendered by conversation and Chat status surfaces. */
export interface ContextOccupancy {
  percent: number
  usedTokens: number
  contextWindow: number
  workingTokenLimit?: number
}

/**
 * Resolve occupancy against a recorded working target or the model window.
 * @param pressure - latest token-meter projection.
 * @returns occupancy, or null until numerator and capacity are known.
 */
export function contextOccupancy(
  pressure: ContextPressureProjection | undefined,
): ContextOccupancy | null {
  const usedTokens = pressure?.projectedTokens ?? pressure?.pressureTokens
  if (usedTokens === undefined || pressure?.contextWindow === undefined) return null
  return {
    percent: pressure.workingTokenLimit === undefined
      ? Math.min(100, Math.round(usedTokens / pressure.contextWindow * 100))
      : Math.round(usedTokens / pressure.workingTokenLimit * 100),
    usedTokens,
    contextWindow: pressure.contextWindow,
    ...pressure.workingTokenLimit === undefined ? {} : { workingTokenLimit: pressure.workingTokenLimit },
  }
}
