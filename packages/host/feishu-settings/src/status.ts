/**
 * The effective state of the bundled bridge row.
 *
 * Two layers decide whether the bridge runs, and the page must show both: the
 * product switch, which the desktop composition turns into the row's
 * entry-level `disabled`, and the bridge's own settings section, whose stored
 * `enabled` wins over the row's composed config once the row is running.
 *
 * @module @deepseek-ai/dsh-feishu-settings/status
 */

import type { FeishuCredentialSource, FeishuRowState } from './types.ts'

/** What the running composition reports about the bridge row. */
export interface FeishuRowProbe {
  /** Loader entry `disabled`; `undefined` when this composition has no such row. */
  readonly entryDisabled: boolean | undefined
  /** `dsh-lark-bridge.enabled` from the stored user layer; `undefined` when absent. */
  readonly bridgeOverride: boolean | undefined
}

/**
 * Reduce the switch and the composition probe to the state a page shows.
 * @param enabled - stored product switch.
 * @param probe - entry and plugin-level observations of this composition.
 * @returns the effective row state.
 */
export function rowStateOf(enabled: boolean, probe: FeishuRowProbe): FeishuRowState {
  if (probe.entryDisabled === undefined) return 'unavailable'
  if (!enabled) return 'disabled'
  if (probe.bridgeOverride === false) return 'overridden'
  if (probe.entryDisabled) return 'restart-pending'
  return 'active'
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
