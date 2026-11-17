// @vitest-environment jsdom
/** Installation, activation and review retain explicit user choices through failures. */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { bindSnapshotSelector } from '@deepseek-ai/dsh-client-test-runtime'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { brandString } from '@deepseek-ai/dsh-brand'
import { MarketPage, type MarketPageProps } from '../src/client/MarketSection.tsx'
import { MarketPublications } from '../src/client/MarketPublications.tsx'
import { MarketPublicationFilter, MarketResourceCard, MarketResourceDetails } from '../src/client/MarketResource.tsx'
import type { MarketAccess } from '../src/client/market-controller.ts'
import type { MarketActions, MarketDefaultSnapshot, MarketIdentity, MarketTranslate } from '../src/client/market-actions.ts'
import { createMarketViewStore } from '../src/client/market-view-store.ts'
import { marketEn } from '../src/client/market-locales.ts'
import { installation, operations, original, publication } from './discovery-fixtures.client.ts'

const messages: Readonly<Record<string, string>> = marketEn
const t: MarketTranslate = key => messages[key] ?? key
const identity: MarketIdentity = { accountId: brandString<MarketIdentity['accountId']>('c'.repeat(16)),
  publishers: [{ id: publication().publisherId, title: 'Studio' }], admin: true }

beforeEach(() => { localStorage.setItem('dsh.muse-market.guide.v1', 'seen') })
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); localStorage.clear() })

function page(overrides: Partial<MarketActions> = {}, tab: 'discover' | 'installed' | 'publish' = 'installed') {
  const store = createMarketViewStore().create()
  store.actions.setMarketTab(tab)
  const access = createSnapshotStore<MarketAccess>({ revision: 0, identity })
  const reportOutcome = vi.fn(), onOpenCreator = vi.fn()
  const props = { operations: operations({ identity: async () => identity, ...overrides }), reportOutcome,
    isCurrentAccess: () => true, useAccess: bindSnapshotSelector(access), useStore: bindSnapshotSelector(store),
    actions: store.actions, onOpenCreator, onBackMarket: vi.fn(), onOpenPublications: vi.fn(), t } as MarketPageProps
  return { ...render(<MarketPage {...props} />), reportOutcome, onOpenCreator }
}

it('requires confirmation before enabling a version and disabling it affects future chats only', async () => {
  const item = installation(), name = item.release.manifest.skills[0]!.name
  const active: MarketDefaultSnapshot = { revision: 1, defaults: [{ skillName: name, releaseId: item.release.id }] }
  const setDefault = vi.fn<MarketActions['setDefault']>().mockResolvedValueOnce(active)
    .mockResolvedValueOnce({ revision: 2, defaults: [] })
  const view = page({ installed: async () => [item], setDefault })
  await screen.findByRole('heading', { name: item.release.manifest.title })
  fireEvent.click(screen.getByRole('button', { name: marketEn.useVersion }))
  expect(setDefault).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('dialog').querySelector('button[aria-label]')!)
  expect(screen.queryByRole('dialog')).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: marketEn.useVersion }))
  fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: marketEn.confirm }))
  await waitFor(() => { expect(view.reportOutcome).toHaveBeenCalledWith('defaultDone', false) })
  expect(setDefault).toHaveBeenNthCalledWith(1, { skillName: name, expected: null, target: item.release.id })
  expect(screen.getByRole('button', { name: marketEn.remove }).hasAttribute('disabled')).toBe(true)
  fireEvent.click(screen.getByRole('button', { name: marketEn.details }))
  fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: marketEn.disable }))
  fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: marketEn.confirm }))
  await screen.findByRole('button', { name: marketEn.useVersion })
  expect(setDefault).toHaveBeenNthCalledWith(2, { skillName: name, expected: item.release.id, target: null })
})

it.each([true, false])('reports an activation conflict and handles refresh availability %s', async (refreshed) => {
  const item = installation()
  const defaults = vi.fn<MarketActions['defaults']>().mockResolvedValueOnce({ revision: 0, defaults: [] })
  if (refreshed) defaults.mockResolvedValue({ revision: 2, defaults: [] })
  else defaults.mockRejectedValue(new Error('Offline'))
  const view = page({ installed: async () => [item], defaults,
    setDefault: async () => { throw Object.assign(new Error('Default changed'), { details: { code: 'default-conflict' } }) } })
  await screen.findByRole('heading', { name: item.release.manifest.title })
  fireEvent.click(screen.getByRole('button', { name: marketEn.useVersion }))
  fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: marketEn.confirm }))
  await waitFor(() => { expect(view.reportOutcome).toHaveBeenCalledWith('defaultConflict', true) })
  expect(Boolean(screen.queryByRole('dialog'))).toBe(!refreshed)
})

