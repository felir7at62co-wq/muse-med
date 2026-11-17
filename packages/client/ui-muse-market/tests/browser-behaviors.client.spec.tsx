// @vitest-environment jsdom
/** Browser navigation, account fences and recovery keep verified resources usable. */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, onTestFinished, vi } from 'vitest'
import { brandString } from '@deepseek-ai/dsh-brand'
import { flushSync } from 'react-dom'
import { MarketBrowserPage } from '../src/client/browser.tsx'
import { MarketBrowserUpload } from '../src/client/MarketBrowserUpload.tsx'
import type { MarketBrowserActions, MarketBrowserPageProps, MarketBrowserView } from '../src/client/market-browser-actions.ts'
import type { MarketIdentity, MarketTranslate } from '../src/client/market-actions.ts'
import { marketEn } from '../src/client/market-locales.ts'
import { original, publication } from './discovery-fixtures.client.ts'

const messages: Readonly<Record<string, string>> = marketEn
const t: MarketTranslate = key => messages[key] ?? key
const actor: MarketIdentity = { accountId: brandString<MarketIdentity['accountId']>('c'.repeat(16)),
  admin: true, publishers: [{ id: publication().publisherId, title: 'Studio' }] }
const unavailable = async (): Promise<never> => { throw new Error('Unexpected operation') }
const failure = (status: number) => Object.assign(new Error('Request refused'), { details: { code: 'cloud-unavailable', status } })
function actions(overrides: Partial<MarketBrowserActions> = {}): MarketBrowserActions {
  return { archiveBytes: 1024, identity: async () => actor, catalog: async () => [], legacyCatalog: async () => [],
    getPublication: unavailable, review: unavailable, previewArchive: unavailable, prepareArchive: unavailable,
    uploadArchive: unavailable, downloadLegacy: unavailable, downloadPublication: unavailable, ...overrides }
}
function page(operations: MarketBrowserActions, initial: MarketBrowserView = 'discover') {
  const reportOutcome = vi.fn(), onNavigate = vi.fn()
  const props: MarketBrowserPageProps = { actions: operations, reportOutcome, onNavigate, view: initial, t }
  const result = render(<MarketBrowserPage {...props} />)
  return { ...result, reportOutcome, onNavigate,
    show: (view: MarketBrowserView) => { result.rerender(<MarketBrowserPage {...props} view={view} />) } }
}
function downloads() {
  const NativeURL = URL
  const create = vi.fn(() => 'blob:verified-package'), revoke = vi.fn()
  vi.stubGlobal('URL', class extends NativeURL { static override createObjectURL = create; static override revokeObjectURL = revoke })
  const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
  return { create, revoke, click }
}
function selectFile(fileName = 'skill.zip', data = Uint8Array.of(80, 75)) {
  const file = new File([data], fileName)
  Object.defineProperty(file, 'arrayBuffer', { value: async () => data.buffer })
  fireEvent.change(screen.getByLabelText(marketEn.browserChooseArchive), { target: { files: [file] } })
}
function upload(overrides: Partial<Parameters<typeof MarketBrowserUpload>[0]> = {}) {
  const item = publication('reviewed-skill'), uploaded = vi.fn(), reportOutcome = vi.fn(), retryIdentity = vi.fn()
  const props: Parameters<typeof MarketBrowserUpload>[0] = {
    actions: actions({ previewArchive: async () => item.manifest,
      prepareArchive: async bytes => ({ bytes, manifest: item.manifest }),
      uploadArchive: async () => ({ ...item, status: 'draft' }) }), identity: actor, identityError: undefined,
    identityLoading: false, retryIdentity, verifyIdentity: async () => actor, onUploaded: uploaded, reportOutcome, t,
    ...overrides,
  }
  const view = render(<MarketBrowserUpload {...props} />)
  return { ...view, props, item, uploaded, reportOutcome, retryIdentity,
    update: (change: Partial<typeof props>) => { view.rerender(<MarketBrowserUpload {...props} {...change} />) } }
}
beforeEach(() => { localStorage.setItem('dsh.muse-market.guide.v1', 'seen') })
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); localStorage.clear() })

it('filters both catalogs, searches by purpose and navigates through independent creator entries', async () => {
  const catalog = vi.fn<MarketBrowserActions['catalog']>().mockResolvedValue([publication()])
  const legacyCatalog = vi.fn<MarketBrowserActions['legacyCatalog']>().mockResolvedValue([original()])
  const view = page(actions({ catalog, legacyCatalog }))
  await screen.findByRole('heading', { name: original().title })
  fireEvent.click(screen.getByRole('button', { name: 'Visual' }))
  expect(screen.queryByRole('heading', { name: publication().manifest.title })).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: marketEn.allCategories }))
  fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'storyboard' } })
  fireEvent.click(screen.getByRole('button', { name: marketEn.search }))
  await waitFor(() => { expect(catalog).toHaveBeenLastCalledWith('storyboard', false) })
  expect(legacyCatalog).toHaveBeenLastCalledWith('storyboard')
  fireEvent.click(screen.getByRole('tab', { name: marketEn.publish }))
  fireEvent.click(screen.getByRole('tab', { name: marketEn.discover }))
  fireEvent.click(screen.getByRole('button', { name: marketEn.creatorUploadZip }))
  expect(view.onNavigate.mock.calls).toEqual([['publish'], ['discover'], ['upload']])
  view.show('upload')
  fireEvent.click(screen.getByRole('button', { name: marketEn.creatorBack }))
  expect(view.onNavigate).toHaveBeenLastCalledWith('publish')
  fireEvent.click(screen.getByRole('button', { name: marketEn.guideEntry }))
  fireEvent.click(screen.getByRole('button', { name: marketEn.guideSkip }))
  expect(screen.queryByRole('dialog')).toBeNull()
})

