/** Creator drafts and original upload identities retained across market panel remounts. */
import { defineStore, type EngineStoreHandle } from '@deepseek-ai/dsh-client-store'
import type { MarketMetadata } from '@deepseek-ai/dsh-muse-market/types'
import type { MarketActions, MarketIdentity, MarketInstallation } from './market-actions.ts'

/** User choices, rather than a duplicate installation or cloud catalog. */
export interface MarketCreatorDraft {
  revision: number
  source: string
  metadata: MarketMetadata
  selectedId: MarketInstallation['release']['id'] | null
  publisher: string
  uploadRequest: { accountId: MarketIdentity['accountId']; key: Parameters<MarketActions['publishDraft']>[2]; releaseId: MarketInstallation['release']['id']; publisherId: MarketIdentity['publishers'][number]['id'] } | null
}
type State = { creator: MarketCreatorDraft }
type Actions = {
  setCreator: (draft: State, value: MarketCreatorDraft) => void
  prepared: (draft: State, revision: number, id: MarketInstallation['release']['id']) => void
  completeUpload: (draft: State, key: NonNullable<MarketCreatorDraft['uploadRequest']>['key']) => void
  discardUpload: (draft: State, key: NonNullable<MarketCreatorDraft['uploadRequest']>['key']) => void
}

/** Create one registration-owned creator view store.
 * @returns A handle whose renderer-owned root instance retains draft choices and retry identities across panel remounts.
 */
export function createMarketViewStore(): EngineStoreHandle<State, Actions> {
  return defineStore({
    init: (): State => ({ creator: { revision: 0, source: '', metadata: { name: '', title: '', description: '', version: '', license: '', category: '', requirements: [], examples: [] }, selectedId: null, publisher: '', uploadRequest: null } }),
    actions: {
      setCreator: (draft, value: MarketCreatorDraft) => { draft.creator = { ...value, revision: draft.creator.revision + 1 } },
      prepared: (draft, revision, id) => {
        if (draft.creator.revision === revision && draft.creator.uploadRequest === null) {
          draft.creator.selectedId = id; ++draft.creator.revision
        }
      },
      completeUpload: (draft, key) => {
        if (draft.creator.uploadRequest?.key === key) { draft.creator.uploadRequest = null; ++draft.creator.revision }
      },
      discardUpload: (draft, key) => {
        if (draft.creator.uploadRequest?.key === key) { draft.creator.uploadRequest = null; ++draft.creator.revision }
      },
    },
  })
}
