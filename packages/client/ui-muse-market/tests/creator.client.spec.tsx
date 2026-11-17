// @vitest-environment jsdom
/** Creator edits, imported previews and retained upload identities use the real view store. */
import { useState } from 'react'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { bindSnapshotSelector } from '@deepseek-ai/dsh-client-test-runtime'
import { parseMarketAccountId, parseMarketPublisherId, parseMarketUploadRequestId } from '@deepseek-ai/dsh-muse-market/cloud-values'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { MarketSourceId } from '@deepseek-ai/dsh-muse-market/types'
import { MarketCreatorPage } from '../src/client/MarketCreatorPage.tsx'
import { SkillPortrait } from '../src/client/SkillPortrait.tsx'
import { createMarketViewStore, type MarketCreatorDraft } from '../src/client/market-view-store.ts'
import { marketEn } from '../src/client/market-locales.ts'
import type { MarketActions, MarketIdentity, MarketInstallation } from '../src/client/market-actions.ts'
import { installation, operations, publication } from './discovery-fixtures.client.ts'
import { marketTranslate } from './market-fixtures.client.ts'

afterEach(cleanup)

const publisherId = parseMarketPublisherId('b'.repeat(32))
const identity: MarketIdentity = { accountId: parseMarketAccountId('c'.repeat(16)), admin: false,
  publishers: [{ id: publisherId, title: 'Creator team' }] }

function mount(actions: MarketActions, initial: Partial<MarketCreatorDraft> = {}, local: MarketInstallation[] = [],
  sources: Awaited<ReturnType<MarketActions['sources']>> = {
    complete: true, skills: [{ name: 'muse-storyboard-checklist', description: 'Review storyboard delivery' }, { name: 'anime-3d-assets', description: 'Create 3D assets' }],
  }) {
  const store = createMarketViewStore().create()
  store.actions.setCreator({ ...store.getSnapshot().creator, source: 'muse-storyboard-checklist', publisher: publisherId,
    metadata: { name: 'review-alias', title: 'Delivery review', description: 'Review shots before delivery', category: 'Review',
      version: '1.0.0', license: 'MIT', requirements: [], examples: [] }, ...initial })
  const useStore = bindSnapshotSelector(store), reportOutcome = vi.fn(), onPublished = vi.fn()
  function Harness({ currentIdentity }: { currentIdentity: MarketIdentity }) {
    const draft = useStore(state => state.creator)
    const [installed, setInstalled] = useState(local)
    return <MarketCreatorPage actions={actions} draft={draft} setDraft={store.actions.setCreator}
      prepared={store.actions.prepared} completeUpload={store.actions.completeUpload} discardUpload={store.actions.discardUpload}
      sources={sources}
      identity={currentIdentity} installed={installed}
      onPrepared={(item) => { setInstalled(previous => [...previous.filter(row => row.release.id !== item.release.id), item]) }}
      onPublished={onPublished} reportOutcome={reportOutcome} t={marketTranslate} />
  }
  const view = render(<Harness currentIdentity={identity} />)
  return { ...view, store, reportOutcome, onPublished,
    changeIdentity: (currentIdentity: MarketIdentity) => { view.rerender(<Harness currentIdentity={currentIdentity} />) } }
}

it('prepares a downloaded market source by its archive id and matches the portrait by its actual Skill name', async () => {
  const sourceId = brandString<MarketSourceId>('market:' + 'a'.repeat(64))
  const prepare = vi.fn<MarketActions['prepare']>(async (metadata) => {
    const item = publication('anime-3d-assets', '0.1.1')
    return installation({ ...item, manifest: { ...item.manifest, ...metadata } })
  })
  const view = mount(operations({ prepare }), {}, [], { complete: true, skills: [
    { name: 'muse-storyboard-checklist', description: 'Review storyboard delivery' },
    { name: 'anime-3d-assets', description: 'Create 3D assets', sourceId, version: '0.1.1' },
  ] })
  const option = screen.getByRole('option', { name: 'anime-3d-assets · 0.1.1' })
  expect(option.getAttribute('value')).toBe(sourceId)
  fireEvent.change(screen.getByRole('combobox', { name: name => name.startsWith(marketEn.source) }),
    { target: { value: sourceId } })
  expect(view.store.getSnapshot().creator.source).toBe(sourceId)
  const preview = screen.getByRole('complementary', { name: marketEn.creatorPreviewTitle })
  expect(preview.querySelector('[data-market-portrait]')?.getAttribute('data-market-portrait')).toBe('3d-asset-artist')
  expect(within(preview).getByText('anime-3d-assets')).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: marketEn.prepare }))
  await screen.findByText(marketEn.creatorPreparedTitle)
  expect(prepare).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ presetPortrait: '3d-asset-artist' }), sourceId)
  expect(preview.querySelector('[data-market-portrait]')?.getAttribute('data-market-portrait')).toBe('3d-asset-artist')
})