it('retries only the failed original catalog and retains the published card', async () => {
  const legacyCatalog = vi.fn<MarketBrowserActions['legacyCatalog']>().mockRejectedValueOnce(failure(503)).mockResolvedValue([original()])
  const catalog = vi.fn<MarketBrowserActions['catalog']>().mockResolvedValue([publication()])
  page(actions({ catalog, legacyCatalog }))
  await screen.findByText(marketEn.originalReadFailed)
  fireEvent.click(screen.getByRole('button', { name: marketEn.retryOriginal }))
  await screen.findByRole('heading', { name: original().title })
  expect(catalog).toHaveBeenCalledOnce()
})

it('shows published metadata, follows dependencies and refreshes discovery', async () => {
  const item = publication(), resource = { ...original(), requiredSkills: ['audio-transcribe'] }
  const catalog = vi.fn<MarketBrowserActions['catalog']>().mockResolvedValue([item])
  const view = page(actions({ catalog, legacyCatalog: async () => [resource] }))
  await screen.findByRole('heading', { name: item.manifest.title })
  const published = view.container.querySelector<HTMLElement>('[data-market-publication]')!
  fireEvent.click(within(published).getByRole('button', { name: marketEn.details }))
  expect(screen.getByRole('dialog', { name: item.manifest.title })).toBeTruthy()
  fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: marketEn.close }))
  const old = view.container.querySelector<HTMLElement>('[data-market-legacy]')!
  fireEvent.click(within(old).getByRole('button', { name: marketEn.details }))
  fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'audio-transcribe' }))
  await waitFor(() => { expect(catalog).toHaveBeenLastCalledWith('audio-transcribe', false) })
  expect(view.onNavigate).toHaveBeenCalledWith('discover')
  fireEvent.click(screen.getByRole('button', { name: marketEn.refresh }))
  await waitFor(() => { expect(catalog).toHaveBeenCalledTimes(3) })
})

it.each([401, 403, 503])('reports a published download refusal with status %s', async (status) => {
  const item = publication(), view = page(actions({ catalog: async () => [item],
    downloadPublication: async () => { throw failure(status) } }))
  await screen.findByRole('heading', { name: item.manifest.title })
  fireEvent.click(screen.getByRole('button', { name: marketEn.browserDownload }))
  const outcome = status === 401 ? 'signInRequired' : status === 403 ? 'permissionDenied' : 'cloudUnavailable'
  await waitFor(() => { expect(view.reportOutcome).toHaveBeenCalledWith(outcome, true) })
  expect(screen.getByRole('heading', { name: item.manifest.title })).toBeTruthy()
})

it('downloads a private package only after an unchanged account recheck', async () => {
  const item = { ...publication(), status: 'draft' as const }, output = downloads()
  const file = { name: 'private.zip', bytes: Uint8Array.of(80, 75) }
  const downloadPublication = vi.fn<MarketBrowserActions['downloadPublication']>().mockResolvedValue(file)
  const view = page(actions({ catalog: async () => [item], downloadPublication }), 'publish')
  await screen.findByRole('heading', { name: item.manifest.title })
  fireEvent.click(screen.getByRole('button', { name: marketEn.details }))
  fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: marketEn.browserDownload }))
  await waitFor(() => { expect(output.click).toHaveBeenCalledOnce() })
  expect(view.reportOutcome).toHaveBeenCalledWith('browserDownloaded', false)
  await waitFor(() => { expect(output.revoke).toHaveBeenCalledOnce() })
})

it('suppresses a private download after navigation and a public download after disposal', async () => {
  const item = { ...publication(), status: 'draft' as const }, output = downloads()
  const pending = Promise.withResolvers<Awaited<ReturnType<MarketBrowserActions['downloadPublication']>>>()
  const view = page(actions({ catalog: async (_query, mine) => mine ? [item] : [], downloadPublication: () => pending.promise }), 'publish')
  await screen.findByRole('heading', { name: item.manifest.title })
  fireEvent.click(screen.getByRole('button', { name: marketEn.browserDownload }))
  view.show('discover')
  await act(async () => { pending.resolve({ name: 'private.zip', bytes: Uint8Array.of(80) }); await pending.promise })
  expect(output.click).not.toHaveBeenCalled()
  view.unmount()
  const late = Promise.withResolvers<Awaited<ReturnType<MarketBrowserActions['downloadLegacy']>>>()
  const second = page(actions({ legacyCatalog: async () => [original()], downloadLegacy: () => late.promise }))
  await screen.findByRole('heading', { name: original().title })
  fireEvent.click(screen.getByRole('button', { name: marketEn.browserDownload }))
  second.unmount()
  await act(async () => { late.resolve({ name: 'legacy.zip', bytes: Uint8Array.of(80) }); await late.promise })
  expect(output.click).not.toHaveBeenCalled()
})

