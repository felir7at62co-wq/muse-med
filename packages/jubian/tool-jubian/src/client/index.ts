/** Browser entry binding the generated Jubian Remote artifact to credential and recovery settings. */

import jubianTokenRemote from '@deepseek-ai/dsh-tool-jubian/remote'
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import { EPISODE_UI_CONFIG_GLOBAL, EpisodeUiConfig } from '../episode-ui-config.ts'
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
 * Mount the generated Jubian Remote contribution and the credential and recovery Settings page.
 * @param ctx - Client context carrying the slot registry, locale, and Remote service.
 * @returns a disposer that removes the page registrations and the namespace.
 */
export async function apply(ctx: ClientContext): Promise<() => Promise<void>> {
  const page = globalThis as Partial<Record<typeof EPISODE_UI_CONFIG_GLOBAL, unknown>>
  const config = EpisodeUiConfig.parse(page[EPISODE_UI_CONFIG_GLOBAL] ?? {})
  return await mountJubianTokenSettings(ctx, jubianTokenRemote, config.episodePollIntervalMs)
}
