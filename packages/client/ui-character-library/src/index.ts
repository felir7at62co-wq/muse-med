/** Host configuration projection for the read-only character library browser. */
import type { Context, Volatile } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-settings'
import z from '@deepseek-ai/schemastery'
import { syncIntervalField } from './sync-settings.ts'

/** Live synchronization policy projected to browser configuration readers. */
export interface Config {
  /** Delay after a completed catalog read, in milliseconds. */
  readonly syncIntervalMs: Volatile<number>
}

/** Public synchronization policy; no storage credentials are projected. */
export const Config = z.object({ syncIntervalMs: syncIntervalField.volatile() })

/**
 * Expose synchronization settings without adding a generated settings editor.
 * @param ctx - Host context whose settings service publishes volatile fields.
 * @param _config - Validated synchronization fields published through settings.
 */
export function apply(ctx: Context, _config: Config): void {
  ctx.inject(['settings'], (scope) => { scope.effect(() => scope.settings.configure({ auto: false }, ctx.fiber)) })
}