it('approves one publication with the original verified account and replaces its status', async () => {
  const item = { ...publication(), status: 'pending' as const }
  const review = vi.fn<MarketBrowserActions['review']>().mockResolvedValue({ ...item, status: 'published', revision: 2 })
  page(actions({ catalog: async () => [item], review }), 'publish')
  await screen.findByRole('heading', { name: item.manifest.title })
  fireEvent.click(screen.getByRole('button', { name: marketEn['review.approve'] }))
  fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: marketEn.confirm }))
  await waitFor(() => { expect(screen.queryByRole('dialog')).toBeNull() })
  expect(review).toHaveBeenCalledExactlyOnceWith(item.id, 1, 'approve', '', actor.accountId)
  fireEvent.click(screen.getByRole('button', { name: marketEn['publication.pending'] }))
  expect(screen.getByText(marketEn.noPublications)).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: marketEn['publication.published'] }))
  expect(screen.getByRole('heading', { name: item.manifest.title })).toBeTruthy()
})

it('reconciles an uncertain review using the same publication without repeating its write', async () => {
  const item = { ...publication(), status: 'pending' as const }, reviewed = { ...item, status: 'published' as const, revision: 2 }
  const review = vi.fn<MarketBrowserActions['review']>().mockRejectedValue(failure(503))
  const getPublication = vi.fn<MarketBrowserActions['getPublication']>().mockResolvedValue(reviewed)
  const view = page(actions({ catalog: async () => [item], review, getPublication }), 'publish')
  await screen.findByRole('heading', { name: item.manifest.title })
  fireEvent.click(screen.getByRole('button', { name: marketEn['review.approve'] }))
  fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: marketEn.confirm }))
  await waitFor(() => { expect(view.reportOutcome).toHaveBeenCalledWith('reviewUnconfirmed', true) })
  expect(getPublication).toHaveBeenCalledExactlyOnceWith(item.id)
  expect(review).toHaveBeenCalledOnce()
})

it('retries a failed private catalog and offers upload from an empty creator library', async () => {
  const catalog = vi.fn<MarketBrowserActions['catalog']>().mockRejectedValueOnce(failure(503)).mockResolvedValue([])
  const view = page(actions({ catalog }), 'publish')
  await screen.findByText(marketEn.publishedReadFailed)
  fireEvent.click(screen.getByRole('button', { name: marketEn.retryPublished }))
  await screen.findByText(marketEn.noPublications)
  fireEvent.click(within(screen.getByText(marketEn.noPublicationsHint).parentElement!).getByRole('button', { name: marketEn.creatorUploadZip }))
  expect(view.onNavigate).toHaveBeenCalledWith('upload')
})

it.each([0, 1025])('rejects a selected archive of %s bytes before reading or uploading', async (size) => {
  const previewArchive = vi.fn<MarketBrowserActions['previewArchive']>()
  const view = upload({ actions: actions({ previewArchive }) })
  const file = new File([new Uint8Array(size)], 'invalid.zip')
  fireEvent.change(screen.getByLabelText(marketEn.browserChooseArchive), { target: { files: [file] } })
  await waitFor(() => { expect(view.reportOutcome).toHaveBeenCalledWith('browserArchiveTooLarge', true) })
  expect(previewArchive).not.toHaveBeenCalled()
})

it('preserves the original preview when no file is selected and reports invalid content', async () => {
  const previewArchive = vi.fn<MarketBrowserActions['previewArchive']>().mockRejectedValue(Object.assign(new Error('Invalid ZIP'), { code: 'invalid-archive' }))
  const view = upload({ actions: actions({ previewArchive }) })
  fireEvent.change(screen.getByLabelText(marketEn.browserChooseArchive), { target: { files: [] } })
  expect(previewArchive).not.toHaveBeenCalled()
  selectFile()
  await waitFor(() => { expect(view.reportOutcome).toHaveBeenCalledWith('invalidPackage', true) })
})

it('retains an uncertain upload until explicit discard and allows choosing another publisher afterward', async () => {
  const item = publication(), alternate = brandString<MarketIdentity['publishers'][number]['id']>('d'.repeat(32))
  const uploadArchive = vi.fn<MarketBrowserActions['uploadArchive']>().mockRejectedValue(failure(503))
  const team = { ...actor, publishers: [...actor.publishers, { id: alternate, title: 'Another team' }] }
  const view = upload({ identity: team, verifyIdentity: async () => team,
    actions: actions({ previewArchive: async () => item.manifest,
      prepareArchive: async bytes => ({ bytes, manifest: item.manifest }), uploadArchive }) })
  selectFile()
  await screen.findByText(marketEn.browserPreparedArchive)
  fireEvent.change(screen.getByRole('combobox'), { target: { value: alternate } })
  fireEvent.click(screen.getByRole('button', { name: marketEn.upload }))
  await screen.findByText(marketEn.browserUploadRetained)
  await waitFor(() => { expect(screen.getByRole('button', { name: marketEn.discardUpload }).hasAttribute('disabled')).toBe(false) })
  fireEvent.click(screen.getByRole('button', { name: marketEn.discardUpload }))
  fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: marketEn.close }))
  expect(screen.getByText(marketEn.browserUploadRetained)).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: marketEn.discardUpload }))
  fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: marketEn.confirm }))
  expect(screen.queryByText(marketEn.browserUploadRetained)).toBeNull()
  expect(screen.getByLabelText<HTMLInputElement>(marketEn.browserChooseArchive).disabled).toBe(false)
  expect(uploadArchive.mock.calls[0]?.[1]).toBe(alternate)
  expect(view.uploaded).not.toHaveBeenCalled()
})

