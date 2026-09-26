/**
 * The two settings sections this product owns or pre-registers.
 *
 * `feishu` is this product's own switch: the desktop composition reads it from
 * the same settings document to compute the `feishu-channel` row's entry-level
 * `disabled` (`apps/desktop-host/src/feishu-gate.ts`). `dsh-lark-bridge` is the
 * bundled bridge's own section, and this product registers it **only while the
 * bridge cannot run** — the settings service refuses to write an unregistered
 * namespace, so that pre-registration is what lets the page store the
 * credential pair before the bridge is ever started. The pair therefore lives in
 * the bridge's user layer, which the bridge resolves over its composed config,
 * and no composed entry or configuration dump can carry it.
 *
 * @module @deepseek-ai/dsh-feishu-settings/settings
 */

import z from '@deepseek-ai/schemastery'

/** Namespace owning this product's Feishu switch. */
export const FEISHU_SETTINGS_NAMESPACE = 'feishu'

/** Settings namespace the bundled bridge registers for its own section. */
export const BRIDGE_SETTINGS_NAMESPACE = 'dsh-lark-bridge'

/** One resolved product section. */
export interface FeishuSettings {
  /**
   * Whether the bundled bridge row may run. An absent document, an absent
   * section, and an absent key all resolve through this schema to `false`.
   */
  enabled: boolean
  /**
   * Open id of the user whose scan wrote the current credential pair; empty
   * when the pair was entered by hand. Not a secret, and it authorizes nothing.
   */
  registeredBy: string
}

/** Resolved defaults, shared by readers that need the absent-document answer. */
export const FEISHU_SETTINGS_DEFAULTS: FeishuSettings = { enabled: false, registeredBy: '' }

/**
 * Schema of the `feishu` section.
 *
 * `enabled` defaults to `false`, so a document that is missing, empty, or
 * otherwise unreadable can only mean off.
 */
export const FeishuSettingsSchema = z.object({
  enabled: z.boolean().default(false)
    .description('Run the bundled Feishu bridge after the next backend start / 下次后端启动后运行内置飞书桥接。'),
  registeredBy: z.string().default('')
    .description('Open id of the user who completed the QR scan / 扫码注册者的 open id。'),
})

/**
 * The bridge's own section, as far as this product reads and writes it.
 *
 * Only the credential pair and the override flag are named here; a bridge
 * section may carry further keys, and path-addressed writes leave every key this
 * schema does not name untouched in the stored document.
 */
export interface BridgeSettings {
  /** The bridge's own activation key, which wins over the composed row config. */
  enabled: boolean
  /** App id, written here so the bridge resolves it over its composed config. */
  appId: string
  /** App secret, marked as a settings secret so every settings surface redacts it. */
  appSecret: string
}

/**
 * Placeholder schema for the bridge's namespace.
 *
 * Registered only while the product switch is off, because that is exactly when
 * the bridge row is disabled and its own registration cannot exist.
 */
export const BridgeSettingsSchema = z.object({
  enabled: z.boolean().default(true)
    .description('Bridge activation override stored in the bridge’s own section / 桥自身设置段里的启用覆盖。'),
  appId: z.string().default('')
    .description('Feishu app id the bridge resolves over its composed config / 桥按其组合 config 之上解析的 App ID。'),
  appSecret: z.string().role('secret').default('')
    .description('Feishu app secret / 飞书应用 App Secret。'),
})
