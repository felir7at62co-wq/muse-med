/**
 * Short-drama settings: one plugin row that owns the `drama` settings namespace
 * for both halves of the GUI.
 *
 * The Host half is this module. It registers {@link DramaSettingsSchema} with
 * the settings service and nothing else: the durable values of the short-drama
 * pipeline — the delivery and draft directories, the delivery spec and the BGM
 * library — live in the DSH settings document, so the Settings page and every
 * future reader (the renderer, the delivery step) resolve the same section
 * through one seam.
 *
 * The row publishes no service and reads none: `settings` is acquired through
 * `ctx.inject`, so a composition without a settings provider simply mounts
 * nothing, and the browser half reports the namespace as unavailable instead of
 * inventing a value.
 *
 * @module @deepseek-ai/dsh-drama-settings
 */

import type { Context } from '@deepseek-ai/cordis'
// Type-only: resolves the `settings` service and its Context merge.
import type {} from '@deepseek-ai/dsh-settings'
import { DramaSettingsSchema } from './settings.ts'

export {
  DEFAULT_BGM_DIR, DEFAULT_DELIVERY_SPEC, DEFAULT_JIANYING_DRAFT_DIR, DELIVERY_SPEC_FIELD,
  DRAMA_SETTINGS_DEFAULTS, DRAMA_SETTINGS_NAMESPACE, DramaSettingsSchema,
} from './settings.ts'
export type { DramaDeliverySpec, DramaSettings, DramaSettingsField } from './settings.ts'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'drama-settings'

/**
 * The durable short-drama section as this row's composition config.
 *
 * The settings service builds one namespace per owned entry from that entry's
 * own `Config` and the values the profile document stores for it, so this export
 * is what puts {@link DramaSettingsSchema} behind the `drama-settings`
 * namespace; the schema's defaults are the values an unconfigured deployment
 * reads.
 */
export const Config = DramaSettingsSchema

/**
 * Mark this row as one that ships its own Settings page, when a settings
 * provider is composed.
 *
 * The automatic form is suppressed because the browser half renders the same
 * section explicitly: leaving `auto` on would expose the namespace twice, once
 * through the page and once through the generated form. The registration is an
 * effect on this row's fiber, so a late-loading or replaced Settings service
 * adopts the policy and unloading the row removes it.
 * @param ctx - Host context that may acquire the settings service.
 */
export function apply(ctx: Context): void {
  ctx.inject(['settings'], (settingsCtx) => {
    settingsCtx.effect(() => settingsCtx.settings.configure({ auto: false }, ctx.fiber))
  })
}