it('imports the complete selected archive, filters it by invocation and removes only that version', async () => {
  const item = installation(), importPackage = vi.fn<MarketActions['importPackage']>().mockResolvedValue(item)
  const removePackage = vi.fn<MarketActions['removePackage']>().mockResolvedValue(undefined)
  const view = page({ importPackage, removePackage })
  await waitFor(() => { expect(screen.queryByRole('status', { name: marketEn.loading })).toBeNull() })
  const input = view.container.querySelector<HTMLInputElement>('input[type="file"]')!
  fireEvent.change(input, { target: { files: [] } })
  expect(importPackage).not.toHaveBeenCalled()
  const file = new File(['bytes'], 'review.zip')
  Object.defineProperty(file, 'arrayBuffer', { value: async () => Uint8Array.of(80, 75, 0, 255).buffer })
  fireEvent.change(input, { target: { files: [file] } })
  await screen.findByRole('heading', { name: item.release.manifest.title })
  expect(importPackage).toHaveBeenCalledWith('UEsA/w==')
  fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'missing-method' } })
  expect(screen.queryByRole('heading', { name: item.release.manifest.title })).toBeNull()
  fireEvent.change(screen.getByRole('searchbox'), { target: { value: item.release.manifest.skills[0]!.name } })
  fireEvent.click(screen.getByRole('button', { name: marketEn.remove }))
  await waitFor(() => { expect(screen.queryByRole('heading', { name: item.release.manifest.title })).toBeNull() })
  expect(removePackage).toHaveBeenCalledWith(item.release.id)
})

it('exports the chosen local archive from both its card and its details', async () => {
  const item = installation(), exportPackage = vi.fn<MarketActions['exportPackage']>()
    .mockResolvedValue({ name: 'review.zip', base64: 'UEsA/w==' })
  const create = vi.fn(() => 'blob:verified-skill'), revoke = vi.fn()
  const BaseURL = URL
  vi.stubGlobal('URL', class extends BaseURL { static override createObjectURL = create; static override revokeObjectURL = revoke })
  const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
  page({ installed: async () => [item], exportPackage })
  await screen.findByRole('heading', { name: item.release.manifest.title })
  fireEvent.click(screen.getByRole('button', { name: marketEn.export }))
  await waitFor(() => { expect(click).toHaveBeenCalledTimes(1) })
  fireEvent.click(screen.getByRole('button', { name: marketEn.details }))
  fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: marketEn.export }))
  await waitFor(() => { expect(click).toHaveBeenCalledTimes(2) })
  expect(exportPackage).toHaveBeenNthCalledWith(1, item.release.id)
  expect(exportPackage).toHaveBeenNthCalledWith(2, item.release.id)
  await waitFor(() => { expect(revoke).toHaveBeenCalledTimes(2) })
})

it('opens activation from local details and finds an original resource dependency', async () => {
  const item = installation(), resource = { ...original(), requiredSkills: ['audio-transcribe'] }
  const catalog = vi.fn<MarketActions['catalog']>().mockResolvedValue([])
  page({ installed: async () => [item], catalog, legacyCatalog: async () => [resource] })
  await screen.findByRole('heading', { name: item.release.manifest.title })
  fireEvent.click(screen.getByRole('button', { name: marketEn.details }))
  fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: marketEn.useVersion }))
  expect(screen.getByRole('dialog', { name: marketEn.useVersion })).toBeTruthy()
  fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: marketEn.close }))
  fireEvent.click(screen.getByRole('tab', { name: marketEn.discover }))
  await screen.findByRole('heading', { name: resource.title })
  fireEvent.click(screen.getByRole('button', { name: marketEn.details }))
  fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'audio-transcribe' }))
  await waitFor(() => { expect(catalog).toHaveBeenLastCalledWith('audio-transcribe', false) })
  expect(screen.getByRole<HTMLInputElement>('searchbox').value).toBe('audio-transcribe')
  expect(screen.queryByRole('dialog')).toBeNull()
})

