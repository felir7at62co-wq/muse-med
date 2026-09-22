/** Browser entry binding the generated `jubianToken` Remote artifact to its Settings page. */

import jubianTokenRemote from '@deepseek-ai/dsh-tool-jubian/remote'
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import { mountJubianTokenSettings } from './mount.ts'

export { inject } from './mount.ts'
export type {
  JubianLocaleKey,
  JubianTokenInjected,
  JubianTokenOutcome,
  JubianTokenSectionProps,
  JubianTokenStatus,
} from './mount.ts'

/**
 * Mount the generated token Remote contribution and the Settings page over it.
 * @param ctx - Client context carrying the slot registry, locale, and Remote service.
 * @returns a disposer that removes the page registrations and the namespace.
 */
export async function apply(ctx: ClientContext): Promise<() => Promise<void>> {
  return await mountJubianTokenSettings(ctx, jubianTokenRemote)
}
