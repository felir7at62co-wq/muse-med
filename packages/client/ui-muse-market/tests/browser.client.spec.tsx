// @vitest-environment jsdom
/** Browser-only publication flows share role presentation without claiming a local installation. */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, onTestFinished, vi } from 'vitest'
import { brandString } from '@deepseek-ai/dsh-brand'
import { MarketBrowserPage } from '../src/client/browser.tsx'
import type { MarketBrowserActions, MarketBrowserView } from '../src/client/market-browser-actions.ts'
import type { MarketIdentity, MarketPublication, MarketTranslate } from '../src/client/market-actions.ts'
import { marketFailureOutcome } from '../src/client/market-actions.ts'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import { marketEn } from '../src/client/market-locales.ts'
import { original, publication } from './discovery-fixtures.client.ts'

const identity: MarketIdentity = { accountId: brandString<MarketIdentity['accountId']>('c'.repeat(16)), admin: false,
  publishers: [{ id: publication().publisherId, title: 'Studio' }] }
const messages: Readonly<Record<string, string>> = marketEn
const translate: MarketTranslate = key => messages[key] ?? key
const unused = async (): Promise<never> => { throw new Error('Unexpected browser operation') }
function operations(overrides: Partial<MarketBrowserActions> = {}): MarketBrowserActions {
  return { archiveBytes: 1024, catalog: async () => [], legacyCatalog: async () => [], identity: async () => identity,
    getPublication: unused, review: unused, previewArchive: unused, prepareArchive: unused,
    uploadArchive: unused, downloadPublication: unused, downloadLegacy: unused, ...overrides }
}
function mount(actions: MarketBrowserActions, view: MarketBrowserView = 'discover') {
  const onNavigate = vi.fn(), reportOutcome = vi.fn()
  const page = (next: MarketBrowserView) => <MarketBrowserPage actions={actions} view={next} onNavigate={onNavigate}
    reportOutcome={reportOutcome} t={translate} />
  const rendered = render(page(view))
  return { ...rendered, onNavigate, reportOutcome, show: (next: MarketBrowserView) => { rendered.rerender(page(next)) } }
}
function chooseFile() {
  const file = new File(['zip'], 'skill.zip', { type: 'application/zip' })
  Object.defineProperty(file, 'arrayBuffer', { value: async () => Uint8Array.of(80, 75, 3, 4).buffer })
  fireEvent.change(screen.getByLabelText(marketEn.browserChooseArchive), { target: { files: [file] } })
}

beforeEach(() => { localStorage.setItem('dsh.muse-market.guide.v1', 'seen') })
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); localStorage.clear() })

it('retains 42 original Skills after a publication failure and reveals more without an installation tab', async () => {
  const resources = Array.from({ length: 42 }, (_, index) => original(`skill-${index}`))
  const modern = publication(resources[0]!.name, resources[0]!.version)
  const catalog = vi.fn<MarketBrowserActions['catalog']>().mockRejectedValueOnce(new Error('Offline')).mockResolvedValue([modern])
  const view = mount(operations({ catalog, legacyCatalog: async () => resources, identity: unused }))
  await screen.findByRole('heading', { name: resources[0]!.title })
  expect(view.container.querySelectorAll('article')).toHaveLength(12)
  expect(screen.queryByRole('tab', { name: marketEn.installed })).toBeNull()
  expect(screen.queryByRole('button', { name: marketEn.useVersion })).toBeNull()
  fireEvent.scroll(view.container.querySelector('[data-market-carrier]')!, { target: { scrollTop: 1000 } })
  expect(view.container.querySelectorAll('article')).toHaveLength(24)
  fireEvent.click(screen.getByRole('button', { name: marketEn.retryPublished }))
  await waitFor(() => { expect(view.container.querySelector('[data-market-publication]')).not.toBeNull() })
  expect(view.container.querySelectorAll('article')).toHaveLength(24)
  expect(view.container.querySelector(`[data-market-legacy="${resources[0]!.id}"]`)).not.toBeNull()
  expect(catalog).toHaveBeenCalledTimes(2)
})