it('invalidates the prepared archive when its author metadata or source changes', async () => {
  const prepare = vi.fn<MarketActions['prepare']>(async (metadata, source) => {
    const item = publication()
    return installation({ ...item, manifest: { ...item.manifest, ...metadata,
      skills: [{ name: source, path: `skills/${source}/SKILL.md` }] } })
  })
  const view = mount(operations({ prepare }))
  const preview = screen.getByRole('complementary', { name: marketEn.creatorPreviewTitle })
  expect(preview.querySelector('[data-market-portrait]')?.getAttribute('data-market-portrait')).toBe('storyboard-reviewer')
  fireEvent.click(screen.getByRole('button', { name: marketEn.prepare }))
  await screen.findByText(marketEn.creatorPreparedTitle)
  expect(view.store.getSnapshot().creator.selectedId).not.toBeNull()
  expect(prepare).toHaveBeenCalledWith(expect.objectContaining({ presetPortrait: 'storyboard-reviewer' }), 'muse-storyboard-checklist')
  fireEvent.change(screen.getByLabelText(marketEn['field.title']), { target: { value: 'Updated review' } })
  expect(view.store.getSnapshot().creator.selectedId).toBeNull()
  expect(screen.queryByRole('button', { name: marketEn.upload })).toBeNull()
  expect(within(preview).getByRole('heading', { name: 'Updated review' })).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: marketEn.prepare }))
  await screen.findByText(marketEn.creatorPreparedTitle)
  expect(prepare).toHaveBeenLastCalledWith(expect.objectContaining({ title: 'Updated review' }), 'muse-storyboard-checklist')
  fireEvent.change(screen.getByRole('combobox', { name: name => name.startsWith(marketEn.source) }),
    { target: { value: 'anime-3d-assets' } })
  expect(view.store.getSnapshot().creator.selectedId).toBeNull()
  expect(screen.queryByRole('button', { name: marketEn.upload })).toBeNull()
  expect(preview.querySelector('[data-market-portrait]')?.getAttribute('data-market-portrait')).toBe('3d-asset-artist')
})

