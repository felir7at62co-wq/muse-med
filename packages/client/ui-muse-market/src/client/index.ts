/** Browser entry for the optional Skill market. */
import type { Context } from '@deepseek-ai/cordis'
import marketRemote from '@deepseek-ai/dsh-muse-market/remote'
import { mountMuseMarket } from './mount.ts'
export const inject = ['slots', 'locale', 'remote']
/** Mount the independent market UI.
 * @param ctx - Browser services; account presentation is owned by another plugin.
 * @returns Disposer for market registrations and its generated Remote contribution.
 */
export async function apply(ctx: Context): Promise<() => Promise<void>> { return await mountMuseMarket(ctx, marketRemote) }