it('filters published cards by category and opens the independent creator pages', async () => {
  const view = page({ catalog: async () => [publication()], legacyCatalog: async () => [original()] }, 'discover')
  await screen.findByRole('heading', { name: original().title })
  fireEvent.click(screen.getByRole('button', { name: 'Visual' }))
  expect(screen.queryByRole('heading', { name: publication().manifest.title })).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: marketEn.allCategories }))
  expect(screen.getByRole('heading', { name: publication().manifest.title })).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: marketEn.createEntry }))
  fireEvent.click(screen.getByRole('button', { name: marketEn.creatorNewSkill }))
  fireEvent.click(screen.getByRole('button', { name: marketEn.creatorUploadZip }))
  expect(view.onOpenCreator.mock.calls).toEqual([['skill'], ['skill'], ['upload']])
  fireEvent.click(screen.getByRole('button', { name: marketEn.guideEntry }))
  fireEvent.click(screen.getByRole('button', { name: marketEn.guideSkip }))
  expect(localStorage.getItem('dsh.muse-market.guide.v1')).toBe('seen')
})

it('renders complete resource facts and follows a required Skill', () => {
  const value = publication(), onFindSkill = vi.fn()
  render(<MarketResourceDetails detail={{ ...value.manifest, publisher: 'Studio', bytes: value.bytes,
    sha256: value.sha256, requiredSkills: ['audio-transcribe'], requirements: ['Audio'], examples: ['Review episode one.'],
    validation: 'Original audio required' }} actions={[]} onClose={vi.fn()} onFindSkill={onFindSkill} t={t} />)
  expect(screen.getByText('Audio')).toBeTruthy()
  expect(screen.getByText('Review episode one.')).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'audio-transcribe' }))
  expect(onFindSkill).toHaveBeenCalledWith('audio-transcribe')
})

it('distinguishes source identities and dispatches the selected publication filter', () => {
  const item = publication(), select = vi.fn(), filter = vi.fn()
  const result = render(<MarketResourceCard metadata={item.manifest} publisher={item.publisher}
    source={{ kind: 'legacy', id: 'original' }} note="Requires audio" command="/review" t={t}
    actions={[{ id: 'inspect', label: 'Inspect', onSelect: select }]} />)
  expect(result.container.querySelector('article')?.getAttribute('data-market-legacy')).toBe('original')
  expect(screen.getByText('/review')).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'Inspect' }))
  expect(select).toHaveBeenCalledOnce()
  result.rerender(<MarketPublicationFilter value="" onChange={filter} t={t} />)
  for (const status of ['draft', 'pending', 'published', 'rejected', 'withdrawn'] as const) {
    fireEvent.click(screen.getByRole('button', { name: marketEn[`publication.${status}`] }))
    expect(filter).toHaveBeenLastCalledWith(status)
  }
  fireEvent.click(screen.getByRole('button', { name: marketEn.allPublications }))
  expect(filter).toHaveBeenLastCalledWith('')
})

it('shows an empty creator library and offers creation without granting publishing authority', async () => {
  const view = page({}, 'publish')
  await screen.findByText(marketEn.noPublications)
  fireEvent.click(screen.getByRole('button', { name: marketEn['publication.pending'] }))
  expect(screen.getByText(marketEn.noPublicationsHint)).toBeTruthy()
  fireEvent.click(screen.getAllByRole('button', { name: marketEn.creatorNewSkill }).at(-1)!)
  expect(view.onOpenCreator).toHaveBeenCalledWith('skill')
})

it('installs a creator publication through the same verified local flow', async () => {
  const item = publication(), local = installation(item)
  const installPublication = vi.fn<MarketActions['installPublication']>().mockResolvedValue({ publication: item, installation: local })
  const view = page({ catalog: async () => [item], installPublication }, 'publish')
  await screen.findByRole('heading', { name: item.manifest.title })
  fireEvent.click(screen.getByRole('button', { name: marketEn.details }))
  expect(screen.getByRole('dialog', { name: item.manifest.title })).toBeTruthy()
  fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: marketEn.install }))
  await waitFor(() => { expect(installPublication).toHaveBeenCalledWith(item.id, item.sha256) })
  fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: marketEn.close }))
  fireEvent.click(screen.getByRole('button', { name: marketEn.install }))
  await waitFor(() => { expect(view.reportOutcome).toHaveBeenCalledWith('installedDone', false) })
  expect(installPublication).toHaveBeenCalledTimes(2)
})

