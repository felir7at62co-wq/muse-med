/** Host registration for browser conversation preferences. */
import type {} from '@deepseek-ai/dsh-settings'
import type {} from '@deepseek-ai/dsh-host-webserver'
import { HeaderPresentation, HEADER_PRESENTATION_GLOBAL } from './header-presentation.ts'

import type { Volatile, Context } from '@deepseek-ai/cordis'
import type { BusyEnterBehavior } from './submission-settings.ts'
import z from '@deepseek-ai/schemastery'
import { BUSY_ENTER_FIELD } from './submission-settings.ts'

import { ConversationSettingsFields } from './submission-settings.ts'

export {
  BUSY_ENTER_BEHAVIORS, BUSY_ENTER_FIELD, CONVERSATION_SETTINGS_NAMESPACE,
  DEFAULT_BUSY_ENTER_BEHAVIOR, type BusyEnterBehavior, type ConversationSettings,
} from './submission-settings.ts'

/** Runtime preferences projected to the browser. */
export interface Config {
  /** Enter key behavior while a turn is running. */
  busyEnter: Volatile<BusyEnterBehavior>
  /** Standard navigation rows or controls floating over the transcript. */
  headerPresentation: HeaderPresentation
}

/** Live preferences projected to the browser. */
export const Config = z.object({
  busyEnter: ConversationSettingsFields[BUSY_ENTER_FIELD].volatile(),
  headerPresentation: HeaderPresentation,
})

/** Host preferences are consumed through the configuration form projection.
 * @param ctx Plugin context used for optional settings presentation.
 * @param config Validated startup policy and live input preferences.
 */
export function apply(ctx: Context, config: Config = Config({})): void {
  ctx.on('webserver/index-inject', (table) => {
    table.push({ kind: 'global', name: HEADER_PRESENTATION_GLOBAL, value: config.headerPresentation })
  })
  ctx.inject(['settings'], (child) => { child.effect(() => child.settings.configure({ auto: false }, ctx.fiber)) })
}
