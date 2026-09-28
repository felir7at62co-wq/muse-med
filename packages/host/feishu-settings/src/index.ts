/**
 * The Feishu settings row: one Host plugin that owns the product's `feishu`
 * switch and publishes the `feishuSetup` Remote namespace the Web Settings page
 * calls.
 *
 * The row is the only writer of the durable switch; the desktop composition
 * reads that switch from the composed rows and turns it into the bundled bridge
 * row's own activation key at the next backend start
 * (`apps/desktop-host/src/feishu-gate.ts`). The browser half lives in `./client`,
 * and the browser bundle carries no QR encoder: the Host renders each
 * registration URL into an SVG data URL.
 *
 * @module @deepseek-ai/dsh-feishu-settings
 */

import type { Context, Volatile } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { FeishuSetupService } from './service.ts'

export {
  FEISHU_CHANNEL_ROW_ID, FEISHU_SETTINGS_DEFAULTS, FEISHU_SETTINGS_NAMESPACE, type FeishuSettings,
} from './settings.ts'
export {
  FeishuLoginError, FeishuLoginFlow, officialRegisterApp,
  type FeishuLoginOptions, type FeishuRegistration, type RegisterAppPort,
  type RegisterAppRequest, type RegisterAppResult,
} from './login.ts'
export { qrSvgDataUrl, type QrRenderOptions } from './qr.ts'
export { credentialSourceOf, rowStateOf, type FeishuRowProbe } from './status.ts'
export { FeishuSetupService, type FeishuSetupServiceOptions } from './service.ts'
export type * from './types.ts'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'feishu'

/** Runtime switch this product's own row publishes to the Settings page. */
export interface Config {
  /**
   * Whether the bundled bridge channel may run. The Loader resolves this from
   * the profile patch, so a write from the page reaches the next boot's
   * composition, and the live reference also answers the page in this boot.
   */
  enabled: Volatile<boolean>
}

/**
 * Schema of the `feishu` row's Config — the product switch.
 *
 * `enabled` defaults to `false`, so a profile that stores nothing, an empty
 * section, and a section without the key all mean off, and `volatile()` is what
 * makes the field editable through the settings service without a remount.
 */
export const Config = z.object({
  enabled: z.boolean().default(false).volatile()
    .description('Run the bundled Feishu bridge after the next backend start / 下次后端启动后运行内置飞书桥接。'),
})

/**
 * Mount the Host half. The row's own Config IS the `feishu` settings section,
 * so the service reads the switch from its live reference and writes it back
 * through the settings service.
 * @param ctx - Host context of the composed row.
 * @param config - this row's resolved Config.
 */
export function apply(ctx: Context, config: Config): void {
  ctx.inject(['settings'], (settingsCtx) => {
    const loader = settingsCtx.get('loader')
    settingsCtx.plugin(FeishuSetupService, {
      enabled: () => config.enabled.get(),
      settings: settingsCtx.settings,
      ...(loader === undefined ? {} : { loader }),
    })
  })
}