it('refuses a verified account whose selected publishing team has been revoked', async () => {
  const view = upload({ verifyIdentity: async () => ({ ...actor, publishers: [] }) })
  selectFile()
  await screen.findByText(marketEn.browserPreparedArchive)
  fireEvent.click(screen.getByRole('button', { name: marketEn.upload }))
  await waitFor(() => { expect(view.reportOutcome).toHaveBeenCalledWith('permissionDenied', true) })
  expect(view.uploaded).not.toHaveBeenCalled()
})

it('allows preview without a publishing team and retries account loading from its own notice', async () => {
  const view = upload({ identity: undefined, identityError: 'cloudUnavailable' })
  fireEvent.click(screen.getByRole('button', { name: marketEn.retry }))
  expect(view.retryIdentity).toHaveBeenCalledOnce()
  view.update({ identity: { ...actor, publishers: [] } })
  expect(screen.getByText(marketEn.noPublisher)).toBeTruthy()
  selectFile()
  await screen.findByText(marketEn.browserPreparedArchive)
  expect(screen.getByRole('button', { name: marketEn.upload }).hasAttribute('disabled')).toBe(true)
})

it('ignores a preview that resolves after a newer file selection or disposal', async () => {
  const first = Promise.withResolvers<Awaited<ReturnType<MarketBrowserActions['previewArchive']>>>()
  const item = publication('latest-preview'), previewArchive = vi.fn<MarketBrowserActions['previewArchive']>()
    .mockReturnValueOnce(first.promise).mockResolvedValue(item.manifest)
  const view = upload({ actions: actions({ previewArchive, prepareArchive: async bytes => ({ bytes, manifest: item.manifest }) }) })
  selectFile('old.zip')
  await waitFor(() => { expect(previewArchive).toHaveBeenCalledOnce() })
  selectFile('new.zip')
  await screen.findByText('new.zip')
  await act(async () => { first.resolve(publication('old-preview').manifest); await first.promise })
  expect(screen.queryByText('old.zip')).toBeNull()
  const last = Promise.withResolvers<Awaited<ReturnType<MarketBrowserActions['previewArchive']>>>()
  previewArchive.mockReturnValueOnce(last.promise)
  selectFile('late.zip')
  await waitFor(() => { expect(previewArchive).toHaveBeenCalledTimes(3) })
  view.unmount()
  await act(async () => { last.reject(failure(503)); await last.promise.catch(() => undefined) })
  expect(view.reportOutcome).not.toHaveBeenCalled()
})

it('ignores older public successes and failures after refreshing the same discovery view', async () => {
  const oldPublic = Promise.withResolvers<Awaited<ReturnType<MarketBrowserActions['catalog']>>>()
  const oldLegacy = Promise.withResolvers<Awaited<ReturnType<MarketBrowserActions['legacyCatalog']>>>()
  const catalog = vi.fn<MarketBrowserActions['catalog']>().mockReturnValueOnce(oldPublic.promise).mockResolvedValue([publication('new-skill')])
  const legacyCatalog = vi.fn<MarketBrowserActions['legacyCatalog']>().mockReturnValueOnce(oldLegacy.promise).mockResolvedValue([])
  page(actions({ catalog, legacyCatalog }))
  fireEvent.click(screen.getByRole('button', { name: marketEn.refresh }))
  await screen.findByRole('heading', { name: 'new-skill' })
  await act(async () => { oldPublic.resolve([publication('old-skill')]); oldLegacy.reject(failure(503)); await Promise.allSettled([oldPublic.promise, oldLegacy.promise]) })
  expect(screen.queryByRole('heading', { name: 'old-skill' })).toBeNull()
  expect(screen.queryByText(marketEn.originalReadFailed)).toBeNull()
})

it('ignores identity and catalog completion after the page has closed', async () => {
  const identity = Promise.withResolvers<MarketIdentity>()
  const catalog = Promise.withResolvers<Awaited<ReturnType<MarketBrowserActions['catalog']>>>()
  const legacy = Promise.withResolvers<Awaited<ReturnType<MarketBrowserActions['legacyCatalog']>>>()
  const view = page(actions({ identity: () => identity.promise, catalog: () => catalog.promise, legacyCatalog: () => legacy.promise }))
  view.unmount()
  await act(async () => {
    identity.resolve(actor); catalog.reject(failure(503)); legacy.resolve([original()])
    await Promise.allSettled([identity.promise, catalog.promise, legacy.promise])
  })
  expect(view.reportOutcome).not.toHaveBeenCalled()
})

it('ignores a creator identity that completes after navigation and retries identity on the upload view', async () => {
  const pending = Promise.withResolvers<MarketIdentity>()
  const identity = vi.fn<MarketBrowserActions['identity']>().mockReturnValueOnce(pending.promise).mockResolvedValue(actor)
  const view = page(actions({ identity }), 'publish')
  view.show('upload')
  await waitFor(() => { expect(identity).toHaveBeenCalledTimes(2) })
  fireEvent.click(screen.getByRole('button', { name: marketEn.refresh }))
  await waitFor(() => { expect(identity).toHaveBeenCalledTimes(3) })
  await act(async () => { pending.resolve(actor); await pending.promise })
  expect(screen.queryByRole('alert')).toBeNull()
})

