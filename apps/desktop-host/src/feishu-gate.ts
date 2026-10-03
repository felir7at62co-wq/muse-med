/**
 * Desktop dependency order for the optional Feishu bridge.
 *
 * The setup service installs its startup activation hook before this entry
 * resolves Config. Only dependency metadata is composed here; the bridge's
 * editable credentials and policy remain in the bundle and user profile.
 *
 * @module @deepseek-ai/dsh-desktop-host/feishu-gate
 */

import type { Inject } from '@deepseek-ai/cordis'
import type { PatchOptions } from '@deepseek-ai/cordis-plugin-include'
import { FEISHU_CHANNEL_ROW_ID } from '@deepseek-ai/dsh-feishu-settings'

/** Entry id of the row holding the product switch. */
export { FEISHU_SETTINGS_NAMESPACE } from '@deepseek-ai/dsh-feishu-settings'

/** Entry id of the bundled Feishu bridge. */
export { FEISHU_CHANNEL_ROW_ID } from '@deepseek-ai/dsh-feishu-settings'

/** Entry metadata needed to order the bridge after its setup service. */
export interface FeishuGateRow {
  /** Entry id the composition patches by. */
  readonly id: string
  /** Existing dependencies and their service intercept configs. */
  readonly inject?: Inject<Record<string, unknown>> | null
}

/**
 * Require the setup service before the bundled bridge resolves its config.
 * @param rows - entries composed from preceding layers.
 * @returns the bridge dependency patch, or no patch when its entry is absent.
 */
export function feishuGateLayer(rows: readonly FeishuGateRow[]): PatchOptions[] {
  const row = rows.find(candidate => candidate.id === FEISHU_CHANNEL_ROW_ID)
  if (row === undefined) return []
  const inject: Inject<Record<string, unknown>> = Array.isArray(row.inject)
    ? [...new Set([...row.inject, 'feishuSetup'])]
    : { ...row.inject, feishuSetup: row.inject?.['feishuSetup'] ?? {} }
  return [{ id: FEISHU_CHANNEL_ROW_ID, inject }]
}