function reviews(options: { failure?: boolean; readbackFails?: boolean; current?: () => boolean } = {}) {
  const value = { ...publication(), status: 'pending' as const }, onReplace = vi.fn(), reportOutcome = vi.fn()
  const review = vi.fn<MarketActions['review']>().mockImplementation(async (_id, _revision, action, note) => {
    if (options.failure) throw new Error('Response lost')
    return { ...value, revision: 2, status: action === 'reject' ? 'rejected' : 'published', reviewNote: note }
  })
  const getPublication = vi.fn<MarketActions['getPublication']>().mockImplementation(async () => {
    if (options.readbackFails) throw new Error('Offline')
    return { ...value, revision: 2, status: 'published' }
  })
  const onDetails = vi.fn(), onInstall = vi.fn()
  render(<MarketPublications accessRevision={0} isCurrentAccess={options.current ?? (() => true)} items={[value]}
    identity={identity} actions={{ review, getPublication }} busy={false} onReplace={onReplace} onDetails={onDetails}
    onInstall={onInstall} reportOutcome={reportOutcome} t={t} />)
  return { value, review, getPublication, onReplace, reportOutcome, onDetails, onInstall }
}

it('requires a rejection reason and submits its trimmed text exactly once', async () => {
  const view = reviews()
  fireEvent.click(screen.getByRole('button', { name: marketEn.details }))
  fireEvent.click(screen.getByRole('button', { name: marketEn.install }))
  expect(view.onDetails).toHaveBeenCalledWith(view.value)
  expect(view.onInstall).toHaveBeenCalledWith(view.value)
  fireEvent.click(screen.getByRole('button', { name: marketEn['review.reject'] }))
  expect(within(screen.getByRole('dialog')).getByRole('button', { name: marketEn.confirm }).hasAttribute('disabled')).toBe(true)
  fireEvent.change(screen.getByRole('textbox'), { target: { value: '  Missing source files  ' } })
  fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: marketEn.confirm }))
  await waitFor(() => { expect(view.reportOutcome).toHaveBeenCalledWith('reviewDone', false) })
  expect(view.review).toHaveBeenCalledExactlyOnceWith(view.value.id, 1, 'reject', 'Missing source files')
  expect(view.onReplace).toHaveBeenCalledWith(expect.objectContaining({ status: 'rejected', revision: 2 }))
})

it.each([true, false])('reads an uncertain review once without repeating its write (readback failure: %s)', async (readbackFails) => {
  const view = reviews({ failure: true, readbackFails })
  fireEvent.click(screen.getByRole('button', { name: marketEn['review.approve'] }))
  fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: marketEn.confirm }))
  await waitFor(() => { expect(view.reportOutcome).toHaveBeenCalledWith('reviewUnconfirmed', true) })
  expect(view.review).toHaveBeenCalledTimes(1)
  expect(view.getPublication).toHaveBeenCalledExactlyOnceWith(view.value.id)
  expect(view.onReplace).toHaveBeenCalledTimes(readbackFails ? 0 : 1)
})

it('does not publish the result of a review after account access changes', async () => {
  const pending = Promise.withResolvers<Awaited<ReturnType<MarketActions['review']>>>()
  let current = true
  const view = reviews({ current: () => current })
  view.review.mockImplementation(() => pending.promise)
  fireEvent.click(screen.getByRole('button', { name: marketEn['review.approve'] }))
  fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: marketEn.confirm }))
  fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: marketEn.close }))
  expect(screen.getByRole('dialog')).toBeTruthy()
  current = false
  await act(async () => { pending.resolve({ ...view.value, status: 'published', revision: 2 }); await pending.promise })
  expect(view.onReplace).not.toHaveBeenCalled()
  expect(view.reportOutcome).not.toHaveBeenCalled()
})

