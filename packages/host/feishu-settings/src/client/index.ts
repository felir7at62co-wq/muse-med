/** Browser entry binding the generated `feishuSetup` Remote artifact to its Settings page. */

import feishuSetupRemote from '@deepseek-ai/dsh-feishu-settings/remote'
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import { mountFeishuSettings } from './mount.ts'

export { inject } from './mount.ts'
export type { FeishuLocaleKey, FeishuOutcome, FeishuSectionProps, FeishuSetupInjected } from './mount.ts'

/**
 * Mount the generated setup Remote contribution and the Settings page over it.
 * @param ctx - Client context carrying the slot registry, locale, and Remote service.
 * @returns a disposer that removes the page registrations and the namespace.
 */
export async function apply(ctx: ClientContext): Promise<() => Promise<void>> {
  return await mountFeishuSettings(ctx, feishuSetupRemote)
}
