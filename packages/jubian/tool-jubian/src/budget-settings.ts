import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-settings'

/**
 * Read the drama namespace's resolved per-series CNY limit at each paid claim.
 * An unmounted namespace keeps legacy manual authorization; a malformed mounted
 * section fails closed instead of silently falling back to a different cap.
 * @param ctx - Host context that may carry the settings service.
 * @returns Nonnegative integer cents, or undefined without the drama namespace.
 */
export function seriesBudgetLimit(ctx: Context): number | undefined {
  const settings = ctx.get('settings')
  if (settings === undefined) return undefined
  const section: unknown = settings.get('drama')
  if (section === undefined) return undefined
  const amount = typeof section === 'object' && section !== null && !Array.isArray(section)
    ? (section as Record<string, unknown>).seriesBudgetCents : undefined
  if (typeof amount !== 'number' || !Number.isSafeInteger(amount) || amount < 0) {
    throw new Error('Jubian budget: drama.seriesBudgetCents must be nonnegative safe integer cents')
  }
  return amount
}
