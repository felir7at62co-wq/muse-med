/** Creator operations retain user edits and the identity of an unresolved upload. */
import { expect, it } from 'vitest'
import { brandString } from '@deepseek-ai/dsh-brand'
import { parseMarketAccountId, parseMarketPublisherId, parseMarketUploadRequestId } from '@deepseek-ai/dsh-muse-market/cloud-values'
import type { MarketReleaseId } from '@deepseek-ai/dsh-muse-market/types'
import { createMarketViewStore, type MarketCreatorDraft } from '../src/client/market-view-store.ts'

const firstRelease = brandString<MarketReleaseId>('a'.repeat(64))
const secondRelease = brandString<MarketReleaseId>('b'.repeat(64))
function attempt(key: string): NonNullable<MarketCreatorDraft['uploadRequest']> {
  return { key: parseMarketUploadRequestId(key), releaseId: firstRelease,
    accountId: parseMarketAccountId('c'.repeat(16)), publisherId: parseMarketPublisherId('d'.repeat(32)) }
}

it('does not select an older preparation result over a newer form edit', () => {
  const store = createMarketViewStore().create()
  const initial = store.getSnapshot().creator
  store.actions.setCreator({ ...initial, metadata: { ...initial.metadata, title: 'New author title' } })
  store.actions.prepared(initial.revision, firstRelease)
  expect(store.getSnapshot().creator).toMatchObject({ selectedId: null, metadata: { title: 'New author title' } })
})

it('keeps an unresolved attempt when an earlier preparation finishes', () => {
  const store = createMarketViewStore().create()
  store.actions.setCreator({ ...store.getSnapshot().creator, selectedId: firstRelease, uploadRequest: attempt('original-upload') })
  const current = store.getSnapshot().creator
  store.actions.prepared(current.revision, secondRelease)
  expect(store.getSnapshot().creator).toEqual(current)
})

it('does not let an older completion or discard clear a later upload attempt', () => {
  const store = createMarketViewStore().create()
  store.actions.setCreator({ ...store.getSnapshot().creator, selectedId: firstRelease, uploadRequest: attempt('original-upload') })
  store.actions.discardUpload(parseMarketUploadRequestId('original-upload'))
  store.actions.setCreator({ ...store.getSnapshot().creator, uploadRequest: attempt('later-upload') })
  const later = store.getSnapshot().creator
  store.actions.completeUpload(parseMarketUploadRequestId('original-upload'))
  store.actions.discardUpload(parseMarketUploadRequestId('original-upload'))
  expect(store.getSnapshot().creator).toEqual(later)
})

it('clears a confirmed original attempt without replacing the author draft', () => {
  const store = createMarketViewStore().create()
  const draft = store.getSnapshot().creator
  store.actions.setCreator({ ...draft, source: 'selected-skill', selectedId: firstRelease,
    metadata: { ...draft.metadata, title: 'Retained author draft' }, uploadRequest: attempt('original-upload') })
  store.actions.completeUpload(parseMarketUploadRequestId('original-upload'))
  expect(store.getSnapshot().creator).toMatchObject({ uploadRequest: null, source: 'selected-skill',
    selectedId: firstRelease, metadata: { title: 'Retained author draft' } })
})