it('previews the imported ZIP metadata and character, then follows the selected local package', async () => {
  const item = publication('review-alias')
  const imported = installation({ ...item, manifest: { ...item.manifest, title: 'Imported delivery review',
    description: 'Imported shot and asset checks', skills: [{ name: 'muse-storyboard-checklist', path: 'skills/review/SKILL.md' }] } })
  const other = installation(publication('anime-3d-assets'), 'd'.repeat(64))
  const importPackage = vi.fn<MarketActions['importPackage']>(async () => imported)
  const bound = { ...imported, release: { ...imported.release, id: brandString<MarketInstallation['release']['id']>('e'.repeat(64)), sha256: 'e'.repeat(64), manifest: { ...imported.release.manifest, presetPortrait: 'storyboard-reviewer' } } }
  const preparedOther = { ...other, release: { ...other.release, id: brandString<MarketInstallation['release']['id']>('f'.repeat(64)), sha256: 'f'.repeat(64), manifest: { ...other.release.manifest, presetPortrait: '3d-asset-artist' } } }
  const prepareUpload = vi.fn<MarketActions['prepareUpload']>(async id => id === imported.release.id ? bound : preparedOther)
  const view = mount(operations({ importPackage, prepareUpload }), {}, [other])
  fireEvent.click(screen.getByRole('button', { name: marketEn.creatorUploadZip }))
  const file = new File([Uint8Array.of(80, 75, 3, 4)], 'review.zip', { type: 'application/zip' })
  Object.defineProperty(file, 'arrayBuffer', { value: async () => Uint8Array.of(80, 75, 3, 4).buffer })
  fireEvent.change(screen.getByLabelText(marketEn.import), { target: { files: [file] } })
  await screen.findByText(marketEn.creatorPreparedTitle)
  expect(importPackage).toHaveBeenCalledWith('UEsDBA==')
  expect(view.store.getSnapshot().creator.selectedId).toBe(bound.release.id)
  expect(prepareUpload).toHaveBeenCalledWith(imported.release.id, 'storyboard-reviewer')
  const preview = screen.getByRole('complementary', { name: marketEn.creatorPreviewTitle })
  expect(within(preview).getByRole('heading', { name: imported.release.manifest.title })).toBeTruthy()
  expect(within(preview).getByText(imported.release.manifest.description)).toBeTruthy()
  const publicCard = render(<SkillPortrait metadata={imported.release.manifest} />)
  expect(preview.querySelector('img')?.getAttribute('src')).toBe(publicCard.container.querySelector('img')?.getAttribute('src'))
  expect(preview.querySelector('[data-market-portrait]')?.getAttribute('data-market-portrait')).toBe('storyboard-reviewer')
  fireEvent.change(screen.getByLabelText(marketEn.chooseLocal), { target: { value: other.release.id } })
  await waitFor(() => { expect(view.store.getSnapshot().creator.selectedId).toBe(preparedOther.release.id) })
  expect(preview.querySelector('[data-market-portrait]')?.getAttribute('data-market-portrait')).toBe('3d-asset-artist')
})

it('locks edits for an uncertain upload and retries its original key only under the original account', async () => {
  const selected = installation()
  const request = { key: parseMarketUploadRequestId('retained-upload-key'), releaseId: selected.release.id,
    publisherId, accountId: identity.accountId }
  const publishDraft = vi.fn<MarketActions['publishDraft']>().mockRejectedValueOnce(new Error('Connection interrupted'))
    .mockResolvedValue(publication())
  const view = mount(operations({ publishDraft }), { selectedId: selected.release.id, uploadRequest: request }, [selected])
  expect(screen.getByRole('button', { name: marketEn.creatorUploadZip }).hasAttribute('disabled')).toBe(true)
  expect(screen.getByLabelText(marketEn['field.title']).hasAttribute('disabled')).toBe(true)
  expect(screen.getByRole('combobox', { name: name => name.startsWith(marketEn.source) }).hasAttribute('disabled')).toBe(true)
  const before = view.store.getSnapshot().creator
  fireEvent.click(screen.getByRole('button', { name: marketEn.creatorUploadZip }))
  expect(view.store.getSnapshot().creator).toBe(before)
  fireEvent.click(screen.getByRole('button', { name: marketEn.retryUpload }))
  await waitFor(() => { expect(view.reportOutcome).toHaveBeenCalledWith('cloudUnavailable', true) })
  expect(view.store.getSnapshot().creator.uploadRequest).toEqual(request)
  view.changeIdentity({ ...identity, accountId: parseMarketAccountId('e'.repeat(16)) })
  const forbiddenRetry = screen.getByRole('button', { name: marketEn.retryUpload })
  expect(forbiddenRetry.hasAttribute('disabled')).toBe(true)
  fireEvent.click(forbiddenRetry)
  expect(publishDraft).toHaveBeenCalledTimes(1)
  view.changeIdentity(identity)
  fireEvent.click(screen.getByRole('button', { name: marketEn.retryUpload }))
  await waitFor(() => { expect(view.onPublished).toHaveBeenCalledOnce() })
  expect(publishDraft.mock.calls).toEqual([
    [selected.release.id, publisherId, request.key], [selected.release.id, publisherId, request.key],
  ])
  expect(view.store.getSnapshot().creator.uploadRequest).toBeNull()
})