it('ignores creator readback when navigation occurs during its final identity check', async () => {
  const pending = Promise.withResolvers<MarketIdentity>(), item = { ...publication('private-readback'), status: 'draft' as const }
  const identity = vi.fn<MarketBrowserActions['identity']>().mockResolvedValueOnce(actor).mockReturnValueOnce(pending.promise).mockResolvedValue(actor)
  const view = page(actions({ identity, catalog: async (_query, mine) => mine ? [item] : [] }), 'publish')
  await waitFor(() => { expect(identity).toHaveBeenCalledTimes(2) })
  view.show('discover')
  await act(async () => { pending.resolve(actor); await pending.promise })
  expect(screen.queryByRole('heading', { name: item.manifest.title })).toBeNull()
})

it('suppresses private catalog failure after its component is disposed', async () => {
  const pending = Promise.withResolvers<Awaited<ReturnType<MarketBrowserActions['catalog']>>>()
  const catalog = vi.fn<MarketBrowserActions['catalog']>().mockReturnValue(pending.promise)
  const view = page(actions({ catalog }), 'publish')
  await waitFor(() => { expect(catalog).toHaveBeenCalledOnce() })
  view.unmount()
  await act(async () => { pending.reject(failure(503)); await pending.promise.catch(() => undefined) })
  expect(view.reportOutcome).not.toHaveBeenCalled()
})

it('does not surface a download failure after leaving the market entirely', async () => {
  const pending = Promise.withResolvers<Awaited<ReturnType<MarketBrowserActions['downloadLegacy']>>>()
  const view = page(actions({ legacyCatalog: async () => [original()], downloadLegacy: () => pending.promise }))
  await screen.findByRole('heading', { name: original().title })
  fireEvent.click(screen.getByRole('button', { name: marketEn.browserDownload }))
  view.unmount()
  await act(async () => { pending.reject(failure(503)); await pending.promise.catch(() => undefined) })
  expect(view.reportOutcome).not.toHaveBeenCalled()
})

it('suppresses a private download whose final account check finishes after navigation', async () => {
  const output = downloads(), pending = Promise.withResolvers<MarketIdentity>()
  const item = { ...publication('private-download-check'), status: 'draft' as const }
  const identity = vi.fn<MarketBrowserActions['identity']>().mockResolvedValueOnce(actor).mockResolvedValueOnce(actor).mockReturnValueOnce(pending.promise).mockResolvedValue(actor)
  const view = page(actions({ identity, catalog: async (_query, mine) => mine ? [item] : [],
    downloadPublication: async () => ({ name: 'private.zip', bytes: Uint8Array.of(80) }) }), 'publish')
  await screen.findByRole('heading', { name: item.manifest.title })
  fireEvent.click(screen.getByRole('button', { name: marketEn.browserDownload }))
  await waitFor(() => { expect(identity).toHaveBeenCalledTimes(3) })
  view.show('discover')
  await act(async () => { pending.resolve(actor); await pending.promise })
  expect(output.click).not.toHaveBeenCalled()
})

it('keeps current private rows when review reconciliation replaces a different publication', async () => {
  const first = { ...publication('first'), status: 'pending' as const }, second = { ...publication('second'), id: brandString<typeof first.id>('d'.repeat(32)) }
  const review = vi.fn<MarketBrowserActions['review']>().mockResolvedValue({ ...first, status: 'published', revision: 2 })
  const view = page(actions({ catalog: async () => [first, second], review }), 'publish')
  await screen.findByRole('heading', { name: first.manifest.title })
  const card = view.container.querySelector<HTMLElement>(`[data-market-publication="${first.id}"]`)!
  fireEvent.click(within(card).getByRole('button', { name: marketEn['review.approve'] }))
  fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: marketEn.confirm }))
  await waitFor(() => { expect(screen.queryByRole('dialog')).toBeNull() })
  expect(screen.getByRole('heading', { name: second.manifest.title })).toBeTruthy()
})

it('opens upload from the discovery contribution card', async () => {
  const view = page(actions({ legacyCatalog: async () => [original()] }))
  await screen.findByRole('heading', { name: original().title })
  fireEvent.click(within(screen.getByText(marketEn.contributeDescription).parentElement!).getByRole('button', { name: marketEn.creatorUploadZip }))
  expect(view.onNavigate).toHaveBeenCalledWith('upload')
})

it('suppresses preview errors when another file selection has already completed', async () => {
  const pending = Promise.withResolvers<Awaited<ReturnType<MarketBrowserActions['previewArchive']>>>()
  const item = publication(), previewArchive = vi.fn<MarketBrowserActions['previewArchive']>().mockReturnValueOnce(pending.promise).mockResolvedValue(item.manifest)
  const view = upload({ actions: actions({ previewArchive, prepareArchive: async bytes => ({ bytes, manifest: item.manifest }) }) })
  selectFile('old.zip'); selectFile('new.zip')
  await screen.findByText('new.zip')
  await act(async () => { pending.reject(failure(503)); await pending.promise.catch(() => undefined) })
  expect(view.reportOutcome).not.toHaveBeenCalled()
})

