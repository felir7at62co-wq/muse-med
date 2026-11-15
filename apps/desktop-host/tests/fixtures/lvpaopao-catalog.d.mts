/** Source-only production schema collector; the plugin owns its separate strict compiler program. */
import type { Context } from '@deepseek-ai/cordis'

/**
 * Register the production schema without native IO or an executable task.
 * @param ctx - Test-owned tools context.
 * @returns After the real production registration completes.
 */
export function registerLvpaopaoCatalog(ctx: Context): void
