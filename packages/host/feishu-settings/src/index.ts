/**
 * The Feishu settings row: one Host plugin that owns the product's `feishu`
 * section and publishes the `feishuSetup` Remote namespace the Web Settings
 * page calls.
 *
 * The row is the only writer of the durable switch; the desktop composition
 * turns that switch into the bundled bridge row's entry-level `disabled` at the
 * next backend start (`apps/desktop-host/src/feishu-gate.ts`). The browser half
 * lives in `./client`, and the browser bundle carries no QR encoder: the Host
 * renders each registration URL into an SVG data URL.
 *
 * @module @deepseek-ai/dsh-feishu-settings
 */

import type { Context } from '@deepseek-ai/cordis'
import { FeishuSetupService } from './service.ts'

export {
  BRIDGE_SETTINGS_NAMESPACE, BridgeSettingsSchema, FeishuSettingsSchema, FEISHU_SETTINGS_DEFAULTS,
  FEISHU_SETTINGS_NAMESPACE, type BridgeSettings, type FeishuSettings,
} from './settings.ts'
export {
  FeishuLoginError, FeishuLoginFlow, officialRegisterApp,
  type FeishuLoginOptions, type FeishuRegistration, type RegisterAppPort,
  type RegisterAppRequest, type RegisterAppResult,
} from './login.ts'
export { qrSvgDataUrl, type QrRenderOptions } from './qr.ts'
export { credentialSourceOf, rowStateOf, type FeishuRowProbe } from './status.ts'
export {
  FEISHU_CHANNEL_ROW_ID, FeishuSetupService, type FeishuSetupServiceOptions,
} from './service.ts'
export type * from './types.ts'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'feishu-settings'

/**
 * Mount the Host half: registering the service is what registers the durable
 * `feishu` section, and a composition without a settings provider mounts
 * nothing.
 * @param ctx - Host context of the composed row.
 */
export function apply(ctx: Context): void {
  ctx.inject(['settings'], (settingsCtx) => {
    const loader = settingsCtx.get('loader')
    settingsCtx.plugin(FeishuSetupService, {
      settings: settingsCtx.settings,
      ...(loader === undefined ? {} : { loader }),
    })
  })
}