it('releases an in-flight upload after the uploader has unmounted', async () => {
  const pending = Promise.withResolvers<MarketIdentity>(), verifyIdentity = vi.fn(async () => pending.promise)
  const view = upload({ verifyIdentity })
  selectFile(); await screen.findByText(marketEn.browserPreparedArchive)
  fireEvent.click(screen.getByRole('button', { name: marketEn.upload }))
  await waitFor(() => { expect(verifyIdentity).toHaveBeenCalledOnce() })
  view.unmount()
  await act(async () => { pending.resolve(actor); await pending.promise })
  expect(view.uploaded).not.toHaveBeenCalled()
  expect(view.reportOutcome).not.toHaveBeenCalled()
})

it('does not report a late upload failure after its page has unmounted', async () => {
  const pending = Promise.withResolvers<Awaited<ReturnType<MarketBrowserActions['uploadArchive']>>>(), item = publication()
  const uploadArchive = vi.fn<MarketBrowserActions['uploadArchive']>().mockReturnValue(pending.promise)
  const view = upload({ actions: actions({ previewArchive: async () => item.manifest,
    prepareArchive: async bytes => ({ bytes, manifest: item.manifest }), uploadArchive }) })
  selectFile(); await screen.findByText(marketEn.browserPreparedArchive)
  fireEvent.click(screen.getByRole('button', { name: marketEn.upload }))
  await waitFor(() => { expect(uploadArchive).toHaveBeenCalledOnce() })
  view.unmount()
  await act(async () => { pending.reject(failure(503)); await pending.promise.catch(() => undefined) })
  expect(view.reportOutcome).not.toHaveBeenCalled()
})

it('refuses incomplete and repeated form submissions without sending another upload', async () => {
  const pending = Promise.withResolvers<MarketIdentity>(), verifyIdentity = vi.fn(async () => pending.promise)
  const view = upload({ verifyIdentity })
  const form = view.container.querySelector('form')!
  fireEvent.submit(form)
  expect(verifyIdentity).not.toHaveBeenCalled()
  selectFile(); await screen.findByText(marketEn.browserPreparedArchive)
  fireEvent.submit(form)
  await waitFor(() => { expect(verifyIdentity).toHaveBeenCalledOnce() })
  fireEvent.submit(form)
  fireEvent.change(screen.getByLabelText(marketEn.browserChooseArchive), { target: { files: [new File(['late'], 'late-dialog.zip')] } })
  expect(verifyIdentity).toHaveBeenCalledOnce()
  await act(async () => { pending.resolve(actor); await pending.promise })
  await waitFor(() => { expect(view.uploaded).toHaveBeenCalledOnce() })
})

it('refuses a stale submission after its selected account has changed', async () => {
  const view = upload()
  selectFile(); await screen.findByText(marketEn.browserPreparedArchive)
  view.update({ identity: { ...actor, accountId: brandString<MarketIdentity['accountId']>('d'.repeat(16)) } })
  fireEvent.submit(view.container.querySelector('form')!)
  await waitFor(() => { expect(view.reportOutcome).toHaveBeenCalledWith('signInRequired', true) })
  expect(view.uploaded).not.toHaveBeenCalled()
})

it('does not retry an anonymous preview under a different account than the original upload', async () => {
  const item = publication(), uploadArchive = vi.fn<MarketBrowserActions['uploadArchive']>().mockRejectedValue(failure(503))
  const view = upload({ identity: undefined, actions: actions({ previewArchive: async () => item.manifest,
    prepareArchive: async bytes => ({ bytes, manifest: item.manifest }), uploadArchive }) })
  selectFile(); await screen.findByText(marketEn.browserPreparedArchive)
  view.update({ identity: actor })
  fireEvent.submit(view.container.querySelector('form')!)
  await waitFor(() => { expect(uploadArchive).toHaveBeenCalledOnce() })
  await screen.findByText(marketEn.browserUploadRetained)
  view.update({ identity: { ...actor, accountId: brandString<MarketIdentity['accountId']>('d'.repeat(16)) } })
  fireEvent.submit(view.container.querySelector('form')!)
  await waitFor(() => { expect(view.reportOutcome).toHaveBeenCalledWith('signInRequired', true) })
  expect(uploadArchive).toHaveBeenCalledOnce()
})

it('does not display private metadata after publishing membership changes during final verification', async () => {
  const item = { ...publication(), status: 'draft' as const }, readIdentity = vi.fn<MarketBrowserActions['identity']>()
    .mockResolvedValueOnce(actor).mockResolvedValue({ ...actor, publishers: [] })
  page(actions({ identity: readIdentity, catalog: async () => [item] }), 'publish')
  await screen.findByText(marketEn.publishedReadFailed)
  expect(screen.queryByRole('heading', { name: item.manifest.title })).toBeNull()
})

it('hides an open private details dialog as soon as a refresh revokes account access', async () => {
  const item = { ...publication(), status: 'draft' as const }, readIdentity = vi.fn<MarketBrowserActions['identity']>()
    .mockResolvedValueOnce(actor).mockResolvedValueOnce(actor).mockRejectedValue(failure(401))
  page(actions({ identity: readIdentity, catalog: async () => [item] }), 'publish')
  await screen.findByRole('heading', { name: item.manifest.title })
  fireEvent.click(screen.getByRole('button', { name: marketEn.details }))
  expect(screen.getByRole('dialog')).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: marketEn.refresh }))
  await screen.findByRole('alert')
  expect(screen.queryByRole('dialog')).toBeNull()
})