it('contains synchronous storage failures so the two public catalogs still load', async () => {
  page({ installed: () => { throw new Error('Storage denied') }, catalog: async () => [publication()],
    legacyCatalog: async () => [original()] }, 'discover')
  await screen.findByRole('heading', { name: original().title })
  expect(screen.getByRole('heading', { name: publication().manifest.title })).toBeTruthy()
  expect(screen.getByRole('alert').textContent).toBe(marketEn.readFailedRetained)
})

it('rejects an invalid local invocation without reporting a successful default change', async () => {
  const item = installation(), invalid = { ...item, release: { ...item.release,
    manifest: { ...item.release.manifest, skills: [] } } }
  const setDefault = vi.fn<MarketActions['setDefault']>()
  const view = page({ installed: async () => [invalid], setDefault })
  await screen.findByRole('heading', { name: item.release.manifest.title })
  fireEvent.click(screen.getByRole('button', { name: marketEn.useVersion }))
  fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: marketEn.confirm }))
  await waitFor(() => { expect(view.reportOutcome).toHaveBeenCalledWith('invalidPackage', true) })
  expect(view.reportOutcome).not.toHaveBeenCalledWith('defaultDone', false)
  expect(setDefault).not.toHaveBeenCalled()
})

it('submits search text to both catalogs and ignores a response after the page is unmounted', async () => {
  const pending = Promise.withResolvers<Awaited<ReturnType<MarketActions['legacyCatalog']>>>()
  const catalog = vi.fn<MarketActions['catalog']>().mockResolvedValue([publication()])
  const legacyCatalog = vi.fn<MarketActions['legacyCatalog']>().mockResolvedValueOnce([original()]).mockImplementation(() => pending.promise)
  const view = page({ catalog, legacyCatalog }, 'discover')
  await screen.findByRole('heading', { name: original().title })
  fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'storyboard' } })
  fireEvent.click(screen.getByRole('button', { name: marketEn.search }))
  await waitFor(() => { expect(legacyCatalog).toHaveBeenLastCalledWith('storyboard') })
  expect(catalog).toHaveBeenLastCalledWith('storyboard', false)
  view.unmount()
  await act(async () => { pending.resolve([]); await pending.promise })
  expect(view.reportOutcome).not.toHaveBeenCalled()
})

it('ignores failed public catalog and identity reads after the page closes', async () => {
  const current = Promise.withResolvers<MarketIdentity>()
  const publications = Promise.withResolvers<Awaited<ReturnType<MarketActions['catalog']>>>()
  const originals = Promise.withResolvers<Awaited<ReturnType<MarketActions['legacyCatalog']>>>()
  const view = page({ identity: () => current.promise, catalog: () => publications.promise,
    legacyCatalog: () => originals.promise }, 'discover')
  await act(async () => undefined)
  view.unmount()
  await act(async () => {
    current.reject(new Error('Account offline')); publications.reject(new Error('Catalog offline')); originals.reject(new Error('Originals offline'))
    await Promise.allSettled([current.promise, publications.promise, originals.promise])
  })
  expect(view.reportOutcome).not.toHaveBeenCalled()
})

it('does not insert a completed details download into an unmounted view', async () => {
  const value = publication(), item = installation(value)
  const pending = Promise.withResolvers<Awaited<ReturnType<MarketActions['installPublication']>>>()
  const installPublication = vi.fn<MarketActions['installPublication']>().mockImplementation(() => pending.promise)
  const view = page({ installed: async () => [], catalog: async () => [value], installPublication }, 'discover')
  await screen.findByRole('heading', { name: value.manifest.title })
  fireEvent.click(screen.getByRole('button', { name: marketEn.details }))
  fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: marketEn.install }))
  await waitFor(() => { expect(installPublication).toHaveBeenCalledOnce() })
  view.unmount()
  await act(async () => { pending.resolve({ publication: value, installation: item }); await pending.promise })
  expect(view.container.textContent).toBe('')
})

it('keeps distant scrolling stable and retries the creator identity after a network failure', async () => {
  const current = vi.fn<MarketActions['identity']>().mockRejectedValueOnce(new Error('Offline')).mockResolvedValue(identity)
  const view = page({ identity: current }, 'publish')
  await screen.findByText(marketEn.cloudUnavailable)
  fireEvent.click(screen.getByRole('button', { name: marketEn.retry }))
  await waitFor(() => { expect(screen.queryByText(marketEn.cloudUnavailable)).toBeNull() })
  expect(current).toHaveBeenCalledTimes(2)
  const container = view.container.querySelector('[data-muse-skill-market]')!
  Object.defineProperties(container, { scrollHeight: { value: 3000 }, clientHeight: { value: 700 }, scrollTop: { value: 0 } })
  fireEvent.scroll(container)
  expect(screen.getByText(marketEn.noPublications)).toBeTruthy()
})

