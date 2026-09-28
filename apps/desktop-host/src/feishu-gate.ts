/**
 * Entry-level activation of the bundled Feishu bridge row.
 *
 * The product switch is the `feishu` row's own `enabled` field, and this layer
 * carries it into the `feishu-channel` row's config — the key the staged bridge
 * reads before it starts its sync layer, its control server, its peer
 * heartbeat, or a QR app registration. A patch replaces the whole config of the
 * row it targets, so the layer restates every control the earlier layers
 * composed: dropping `enabled` would leave an activated bridge inert, and
 * dropping the others would let an activation this product deliberately did not
 * ask for — cross-instance sync and QR app registration — follow the switch on.
 *
 * The layer is appended after every layer that configures that row, so it wins
 * over any value stored for the bridge's own section: a stored `enabled: true`
 * cannot activate a row the product switch left off. Credentials are
 * deliberately absent from the composed config: they live in the bridge row's
 * own stored section, where no dump can reach them, and this layer never names
 * them.
 *
 * @module @deepseek-ai/dsh-desktop-host/feishu-gate
 */

import type { PatchOptions } from '@deepseek-ai/cordis-plugin-include'
import { FEISHU_CHANNEL_ROW_ID, FEISHU_SETTINGS_NAMESPACE } from '@deepseek-ai/dsh-feishu-settings'

/** Entry id of the row holding the product switch. */
export { FEISHU_SETTINGS_NAMESPACE } from '@deepseek-ai/dsh-feishu-settings'

/** Entry id of the bundled Feishu bridge. */
export { FEISHU_CHANNEL_ROW_ID } from '@deepseek-ai/dsh-feishu-settings'

/** Key holding the activation switch inside the product row. */
export const FEISHU_ENABLED_KEY = 'enabled'

/** The parts of a composed entry this gate reads. */
export interface FeishuGateRow {
  /** Entry id the composition patches by. */
  readonly id: string
  /** Config the earlier layers composed for that entry. */
  readonly config?: unknown
}

/** Whether a parsed value is a mapping for key lookup. */
function isMap(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Read this product's stored Feishu switch out of the composed rows.
 *
 * The switch is the product row's own Config field, so the value the Loader
 * composed — the profile's stored patch over the shipped defaults — is the same
 * value the settings service resolves for that section. An absent row, an
 * absent section, and a value that is not exactly `true` all mean off: only an
 * explicit `true` is consent to run the bridge.
 * @param rows - entries composed from the layers this one is appended to.
 * @returns whether the stored switch is exactly `true`.
 */
export function readFeishuEnabled(rows: readonly FeishuGateRow[]): boolean {
  const row = rows.find(candidate => candidate.id === FEISHU_SETTINGS_NAMESPACE)
  return isMap(row?.config) && row.config[FEISHU_ENABLED_KEY] === true
}

/**
 * Compose the activation layer for the bundled Feishu bridge row.
 * @param rows - entries composed from the layers this one is appended to.
 * @returns one patch layer holding the row's activation key and the resolved
 *   activation controls, or no layer at all when the composition has no Feishu
 *   bridge row to gate.
 */
export function feishuGateLayer(rows: readonly FeishuGateRow[]): PatchOptions[] {
  const row = rows.find(candidate => candidate.id === FEISHU_CHANNEL_ROW_ID)
  if (row === undefined) return []
  return [{
    id: FEISHU_CHANNEL_ROW_ID,
    config: { ...(isMap(row.config) ? row.config : {}), [FEISHU_ENABLED_KEY]: readFeishuEnabled(rows) },
  }]
}