it('keeps a private download fenced when a second verification supersedes its first', async () => {
  const output = downloads(), pending = Promise.withResolvers<MarketIdentity>()
  const item = { ...publication(), status: 'draft' as const }
  const identity = vi.fn<MarketBrowserActions['identity']>().mockResolvedValueOnce(actor).mockResolvedValueOnce(actor)
    .mockReturnValueOnce(pending.promise).mockResolvedValue(actor)
  const view = page(actions({ identity, catalog: async () => [item], downloadPublication: async () => ({ name: 'private.zip', bytes: Uint8Array.of(80) }) }), 'publish')
  await screen.findByRole('heading', { name: item.manifest.title })
  fireEvent.click(screen.getByRole('button', { name: marketEn.browserDownload }))
  await waitFor(() => { expect(identity).toHaveBeenCalledTimes(3) })
  fireEvent.click(screen.getByRole('button', { name: marketEn.refresh }))
  await waitFor(() => { expect(identity.mock.calls.length).toBeGreaterThan(3) })
  await act(async () => { pending.resolve(actor); await pending.promise })
  expect(output.click).not.toHaveBeenCalled()
  expect(view.reportOutcome).not.toHaveBeenCalledWith('browserDownloaded', false)
})

it('keeps progressive rendering unchanged while scrolling far from the next page', async () => {
  const resources = Array.from({ length: 24 }, (_, index) => original(`skill-${index}`))
  const view = page(actions({ legacyCatalog: async () => resources }))
  await screen.findByRole('heading', { name: resources[0]!.title })
  const root = view.container.querySelector('[data-market-carrier]')!
  Object.defineProperties(root, { scrollHeight: { value: 2000 }, clientHeight: { value: 600 }, scrollTop: { value: 0 } })
  fireEvent.scroll(root)
  expect(view.container.querySelectorAll('[data-market-legacy]')).toHaveLength(12)
})

it('starts only one browser download when two gestures arrive before the busy render', async () => {
  const pending = Promise.withResolvers<Awaited<ReturnType<MarketBrowserActions['downloadLegacy']>>>()
  const downloadLegacy = vi.fn<MarketBrowserActions['downloadLegacy']>().mockReturnValue(pending.promise)
  const output = downloads(), view = page(actions({ legacyCatalog: async () => [original()], downloadLegacy }))
  await screen.findByRole('heading', { name: original().title })
  const button = screen.getByRole('button', { name: marketEn.browserDownload })
  await act(async () => { fireEvent.click(button); fireEvent.click(button) })
  expect(downloadLegacy).toHaveBeenCalledOnce()
  await act(async () => { pending.resolve({ name: 'original.zip', bytes: Uint8Array.of(80, 75) }); await pending.promise })
  expect(output.click).toHaveBeenCalledOnce()
  expect(view.reportOutcome).toHaveBeenCalledWith('browserDownloaded', false)
})

it('does not save a private download when the same account loses publishing permissions during verification', async () => {
  const output = downloads(), item = { ...publication(), status: 'draft' as const }
  const revoked = { ...actor, admin: false, publishers: [] }
  const identity = vi.fn<MarketBrowserActions['identity']>().mockResolvedValueOnce(actor).mockResolvedValueOnce(actor).mockResolvedValue(revoked)
  const view = page(actions({ identity, catalog: async () => [item],
    downloadPublication: async () => ({ name: 'private.zip', bytes: Uint8Array.of(80) }) }), 'publish')
  await screen.findByRole('heading', { name: item.manifest.title })
  fireEvent.click(screen.getByRole('button', { name: marketEn.browserDownload }))
  await waitFor(() => { expect(identity).toHaveBeenCalledTimes(3) })
  await act(async () => undefined)
  expect(output.click).not.toHaveBeenCalled()
  expect(view.reportOutcome).not.toHaveBeenCalledWith('browserDownloaded', false)
})

it('rejects a queued private download gesture after identity revocation and before the next render', async () => {
  const pending = Promise.withResolvers<MarketIdentity>(), item = { ...publication(), status: 'pending' as const }
  const readIdentity = vi.fn<MarketBrowserActions['identity']>().mockResolvedValueOnce(actor).mockResolvedValueOnce(actor).mockReturnValue(pending.promise)
  const downloadPublication = vi.fn<MarketBrowserActions['downloadPublication']>()
  const view = page(actions({ identity: readIdentity, catalog: async () => [item], downloadPublication }), 'publish')
  await screen.findByRole('heading', { name: item.manifest.title })
  const button = screen.getByRole('button', { name: marketEn.browserDownload })
  fireEvent.click(screen.getByRole('button', { name: marketEn['review.approve'] }))
  const form = screen.getByRole('dialog').querySelector('form')!
  await act(async () => {
    fireEvent.submit(form)
    const queuedGesture = pending.promise.catch(() => { fireEvent.click(button) })
    pending.reject(failure(401))
    await queuedGesture
  })
  expect(downloadPublication).not.toHaveBeenCalled()
  expect(view.reportOutcome).toHaveBeenCalledWith('signInRequired', true)
})