it('shows original dependencies and downloads a browser file without reporting installation', async () => {
  const resource = { ...original('anime-3d-assets'), requiredSkills: ['storyboard-review'], validation: 'Reviewed resources' }
  const downloadLegacy = vi.fn<MarketBrowserActions['downloadLegacy']>().mockResolvedValue({ name: 'anime-3d-assets.zip', bytes: Uint8Array.of(80, 75) })
  const OriginalURL = URL
  vi.stubGlobal('URL', class extends OriginalURL {
    static override createObjectURL = vi.fn(() => 'blob:market-download')
    static override revokeObjectURL = vi.fn()
  })
  const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
  const view = mount(operations({ legacyCatalog: async () => [resource], downloadLegacy }))
  await screen.findByRole('heading', { name: resource.title })
  fireEvent.click(screen.getByRole('button', { name: marketEn.details }))
  const dialog = screen.getByRole('dialog', { name: resource.title })
  expect(within(dialog).getByText(resource.validation)).toBeTruthy()
  expect(within(dialog).getByRole('button', { name: 'storyboard-review' })).toBeTruthy()
  fireEvent.click(within(dialog).getByRole('button', { name: marketEn.browserDownload }))
  await waitFor(() => { expect(click).toHaveBeenCalledOnce() })
  expect(downloadLegacy).toHaveBeenCalledExactlyOnceWith(resource)
  expect(view.reportOutcome).toHaveBeenCalledWith('browserDownloaded', false)
  expect(view.reportOutcome).not.toHaveBeenCalledWith('installedDone', false)
})

it('uploads the bound preview bytes and retains the original account and key on retry', async () => {
  const item = publication('anime-3d-assets')
  const bound = { bytes: Uint8Array.of(80, 75, 7), manifest: { ...item.manifest, presetPortrait: '3d-asset-artist' } }
  const prepareArchive = vi.fn<MarketBrowserActions['prepareArchive']>().mockResolvedValue(bound)
  const uploadArchive = vi.fn<MarketBrowserActions['uploadArchive']>()
    .mockRejectedValueOnce(Object.assign(new Error('Upstream detail'), { code: 'cloud-unavailable', status: 503 }))
    .mockResolvedValue({ ...item, status: 'draft', manifest: bound.manifest })
  const view = mount(operations({ previewArchive: async () => item.manifest, prepareArchive, uploadArchive }), 'upload')
  chooseFile()
  await screen.findByText(marketEn.browserPreparedArchive)
  const preview = screen.getByRole('complementary', { name: marketEn.creatorPreviewTitle })
  expect(preview.querySelector('[data-market-portrait]')?.getAttribute('data-market-portrait')).toBe('3d-asset-artist')
  expect(prepareArchive).toHaveBeenCalledWith(Uint8Array.of(80, 75, 3, 4), '3d-asset-artist')
  fireEvent.click(screen.getByRole('button', { name: marketEn.upload }))
  await screen.findByText(marketEn.browserUploadRetained)
  expect(screen.getByLabelText<HTMLInputElement>(marketEn.browserChooseArchive).disabled).toBe(true)
  await waitFor(() => { expect(screen.getByRole('button', { name: marketEn.retryUpload }).hasAttribute('disabled')).toBe(false) })
  fireEvent.click(screen.getByRole('button', { name: marketEn.retryUpload }))
  await waitFor(() => { expect(view.onNavigate).toHaveBeenCalledWith('publish') })
  expect(uploadArchive).toHaveBeenCalledTimes(2)
  expect(uploadArchive.mock.calls[0]).toEqual(uploadArchive.mock.calls[1])
  expect(uploadArchive.mock.calls[0]).toEqual([bound.bytes, identity.publishers[0]!.id, expect.any(String), identity.accountId])
  expect(view.reportOutcome).toHaveBeenCalledWith('draftDone', false)
})

it('previews a local ZIP without login while keeping upload unavailable', async () => {
  const item = publication('anonymous-preview'), uploadArchive = vi.fn<MarketBrowserActions['uploadArchive']>()
  mount(operations({ identity: unused, previewArchive: async () => item.manifest,
    prepareArchive: async bytes => ({ bytes, manifest: item.manifest }), uploadArchive }), 'upload')
  chooseFile()
  await screen.findByRole('heading', { name: item.manifest.title })
  expect(screen.getByRole('button', { name: marketEn.upload }).hasAttribute('disabled')).toBe(true)
  expect(uploadArchive).not.toHaveBeenCalled()
})

