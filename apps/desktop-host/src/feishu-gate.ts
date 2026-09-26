/**
 * Entry-level activation switch for the bundled Feishu bridge row.
 *
 * `disabled` is the Loader's entry switch, and it is the only one that keeps a
 * row's plugin code from running at all: a `config.enabled` key reaches the
 * plugin instead, which resolves it against that bridge's stored settings
 * section, so a value stored there once can keep the bridge active across a
 * restart this product never asked for. The switch is read from the product
 * settings document before the Loader sees the entry list, because this
 * composition has no live patch reload: a switch flipped in the UI takes effect
 * at the next backend start.
 * @module @deepseek-ai/dsh-desktop-host/feishu-gate
 */

import { readFileSync } from 'node:fs'
import type { PatchOptions } from '@deepseek-ai/cordis-plugin-include'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import { parseDocument } from 'yaml'

/** Composition row id of the bundled Feishu bridge. */
export const FEISHU_CHANNEL_ROW_ID = 'feishu-channel'

/** Settings namespace owning this product's Feishu section. */
export const FEISHU_SETTINGS_NAMESPACE = 'feishu'

/** Key holding the activation switch inside that namespace. */
export const FEISHU_ENABLED_KEY = 'enabled'

/** The parts of a composed entry this gate reads. */
export interface FeishuGateRow {
  /** Entry id the composition patches by. */
  readonly id: string
  /** Config the earlier layers composed for that entry. */
  readonly config?: unknown
}

/** Whether a parsed YAML value is a mapping for section lookup. */
function isMap(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Whether a filesystem error means the document is absent. */
function isENOENT(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | null)?.code === 'ENOENT'
}

/**
 * Read this product's stored Feishu switch.
 *
 * The document is parsed with the settings provider's own reader and its
 * default core schema, so a hand-edited document cannot read as enabled here
 * while the service resolves something else. An absent document, an absent
 * section, and a section without the key all mean off; everything the provider
 * itself fails loud on (an unreadable document, a syntax error, an unresolvable
 * document, a non-map root or section) fails loud here too, because a
 * misconfigured settings document is not a decision to run with the gate open.
 * @param documentPath - absolute path of the settings document (`settings.yaml` by default).
 * @returns whether the stored switch is exactly `true`.
 */
export function readFeishuEnabled(documentPath: string): boolean {
  let text: string
  try {
    text = readFileSync(documentPath, 'utf8')
  } catch (error) {
    if (isENOENT(error)) return false
    throw new Error(`muse-med: failed to read the settings document ${documentPath}: ${String(error)}`)
  }
  const document = parseDocument(text, { prettyErrors: true })
  if (document.errors.length > 0) {
    // The reader's own message quotes the offending source line, and a settings
    // document can hold a `role('secret')` value; report the position instead.
    const reasons = document.errors.map((error) => {
      const at = error.linePos?.[0]
      return `${error.code}${at === undefined ? '' : ` at line ${String(at.line)}, column ${String(at.col)}`}`
    })
    throw new Error(`muse-med: invalid settings document at ${documentPath}: ${reasons.join('; ')}`)
  }
  let root: unknown
  try {
    root = document.toJS() ?? {}
  } catch (error) {
    // Same reason: an unresolvable document names the node it rejected, which
    // can be document text.
    throw new Error(`muse-med: settings document at ${documentPath} cannot be resolved (${error instanceof Error ? error.name : typeof error})`)
  }
  if (!isMap(root)) {
    throw new TypeError(`muse-med: ${documentPath} must be a map of settings sections`)
  }
  const section = root[FEISHU_SETTINGS_NAMESPACE]
  if (section === undefined || section === null) return false
  if (!isMap(section)) {
    throw new TypeError(`muse-med: settings section "${FEISHU_SETTINGS_NAMESPACE}" in ${documentPath} must be a map of keys`)
  }
  return section[FEISHU_ENABLED_KEY] === true
}

/**
 * Compose the activation layer for the bundled Feishu bridge row.
 *
 * The layer must be appended after every layer that configures that row: the
 * desktop patch sets the fail-safe `disabled: true` and the activation controls
 * the staged package understands, and this layer carries the product switch
 * instead. It restates those controls because a patch replaces the whole config
 * of the row it targets — dropping `enabled` would leave an activated bridge
 * inert, and dropping the other two would let an activation this product
 * deliberately did not ask for — cross-instance sync and QR app registration —
 * follow the switch on.
 * @param rows - entries composed from the layers this one is appended to.
 * @param documentPath - absolute path of the settings document; defaults to the
 *   `settings.yaml` the composed settings provider itself reads.
 * @returns one patch layer holding the entry-level switch and the resolved
 *   activation controls, or no layer at all when the composition has no Feishu
 *   bridge row to gate.
 */
export function feishuGateLayer(
  rows: readonly FeishuGateRow[],
  documentPath: string = dshHomePath('settings.yaml'),
): PatchOptions[] {
  const row = rows.find(candidate => candidate.id === FEISHU_CHANNEL_ROW_ID)
  if (row === undefined) return []
  const enabled = readFeishuEnabled(documentPath)
  return [{
    id: FEISHU_CHANNEL_ROW_ID,
    disabled: !enabled,
    config: { ...(isMap(row.config) ? row.config : {}), [FEISHU_ENABLED_KEY]: enabled },
  }]
}
