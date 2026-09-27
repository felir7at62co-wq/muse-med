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
 *
 * A composition with no settings provider at all keeps legacy manual
 * authorization, which is a supported shape for a Jubian-only deployment. A
 * composition that HAS a settings service but serves no readable
 * {@link DRAMA_SETTINGS_NAMESPACE} section is a misconfiguration, not a choice:
 * the ceiling this deployment configured cannot be read, so the reader warns
 * with the fix instead of letting the cap disappear quietly, and the paid call
 * falls back to the ledger's manual authorization — which refuses a project
 * with no authorization entry. A malformed mounted section fails closed instead
 * of falling back to a different cap.
 * @param ctx - Host context that may carry the settings service.
 * @returns Nonnegative integer cents, or undefined without a readable drama section.
 */
export function seriesBudgetLimit(ctx: Context): number | undefined {
  const section = dramaSection(ctx)
  if (section === undefined) {
    if (ctx.get('settings') !== undefined) warnUnreadableSection(ctx)
    return undefined
  }
  const amount = section.seriesBudgetCents
  if (typeof amount !== 'number' || !Number.isSafeInteger(amount) || amount < 0) {
    throw new Error(`Jubian budget: ${DRAMA_SETTINGS_NAMESPACE}.seriesBudgetCents must be nonnegative safe integer cents`)
  }
  return amount
}

/**
 * Report a composed settings service that serves no readable drama section.
 *
 * The message names the two ways out — mount the row under the id every reader
 * addresses, or state the project's ceiling in the ledger's manual
 * authorization file — because the alternative is a paid call authorized by a
 * ceiling nobody can see.
 * @param ctx - Host context carrying the settings service.
 */
function warnUnreadableSection(ctx: Context): void {
  ctx.logger.warn(
    'Jubian budget: the settings service serves no readable "%s" section, so the automatic per-series ceiling cannot be read. '
    + 'Compose @deepseek-ai/dsh-drama-settings with an explicit `id: %s` (a bare package row is mounted under a generated id), '
    + 'or authorize this project in the ledger\'s authorization.json; without either, every paid call is refused.',
    DRAMA_SETTINGS_NAMESPACE, DRAMA_SETTINGS_NAMESPACE,
  )
}
