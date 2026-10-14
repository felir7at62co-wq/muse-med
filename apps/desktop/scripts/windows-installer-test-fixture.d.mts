/** Build a private NSIS fixture while preserving the production prerequisite checks.
 * @param source - Production NSIS source.
 * @param appRoot - Absolute desktop application directory.
 * @returns Private fixture source with an opt-in reboot result.
 */
export function createInstallerTestSource(source: string, appRoot: string): string

/** Confirm a recorded Registry64 runtime before running the native UI scenarios.
 * @param receipt - Parsed prerequisite preparation receipt.
 */
export function assertVisualCppPrerequisiteReceipt(receipt: unknown): void

/** Require the intended post-relaunch failure and independently observed cleanup.
 * @param error - Child process failure from the negative UI scenario.
 * @param receipt - Parsed cleanup receipt written by that scenario.
 */
export function assertInstallerNegativeControl(error: unknown, receipt: unknown): void
