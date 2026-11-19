/** Desktop production tools and the editable short-drama Settings page share one plugin row. */
import type { Context } from '@deepseek-ai/cordis'
import { apply as applyDramaSettings, type Config as DramaConfig } from '@deepseek-ai/dsh-drama-settings'

export { Config, name } from '@deepseek-ai/dsh-drama-settings'

/**
 * Use local project metadata and the operator-configured studio on Desktop.
 * @param ctx - Context of the installed short-drama Settings row.
 * @param config - Resolved short-drama settings from the user's profile.
 */
export function apply(ctx: Context, config: DramaConfig): void {
  applyDramaSettings(ctx, { ...config, localProjectOnly: true, standaloneStudioAddress: process.env.MUSE_LOCALMINIDRAMA_URL ?? '' })
}
