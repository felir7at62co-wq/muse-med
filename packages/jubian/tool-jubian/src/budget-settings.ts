import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-settings'

/**
 * The settings namespace the short-drama settings row owns.
 *
 * A plugin's settings namespace is the composition entry id it is mounted under,
 * and both shipped compositions mount that row as `drama-settings`; the id is
 * spelled here rather than imported so this row keeps working — and keeps its
 * dependency list — whether or not the drama settings package is composed.
 */
export const DRAMA_SETTINGS_NAMESPACE = 'drama-settings'

/**
 * Read the short-drama section the settings row publishes.
 *
 * The section is another row's own `Config`, so it is read through the settings
 * service's describe pass rather than that row's internals: one declaration
 * stays the schema, and a deployment composing no such row reports none.
 * @param ctx - Host context that may carry the settings service.
 * @returns The resolved section, or undefined while no row serves that namespace.
 */
export function dramaSection(ctx: Context): Record<string, unknown> | undefined {
  const settings = ctx.get('settings')
  if (settings === undefined) return undefined
  const served = settings.describe().find(row => row.ns === DRAMA_SETTINGS_NAMESPACE)?.value
  return typeof served === 'object' && served !== null && !Array.isArray(served)
    ? served as Record<string, unknown>
    : undefined
}

/**
 * Read the drama namespace's resolved per-series CNY limit at each paid claim.
 * An unmounted namespace keeps legacy manual authorization; a malformed mounted
 * section fails closed instead of silently falling back to a different cap.
 * @param ctx - Host context that may carry the settings service.
 * @returns Nonnegative integer cents, or undefined without the drama namespace.
 */
export function seriesBudgetLimit(ctx: Context): number | undefined {
  const section = dramaSection(ctx)
  if (section === undefined) return undefined
  const amount = section.seriesBudgetCents
  if (typeof amount !== 'number' || !Number.isSafeInteger(amount) || amount < 0) {
    throw new Error(`Jubian budget: ${DRAMA_SETTINGS_NAMESPACE}.seriesBudgetCents must be nonnegative safe integer cents`)
  }
  return amount
}
