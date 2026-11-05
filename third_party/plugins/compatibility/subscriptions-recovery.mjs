/** Keep subscription sign-in available when a previous account cannot be imported. */

/** Fixed diagnostic; credential-provider errors and raw tokens never enter the UI or logs. */
export const SUBSCRIPTION_MIGRATION_ISSUE = 'The previous ChatGPT account could not be imported. Its credentials were kept. Sign in again in Settings → Subscriptions.'

/** Saving the opt-out failed; do not claim that future automatic imports have been disabled. */
export const SUBSCRIPTION_MIGRATION_PERSISTENCE_ISSUE = `${SUBSCRIPTION_MIGRATION_ISSUE} The automatic-import setting could not be saved; automatic import may be retried after a restart.`

/**
 * Try the one-time import without blocking the replacement provider's login UI.
 * @param {object} credentials - Host credential service.
 * @param {(credentials: object) => Promise<{status: string}>} migrate - Credential importer.
 * @param {() => Promise<object>} disableImport - Persist manual-login recovery without accessing old credentials.
 * @returns {Promise<string | undefined>} Safe diagnostic on failure; undefined after a successful check.
 */
export async function recoverSubscriptionsMigration(credentials, migrate, disableImport) {
  try {
    const result = await migrate(credentials)
    if (result.status === 'manual-login-required') return SUBSCRIPTION_MIGRATION_ISSUE
  } catch (_error) {
    try { await disableImport() } catch (_markerError) {
      return SUBSCRIPTION_MIGRATION_PERSISTENCE_ISSUE
    }
    return SUBSCRIPTION_MIGRATION_ISSUE
  }
  return undefined
}

/**
 * Show an import issue while Codex has no account; clear it after an account is observed.
 * @template {string} Provider
 * @template {{ accounts: readonly unknown[], detail?: string }} Status
 * @template {{ status(provider: Provider): Promise<Status> }} Controller
 * @param {Controller} controller - Upstream auth controller, retained with its other methods intact.
 * @param {string | undefined} issue - Safe importer diagnostic; undefined leaves status untouched.
 * @returns {Controller} The same controller with per-instance recovery status.
 */
export function attachMigrationIssue(controller, issue) {
  if (issue === undefined) return controller
  const readStatus = controller.status.bind(controller)
  let pending = true
  controller.status = async provider => {
    const status = await readStatus(provider)
    if (provider !== 'codex') return status
    if (status.accounts.length > 0) pending = false
    return pending ? { ...status, detail: issue } : status
  }
  return controller
}
