/** Publish configured workbench addresses to the Muse renderer. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import { Config, studioUrl } from './config.ts'
import { STUDIO_URL_GLOBAL } from './page.ts'

export { Config }

/**
 * Add the configured Jingliu studio to the application bootstrap.
 * @param ctx - Host context collecting public page fields.
 * @param config - Jingliu studio origin.
 */
export function apply(ctx: Context, config: Config): void {
  const studio = studioUrl(config.studioOrigin)
  ctx.on('webserver/index-inject', (table) => {
    if (studio) table.push({ kind: 'global', name: STUDIO_URL_GLOBAL, value: studio })
  })
}
