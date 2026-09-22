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
import { DRAMA_SETTINGS_NAMESPACE, DramaSettingsSchema } from './settings.ts'

export {
  DEFAULT_BGM_DIR, DEFAULT_DELIVERY_SPEC, DEFAULT_JIANYING_DRAFT_DIR, DELIVERY_SPEC_FIELD,
  DRAMA_SETTINGS_DEFAULTS, DRAMA_SETTINGS_NAMESPACE, DramaSettingsSchema,
} from './settings.ts'
export type { DramaDeliverySpec, DramaSettings, DramaSettingsField } from './settings.ts'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'drama-settings'

/**
 * Register the durable short-drama section, when a settings provider is
 * composed.
 *
 * The registration is an effect on this row's fiber: unloading the row removes
 * the namespace, and a stored section that no longer satisfies the schema warns
 * and keeps the last good value rather than stranding the page.
 * @param ctx - Host context that may acquire the settings service.
 */
export function apply(ctx: Context): void {
  ctx.inject(['settings'], (settingsCtx) => {
    settingsCtx.settings.register(DRAMA_SETTINGS_NAMESPACE, DramaSettingsSchema)
  })
}
