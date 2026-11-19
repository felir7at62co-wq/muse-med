/** Desktop project editing and the optional local studio share the profile's editable drama settings. */
import type { Context } from '@deepseek-ai/cordis'
import { apply as applyDramaSettings, type Config as DramaConfig } from '@deepseek-ai/dsh-drama-settings'

export { Config, name } from '@deepseek-ai/dsh-drama-settings'

/**
 * Mount the desktop project's tools on the same settings row that owns user edits.
 * @param ctx - Desktop host context.
 * @param config - Resolved settings and optional local studio origin.
 */
export function apply(ctx: Context, config: DramaConfig): void {
  applyDramaSettings(ctx, {
    ...config,
    localProjectOnly: true,
    standaloneStudioAddress: process.env.MUSE_LOCALMINIDRAMA_URL ?? config.standaloneStudioAddress ?? '',
  })
}