it('retains a failed upload across leaving and returning to the upload page', async () => {
  const item = publication('retained-upload'), pending = Promise.withResolvers<MarketPublication>()
  const failure = Object.assign(new Error('Connection lost'), { code: 'cloud-unavailable', status: 503 })
  onTestFinished(() => { pending.reject(failure) })
  const uploadArchive = vi.fn<MarketBrowserActions['uploadArchive']>().mockReturnValueOnce(pending.promise)
    .mockResolvedValue({ ...item, status: 'draft' })
  const view = mount(operations({ previewArchive: async () => item.manifest,
    prepareArchive: async bytes => ({ bytes, manifest: item.manifest }), uploadArchive }), 'upload')
  chooseFile()
  await screen.findByText(marketEn.browserPreparedArchive)
  fireEvent.click(screen.getByRole('button', { name: marketEn.upload }))
  await waitFor(() => { expect(uploadArchive).toHaveBeenCalledOnce() })
  view.show('discover')
  await act(async () => { pending.reject(failure); await pending.promise.catch(() => undefined) })
  expect(screen.queryByRole('button', { name: marketEn.retryUpload })).toBeNull()
  view.show('upload')
  await waitFor(() => { expect(screen.getByRole('button', { name: marketEn.retryUpload }).hasAttribute('disabled')).toBe(false) })
  fireEvent.click(screen.getByRole('button', { name: marketEn.retryUpload }))
  await waitFor(() => { expect(uploadArchive).toHaveBeenCalledTimes(2) })
  expect(uploadArchive.mock.calls[1]).toEqual(uploadArchive.mock.calls[0])
  await waitFor(() => { expect(view.onNavigate).toHaveBeenCalledWith('publish') })
})

it('does not redirect from discovery when a background upload succeeds', async () => {
  const item = publication('background-upload'), pending = Promise.withResolvers<MarketPublication>()
  onTestFinished(() => { pending.resolve(item) })
  const uploadArchive = vi.fn<MarketBrowserActions['uploadArchive']>().mockReturnValue(pending.promise)
  const view = mount(operations({ previewArchive: async () => item.manifest,
    prepareArchive: async bytes => ({ bytes, manifest: item.manifest }), uploadArchive }), 'upload')
  chooseFile()
  await screen.findByText(marketEn.browserPreparedArchive)
  fireEvent.click(screen.getByRole('button', { name: marketEn.upload }))
  await waitFor(() => { expect(uploadArchive).toHaveBeenCalledOnce() })
  view.show('discover')
  await act(async () => { pending.resolve({ ...item, status: 'draft' }); await pending.promise })
  expect(view.reportOutcome).toHaveBeenCalledWith('draftDone', false)
  expect(view.onNavigate).not.toHaveBeenCalledWith('publish')
})

it('hides retained preview data and ignores upload completion after the verified account changes', async () => {
  const item = publication('private-upload-preview'), pending = Promise.withResolvers<MarketPublication>()
  onTestFinished(() => { pending.resolve(item) })
  let current = identity
  const uploadArchive = vi.fn<MarketBrowserActions['uploadArchive']>().mockReturnValueOnce(pending.promise)
    .mockResolvedValue({ ...item, status: 'draft' })
  const view = mount(operations({ identity: async () => current, previewArchive: async () => item.manifest,
    prepareArchive: async bytes => ({ bytes, manifest: item.manifest }), uploadArchive }), 'upload')
  chooseFile()
  await screen.findByRole('heading', { name: item.manifest.title })
  fireEvent.click(screen.getByRole('button', { name: marketEn.upload }))
  await waitFor(() => { expect(uploadArchive).toHaveBeenCalledOnce() })
  current = { ...identity, accountId: brandString<MarketIdentity['accountId']>('d'.repeat(16)) }
  fireEvent.click(screen.getByRole('button', { name: marketEn.refresh }))
  await waitFor(() => { expect(screen.queryByRole('heading', { name: item.manifest.title })).toBeNull() })
  await act(async () => { pending.resolve({ ...item, status: 'draft' }); await pending.promise })
  expect(view.reportOutcome).not.toHaveBeenCalledWith('draftDone', false)
  expect(view.onNavigate).not.toHaveBeenCalledWith('publish')
  expect(screen.getByRole('button', { name: marketEn.retryUpload }).hasAttribute('disabled')).toBe(true)
  current = identity
  fireEvent.click(screen.getByRole('button', { name: marketEn.refresh }))
  await waitFor(() => { expect(screen.getByRole('button', { name: marketEn.retryUpload }).hasAttribute('disabled')).toBe(false) })
  fireEvent.click(screen.getByRole('button', { name: marketEn.retryUpload }))
  await waitFor(() => { expect(uploadArchive).toHaveBeenCalledTimes(2) })
  expect(uploadArchive.mock.calls[1]).toEqual(uploadArchive.mock.calls[0])
})

