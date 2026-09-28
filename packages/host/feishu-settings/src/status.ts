/**
 * The effective state of the bundled bridge row.
 *
 * Two facts decide whether the bridge runs, and the page shows both: the stored
 * product switch, and whether this boot's composition already carried it into
 * the bridge row's own activation key.
 *
 * @module @deepseek-ai/dsh-feishu-settings/status
 */

import type { FeishuCredentialSource, FeishuRowState } from './types.ts'

/** What the running composition reports about the bridge row. */
export interface FeishuRowProbe {
  /** Whether this composition has the bridge row at all. */
  readonly composed: boolean
  /** The row's resolved activation key in this boot; `undefined` when it has no readable config. */
  readonly bridgeEnabled: boolean | undefined
}

/**
 * Reduce the switch and the composition probe to the state a page shows.
 * @param enabled - stored product switch.
 * @param probe - this composition's observation of the bridge row.
 * @returns the effective row state.
 */
export function rowStateOf(enabled: boolean, probe: FeishuRowProbe): FeishuRowState {
  if (!probe.composed) return 'unavailable'
  if (!enabled) return 'disabled'
  return probe.bridgeEnabled === true ? 'active' : 'restart-pending'
}

/**
 * Where the stored credential pair came from.
 * @param hasSecret - whether the bridge's section stores a secret right now.
 * @param registeredBy - scanner recorded by the last scan, empty for a hand-entered pair.
 * @returns `none` while no secret is stored, otherwise the writing path.
 */
export function credentialSourceOf(hasSecret: boolean, registeredBy: string): FeishuCredentialSource {
  if (!hasSecret) return 'none'
  return registeredBy.length > 0 ? 'registered' : 'manual'
}
