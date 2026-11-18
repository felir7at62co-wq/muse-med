/** Publish the Jingliu document address to a configured Muse application. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import { Config, studioUrl } from './config.ts'
import { STUDIO_URL_GLOBAL } from './page.ts'

export { Config }

/**
 * Add the configured ShotFlow page to the application bootstrap.
 * @param ctx - Host context collecting public page fields.
 * @param config - Dedicated studio origin.
 */
export function apply(ctx: Context, config: Config): void {
  const url = studioUrl(config.studioOrigin)
  if (url) ctx.on('webserver/index-inject', (table) => {
    table.push({ kind: 'global', name: STUDIO_URL_GLOBAL, value: url })
  })
}