it('blocks a prepared upload when a fresh identity belongs to another account', async () => {
  const item = publication('anime-3d-assets'), uploadArchive = vi.fn<MarketBrowserActions['uploadArchive']>()
  const changed = { ...identity, accountId: brandString<MarketIdentity['accountId']>('d'.repeat(16)) }
  const readIdentity = vi.fn<MarketBrowserActions['identity']>().mockResolvedValueOnce(identity).mockResolvedValue(changed)
  const view = mount(operations({ identity: readIdentity, previewArchive: async () => item.manifest,
    prepareArchive: async bytes => ({ bytes, manifest: item.manifest }), uploadArchive }), 'upload')
  chooseFile()
  await screen.findByText(marketEn.browserPreparedArchive)
  fireEvent.click(screen.getByRole('button', { name: marketEn.upload }))
  await waitFor(() => { expect(view.reportOutcome).toHaveBeenCalledWith('signInRequired', true) })
  expect(uploadArchive).not.toHaveBeenCalled()
  expect(screen.getByRole('button', { name: marketEn.retryUpload }).hasAttribute('disabled')).toBe(true)
})

it('discards an old account private catalog when a refresh confirms a different identity', async () => {
  const pending = Promise.withResolvers<ReturnType<MarketBrowserActions['catalog']> extends Promise<infer T> ? T : never>()
  onTestFinished(() => { pending.resolve([]) })
  const changed = { ...identity, accountId: brandString<MarketIdentity['accountId']>('d'.repeat(16)), publishers: [] }
  const readIdentity = vi.fn<MarketBrowserActions['identity']>().mockResolvedValueOnce(identity).mockResolvedValue(changed)
  const catalog = vi.fn<MarketBrowserActions['catalog']>().mockReturnValueOnce(pending.promise).mockResolvedValue([])
  mount(operations({ identity: readIdentity, catalog }), 'publish')
  await waitFor(() => { expect(catalog).toHaveBeenCalledOnce() })
  fireEvent.click(screen.getByRole('button', { name: marketEn.refresh }))
  await waitFor(() => { expect(catalog).toHaveBeenCalledTimes(2) })
  await act(async () => { pending.resolve([{ ...publication('private-skill'), status: 'draft' }]); await pending.promise })
  expect(screen.queryByRole('heading', { name: 'private-skill' })).toBeNull()
  expect(screen.getByText(marketEn.noPublications)).toBeTruthy()
})

it('rechecks identity before displaying a private catalog that finished after an account switch', async () => {
  const pending = Promise.withResolvers<Awaited<ReturnType<MarketBrowserActions['catalog']>>>()
  onTestFinished(() => { pending.resolve([]) })
  const changed = { ...identity, accountId: brandString<MarketIdentity['accountId']>('d'.repeat(16)), publishers: [] }
  const readIdentity = vi.fn<MarketBrowserActions['identity']>().mockResolvedValueOnce(identity).mockResolvedValue(changed)
  const catalog = vi.fn<MarketBrowserActions['catalog']>().mockReturnValue(pending.promise)
  mount(operations({ identity: readIdentity, catalog }), 'publish')
  await waitFor(() => { expect(catalog).toHaveBeenCalledOnce() })
  await act(async () => {
    pending.resolve([{ ...publication('old-account-draft'), status: 'draft' }])
    await pending.promise
  })
  expect(screen.queryByRole('heading', { name: 'old-account-draft' })).toBeNull()
  expect(readIdentity).toHaveBeenCalledTimes(2)
  expect(screen.getByText(marketEn.publishedReadFailed)).toBeTruthy()
})

it('does not save a private download that finishes after the account changes', async () => {
  const draft = { ...publication('private-download'), status: 'draft' as const }
  const file = { name: 'private-download.zip', bytes: Uint8Array.of(80, 75) }
  const pending = Promise.withResolvers<Awaited<ReturnType<MarketBrowserActions['downloadPublication']>>>()
  onTestFinished(() => { pending.resolve(file) })
  let currentIdentity = identity
  const readIdentity = vi.fn<MarketBrowserActions['identity']>(async () => currentIdentity)
  const downloadPublication = vi.fn<MarketBrowserActions['downloadPublication']>().mockReturnValue(pending.promise)
  const OriginalURL = URL
  vi.stubGlobal('URL', class extends OriginalURL {
    static override createObjectURL = vi.fn(() => 'blob:private-download')
    static override revokeObjectURL = vi.fn()
  })
  const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
  const view = mount(operations({ identity: readIdentity, catalog: async () => [draft], downloadPublication }), 'publish')
  await screen.findByRole('heading', { name: draft.manifest.title })
  fireEvent.click(screen.getByRole('button', { name: marketEn.browserDownload }))
  await waitFor(() => { expect(downloadPublication).toHaveBeenCalledOnce() })
  const observations = readIdentity.mock.calls.length
  currentIdentity = { ...identity, accountId: brandString<MarketIdentity['accountId']>('d'.repeat(16)), publishers: [] }
  await act(async () => { pending.resolve(file); await pending.promise })
  expect(click).not.toHaveBeenCalled()
  expect(view.reportOutcome).not.toHaveBeenCalledWith('browserDownloaded', false)
  expect(readIdentity).toHaveBeenCalledTimes(observations + 1)
  expect(screen.queryByRole('heading', { name: draft.manifest.title })).toBeNull()
})