it('uses public download authority for a published card shown in the creator library', async () => {
  const output = downloads(), item = publication(), readIdentity = vi.fn<MarketBrowserActions['identity']>().mockResolvedValue(actor)
  const view = page(actions({ identity: readIdentity, catalog: async () => [item],
    downloadPublication: async () => ({ name: 'published.zip', bytes: Uint8Array.of(80, 75) }) }), 'publish')
  await screen.findByRole('heading', { name: item.manifest.title })
  const calls = readIdentity.mock.calls.length
  fireEvent.click(screen.getByRole('button', { name: marketEn.browserDownload }))
  await waitFor(() => { expect(output.click).toHaveBeenCalledOnce() })
  expect(readIdentity).toHaveBeenCalledTimes(calls)
  expect(view.reportOutcome).toHaveBeenCalledWith('browserDownloaded', false)
})

it.each([
  ['original', 'navigation'], ['published', 'navigation'], ['original', 'account'], ['published', 'account'],
] as const)('retains a verified public %s download through internal %s changes', async (source, change) => {
  const output = downloads(), file = { name: 'verified.zip', bytes: Uint8Array.of(80, 75) }
  const pending = Promise.withResolvers<typeof file>()
  let current = actor
  const readIdentity = vi.fn<MarketBrowserActions['identity']>(async () => current)
  const view = page(actions({ identity: readIdentity, catalog: async () => source === 'published' ? [publication()] : [],
    legacyCatalog: async () => source === 'original' ? [original()] : [],
    downloadLegacy: () => pending.promise, downloadPublication: () => pending.promise }))
  await screen.findByRole('heading', { name: source === 'published' ? publication().manifest.title : original().title })
  fireEvent.click(screen.getByRole('button', { name: marketEn.browserDownload }))
  if (change === 'navigation') view.show('upload')
  else {
    const before = readIdentity.mock.calls.length
    current = { ...actor, accountId: brandString<MarketIdentity['accountId']>('d'.repeat(16)), publishers: [] }
    fireEvent.click(screen.getByRole('button', { name: marketEn.refresh }))
    await waitFor(() => { expect(readIdentity.mock.calls.length).toBeGreaterThan(before) })
  }
  await act(async () => { pending.resolve(file); await pending.promise })
  expect(output.click).toHaveBeenCalledOnce()
  expect(view.reportOutcome).toHaveBeenCalledWith('browserDownloaded', false)
})

it('rechecks private authority after the transfer settles and before saving the file', async () => {
  const output = downloads(), item = { ...publication(), status: 'draft' as const }
  const verification = Promise.withResolvers<MarketIdentity>(), switched = Promise.withResolvers<undefined>()
  const identity = vi.fn<MarketBrowserActions['identity']>().mockResolvedValueOnce(actor).mockResolvedValueOnce(actor)
    .mockReturnValueOnce(verification.promise).mockResolvedValue(actor)
  const view = page(actions({ identity, catalog: async (_query, mine) => mine ? [item] : [],
    downloadPublication: async () => ({ name: 'private.zip', bytes: Uint8Array.of(80) }) }), 'publish')
  await screen.findByRole('heading', { name: item.manifest.title })
  fireEvent.click(screen.getByRole('button', { name: marketEn.browserDownload }))
  await waitFor(() => { expect(identity).toHaveBeenCalledTimes(3) })
  void verification.promise.then(() => {
    queueMicrotask(() => {
      queueMicrotask(() => { flushSync(() => { view.show('discover') }); switched.resolve(undefined) })
    })
  })
  await act(async () => { verification.resolve(actor); await switched.promise })
  expect(output.click).not.toHaveBeenCalled()
  expect(view.reportOutcome).not.toHaveBeenCalledWith('browserDownloaded', false)
})

it('does not commit an earlier creator list after verification settles into a newly opened creator view', async () => {
  const item = { ...publication('stale-creator-list'), status: 'draft' as const }
  const verification = Promise.withResolvers<MarketIdentity>(), nextIdentity = Promise.withResolvers<MarketIdentity>()
  onTestFinished(() => { nextIdentity.resolve(actor) })
  const switched = Promise.withResolvers<undefined>()
  const identity = vi.fn<MarketBrowserActions['identity']>().mockResolvedValueOnce(actor)
    .mockReturnValueOnce(verification.promise).mockReturnValue(nextIdentity.promise)
  const catalog = vi.fn<MarketBrowserActions['catalog']>().mockResolvedValueOnce([item]).mockResolvedValue([])
  const view = page(actions({ identity, catalog }), 'publish')
  await waitFor(() => { expect(identity).toHaveBeenCalledTimes(2) })
  void verification.promise.then(() => {
    queueMicrotask(() => {
      flushSync(() => { view.show('upload') })
      flushSync(() => { view.show('publish') })
      switched.resolve(undefined)
    })
  })
  await act(async () => { verification.resolve(actor); await switched.promise })
  expect(screen.queryByRole('heading', { name: item.manifest.title })).toBeNull()
  expect(screen.getByRole('status', { name: marketEn.loading })).toBeTruthy()
  await act(async () => { nextIdentity.resolve(actor); await nextIdentity.promise })
})
