/** Plain callbacks over the actual generated local, activation and cloud namespaces. */
import type { ClientRemote } from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@deepseek-ai/dsh-muse-market/remote'
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import type { MarketActions } from './market-actions.ts'

function value<T>(result: RemoteResult<T>): T {
  if (!result.ok) throw result.error
  return result.value
}

/** Adapt the generated result envelopes without replacing Host storage or authority.
 * @param remote - Mounted generated namespace callbacks.
 * @returns Fifteen real operations with their original success values and structured errors.
 */
export function createMarketOperations(remote: Pick<ClientRemote, 'museMarket' | 'museMarketActivation' | 'museMarketCloud'>): MarketActions {
  return {
    sources: async () => value(await remote.museMarket.sources()),
    prepare: async (metadata, source) => value(await remote.museMarket.prepare(metadata, source)),
    installed: async () => value(await remote.museMarket.installed()),
    importPackage: async bytes => value(await remote.museMarket.importPackage(bytes)),
    exportPackage: async id => value(await remote.museMarket.exportPackage(id)),
    removePackage: async (id) =>{  value(await remote.museMarket.removePackage(id)) },
    defaults: async () => value(await remote.museMarketActivation.defaults()),
    setDefault: async request => value(await remote.museMarketActivation.setDefault(request)),
    binding: async request => value(await remote.museMarketActivation.binding(request)),
    catalog: async (q, mine) => value(await remote.museMarketCloud.catalog(q, mine)),
    identity: async () => value(await remote.museMarketCloud.identity()),
    getPublication: async id => value(await remote.museMarketCloud.getPublication(id)),
    publishDraft: async (id, publisher, key) => value(await remote.museMarketCloud.publishDraft(id, publisher, key)),
    installPublication: async (id, sha) => value(await remote.museMarketCloud.installPublication(id, sha)),
    review: async (id, revision, action, note) => value(await remote.museMarketCloud.review(id, revision, action, note)),
  }
}
