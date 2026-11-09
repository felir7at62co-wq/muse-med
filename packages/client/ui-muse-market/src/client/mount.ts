/** Independent registration of the actual market Remote contribution and its UI. */
import type { Context } from '@deepseek-ai/cordis'
import type { TypertRemoteContribution } from '@deepseek-ai/dsh-typert-protocol'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import { createMarketOperations } from './market-remote.ts'
import { MarketController } from './market-controller.ts'
import { registerMuseMarket } from './market-registration.tsx'

async function registerMarket(ctx: Context): Promise<() => Promise<void>> {
  const controller = new MarketController(createMarketOperations(ctx.remote))
  const off = [
    ctx.on('connection/reset', () => { controller.invalidateAccess() }),
    ctx.remote.$on('muse-account/session-changed', () => { controller.invalidateAccess() }),
    ctx.remote.$on('muse-market/inventory-changed', () => { controller.invalidateInventory() }),
    ctx.remote.$on('muse-market/defaults-changed', () => { controller.invalidateInventory() }),
  ]
  let disposeUI: (() => Promise<void>) | undefined
  const dispose = async (): Promise<void> => {
    controller.dispose(); for (const stop of off) stop()
    await disposeUI?.()
  }
  try {
    disposeUI = await registerMuseMarket(ctx, controller.operations, controller.access, revision => controller.isCurrentAccess(revision))
  }
  catch (error) { await dispose(); throw error }
  return dispose
}

/** Mount local management independently of optional cloud availability.
 * @param ctx - Market plugin's own browser scope.
 * @param contribution - Actual generated local, activation and cloud descriptors.
 * @returns Cleanup for the market UI and its traced namespace scope, then its Remote contribution.
 */
export async function mountMuseMarket(ctx: Context, contribution: TypertRemoteContribution): Promise<() => Promise<void>> {
  const disposeRemote = await ctx.remote.$mount(contribution)
  const section = ctx.inject(['remote.museMarket', 'remote.museMarketActivation', 'remote.museMarketCloud'], registerMarket)
  try { await section }
  catch (error) {
    try { await section.dispose() } finally { await disposeRemote() }
    throw error
  }
  return async () => {
    try { await section.dispose() } finally { await disposeRemote() }
  }
}
