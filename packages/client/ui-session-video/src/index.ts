/** Publish only the validated presentation policy for the Muse video Client. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import { Config, SESSION_VIDEO_CONFIG_GLOBAL } from './config.ts'

export { Config }

/**
 * Add public video timeline settings to the native Web page bootstrap.
 * @param ctx - Host index-injection events for the composed page.
 * @param config - Validated presentation policy; contains no media or credentials.
 */
export function apply(ctx: Context, config: Config): void {
  ctx.on('webserver/index-inject', (table) => {
    table.push({ kind: 'global', name: SESSION_VIDEO_CONFIG_GLOBAL, value: config })
  })
}
