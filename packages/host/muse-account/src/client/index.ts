/** Browser entry for the MUSE account Settings page. */

import accountRemote from '@deepseek-ai/dsh-muse-account/remote'
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import { mountMuseAccountSettings } from './mount.ts'

export { inject } from './mount.ts'
export type { MuseAccountInjected, MuseAccountLocaleKey, MuseAccountOutcome, MuseAccountSectionProps } from './mount.ts'

/**
 * Mount the generated Remote contribution and its Settings section.
 * @param ctx - Client context carrying slots, locale, and Remote service.
 * @returns a disposer for both registrations.
 */
export async function apply(ctx: ClientContext): Promise<() => Promise<void>> {
  return await mountMuseAccountSettings(ctx, accountRemote)
}
