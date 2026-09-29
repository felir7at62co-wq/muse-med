/** Public Muse feedback destination for the account Settings client. */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import { FeedbackConfig, FEEDBACK_CONFIG_GLOBAL } from './feedback-config.ts'

/** Validate the product feedback page before mounting the client. */
export const Config = FeedbackConfig

/**
 * Publish the feedback destination without account credentials.
 * @param ctx - Host page initialization events.
 * @param config - Validated product feedback URL.
 */
export function apply(ctx: Context, config: FeedbackConfig): void {
  ctx.on('webserver/index-inject', (table) => {
    table.push({ kind: 'global', name: FEEDBACK_CONFIG_GLOBAL, value: config })
  })
}