it('replaces the selected publication after approval and filters by its new status', async () => {
  const item = { ...publication(), status: 'pending' as const }
  page({ catalog: async () => [item], review: async () => ({ ...item, status: 'published', revision: 2 }) }, 'publish')
  await screen.findByRole('heading', { name: item.manifest.title })
  fireEvent.click(screen.getByRole('button', { name: marketEn['review.approve'] }))
  fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: marketEn.confirm }))
  await waitFor(() => { expect(screen.queryByRole('dialog')).toBeNull() })
  fireEvent.click(screen.getByRole('button', { name: marketEn['publication.pending'] }))
  expect(screen.getByText(marketEn.noPublications)).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: marketEn['publication.published'] }))
  expect(screen.getByRole('heading', { name: item.manifest.title })).toBeTruthy()
})

it('closes an unsubmitted review and refuses a submission whose access is already stale', async () => {
  let current = true
  const view = reviews({ current: () => current })
  fireEvent.click(screen.getByRole('button', { name: marketEn['review.approve'] }))
  fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: marketEn.close }))
  expect(screen.queryByRole('dialog')).toBeNull()
  expect(view.review).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: marketEn['review.approve'] }))
  current = false
  fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: marketEn.confirm }))
  await act(async () => undefined)
  expect(view.review).not.toHaveBeenCalled()
})

it.each([false, true])('does not reconcile an uncertain review after access revocation (%s)', async (afterFailure) => {
  let current = true
  const view = reviews({ current: () => current })
  view.review.mockImplementation(async () => {
    if (afterFailure) current = false
    throw Object.assign(new Error('Access changed'), { code: 'muse-market/access-changed' })
  })
  fireEvent.click(screen.getByRole('button', { name: marketEn['review.approve'] }))
  fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: marketEn.confirm }))
  await waitFor(() => { expect(view.review).toHaveBeenCalledOnce() })
  await act(async () => undefined)
  expect(view.getPublication).not.toHaveBeenCalled()
  expect(view.reportOutcome).not.toHaveBeenCalled()
})

it('does not apply private readback if access changes while it is pending', async () => {
  let current = true
  const pending = Promise.withResolvers<Awaited<ReturnType<MarketActions['getPublication']>>>()
  const view = reviews({ failure: true, current: () => current })
  view.getPublication.mockImplementation(() => pending.promise)
  fireEvent.click(screen.getByRole('button', { name: marketEn['review.approve'] }))
  fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: marketEn.confirm }))
  await waitFor(() => { expect(view.getPublication).toHaveBeenCalledOnce() })
  current = false
  await act(async () => { pending.resolve(view.value); await pending.promise })
  expect(view.onReplace).not.toHaveBeenCalled()
  expect(view.reportOutcome).not.toHaveBeenCalled()
})

it.each(['draft', 'rejected', 'published'] as const)('offers owner actions for %s without administrator access', async (status) => {
  const value = { ...publication(), status }, review = vi.fn<MarketActions['review']>()
    .mockResolvedValue({ ...publication(), status: status === 'published' ? 'withdrawn' : 'pending', revision: 2 })
  const onReplace = vi.fn()
  render(<MarketPublications accessRevision={0} isCurrentAccess={() => true} items={[value]} identity={{ ...identity, admin: false }}
    actions={{ review, getPublication: async () => value }} busy={false} onReplace={onReplace} onDetails={vi.fn()}
    onInstall={vi.fn()} reportOutcome={vi.fn()} t={t} />)
  expect(screen.queryByRole('button', { name: marketEn['review.approve'] })).toBeNull()
  const action = status === 'published' ? 'withdraw' : 'submit'
  fireEvent.click(screen.getByRole('button', { name: marketEn[`review.${action}`] }))
  fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: marketEn.confirm }))
  await waitFor(() => { expect(onReplace).toHaveBeenCalledOnce() })
  expect(review).toHaveBeenCalledExactlyOnceWith(value.id, 1, action, '')
})