it.each(['publish', 'upload'] as const)('shows a retryable network error when %s identity loading fails', async (view) => {
  const identityRead = vi.fn<MarketBrowserActions['identity']>()
    .mockRejectedValueOnce(new RemoteError('muse-market/cloud-failed', 'Unavailable', { code: 'cloud-unavailable', status: 503 }))
    .mockResolvedValue(identity)
  mount(operations({ identity: identityRead }), view)
  expect((await screen.findByRole('alert')).textContent).toBe(marketEn.cloudUnavailable)
  fireEvent.click(screen.getByRole('button', { name: marketEn.retry }))
  await waitFor(() => { expect(screen.queryByRole('alert')).toBeNull() })
  expect(identityRead.mock.calls.length).toBeGreaterThan(1)
})

it.each(['publish', 'upload'] as const)('offers sign-in when %s identity loading returns 401', async (view) => {
  mount(operations({ identity: async () => {
    throw new RemoteError('muse-market/cloud-failed', 'Signed out', { code: 'login-required', status: 401 })
  } }), view)
  const alert = await screen.findByRole('alert')
  expect(alert.textContent).toBe(marketEn.signInRequired)
  expect(within(alert.parentElement!).getByRole('link', { name: marketEn.browserSignIn }).getAttribute('href')).toBe('/login')
})

it('keeps a transient verification failure as a cloud error instead of claiming sign-in is required', async () => {
  const item = publication('verification-retry'), uploadArchive = vi.fn<MarketBrowserActions['uploadArchive']>()
  const identityRead = vi.fn<MarketBrowserActions['identity']>().mockResolvedValueOnce(identity)
    .mockRejectedValue(new RemoteError('muse-market/cloud-failed', 'Unavailable', { code: 'cloud-unavailable', status: 503 }))
  const view = mount(operations({ identity: identityRead, previewArchive: async () => item.manifest,
    prepareArchive: async bytes => ({ bytes, manifest: item.manifest }), uploadArchive }), 'upload')
  chooseFile()
  await screen.findByText(marketEn.browserPreparedArchive)
  fireEvent.click(screen.getByRole('button', { name: marketEn.upload }))
  await waitFor(() => { expect(view.reportOutcome).toHaveBeenCalledWith('cloudUnavailable', true) })
  expect(view.reportOutcome).not.toHaveBeenCalledWith('signInRequired', true)
  expect(uploadArchive).not.toHaveBeenCalled()
})

it('keeps the persistent upload panel out of discovery accessibility queries', async () => {
  const view = mount(operations({ identity: async () => {
    throw new RemoteError('muse-market/cloud-failed', 'Unavailable', { code: 'cloud-unavailable', status: 503 })
  } }))
  await waitFor(() => { expect(view.container.querySelector('div[hidden] [role=alert]')).not.toBeNull() })
  expect(screen.getByRole('button', { name: marketEn.creatorUploadZip })).toBeTruthy()
  expect(view.container.querySelector('div[hidden] input[type=file]')).not.toBeNull()
  expect(screen.queryByRole('region', { name: marketEn.creatorUploadZip })).toBeNull()
  expect(screen.queryByRole('combobox')).toBeNull()
  expect(screen.queryByRole('button', { name: marketEn.upload })).toBeNull()
  expect(screen.queryByRole('alert')).toBeNull()
  view.show('upload')
  await screen.findByRole('alert')
  expect(screen.getAllByRole('combobox')).toHaveLength(1)
})

it.each(['invalid-archive', 'invalid-skill', 'skill-only', 'file-mismatch'])('localizes raw browser format refusal %s', (code) => {
  expect(marketFailureOutcome(Object.assign(new Error('Upstream detail'), { code }))).toBe('invalidPackage')
})
