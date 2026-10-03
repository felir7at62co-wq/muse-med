/**
 * The two composition rows this product's Feishu page reads and writes.
 *
 * `feishu` is this product's own switch row: its plugin captures `enabled` at
 * startup and projects the bridge's runtime activation through the config
 * waterfall. The bridge depends on its published service before resolving Config
 * (`apps/desktop-host/src/feishu-gate.ts`).
 * `feishu-channel` is the bundled bridge's own row, and in this harness a
 * plugin's settings section IS its own resolved Config: the Loader resolves the
 * row's stored values from the profile patch into the bridge's Config, so the
 * credential pair is stored by writing that row's config and read back by
 * describing it. Nothing composes the pair into an entry of its own, so no
 * configuration dump can carry it, and the secret field is `role('secret')`:
 * every settings surface reports only whether it is set.
 *
 * @module @deepseek-ai/dsh-feishu-settings/settings
 */

/** Composition row id owning this product's Feishu switch. */
export const FEISHU_SETTINGS_NAMESPACE = 'feishu'

/** Composition row id of the bundled Feishu bridge, whose own config section stores the pair. */
export const FEISHU_CHANNEL_ROW_ID = 'feishu-channel'

/** One resolved product section: the switch, and nothing else. */
export interface FeishuSettings {
  /**
   * Whether the bundled bridge channel may run. An absent document, an absent
   * section, and an absent key all resolve through this schema to `false`.
   */
  enabled: boolean
}

/** Resolved defaults, shared by readers that need the absent-row answer. */
export const FEISHU_SETTINGS_DEFAULTS: FeishuSettings = { enabled: false }
