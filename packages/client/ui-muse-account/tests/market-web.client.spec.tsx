// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { MarketCreatorPanel } from '../src/client/MarketPage.tsx'
import { MarketSection } from '../src/client/MarketSection.tsx'
import { MarketBrowserUpload } from '../src/client/MarketBrowserUpload.tsx'
import * as marketArtwork from '../src/client/market-stock-art.ts'
import type { MarketWebActions } from '../src/client/market-web-types.ts'
import { marketFixture } from './market-fixture.client.ts'

afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers() })
function fixture() {
  const release = { ...marketFixture[0]!, status: 'draft' as const }
  const actions = {
    archiveBytes: 1048576,
    legacyCatalog: vi.fn<MarketWebActions['legacyCatalog']>(async () => []),
    catalog: vi.fn<MarketWebActions['catalog']>(async (_q, _kind, mine) => mine ? [release] : []),
    identity: vi.fn<MarketWebActions['identity']>(async () => ({ publishers: [{ id: release.publisherId, title: release.publisher }], admin: false })),
    review: vi.fn<MarketWebActions['review']>(async () => ({ ...release, status: 'pending', revision: 2 })),
    previewArchive: vi.fn<MarketWebActions['previewArchive']>(async () => release.manifest),
    uploadArchive: vi.fn<MarketWebActions['uploadArchive']>(async () => release),
    downloadArchive: vi.fn<MarketWebActions['downloadArchive']>(async () => ({ name: 'bot.zip', bytes: new Uint8Array([1, 2]) })),
  } satisfies MarketWebActions
  return { release, actions, reportOutcome: vi.fn(), onOpenCreator: vi.fn(), t: (key: string) => key }
}
function file(bytes: Uint8Array, name = 'bot.zip'): File {
  const value = new File([Uint8Array.from(bytes)], name, { type: 'application/zip' })
  Object.defineProperty(value, 'arrayBuffer', { value: async () => Uint8Array.from(bytes).buffer })
  return value
}

it('opens creator drafts directly for the authenticated web view without local installation controls', async () => {
  const f = fixture()
  render(<MarketSection {...f} mode="web" initialView="publish" />)
  expect(await screen.findByText('publication.draft')).toBeDefined()
  expect(f.actions.catalog).toHaveBeenCalledWith('', '', true)
  expect(screen.queryByRole('button', { name: 'installed' })).toBeNull()
  expect(screen.queryByRole('button', { name: 'enable' })).toBeNull()
  expect(screen.getByRole('link', { name: 'browserAccount' }).getAttribute('href')).toBe('/account')
  expect(screen.queryByLabelText('browserArchive')).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'uploadEntry' }))
  expect(f.onOpenCreator).toHaveBeenCalledOnce()
  expect(f.actions.uploadArchive).not.toHaveBeenCalled()
})

it('opens the standalone upload form independently of creator drafts', async () => {
  const f = fixture(), onBack = vi.fn()
  render(<MarketCreatorPanel mode="web" actions={f.actions} getInitialKind={() => 'upload'} t={f.t}
    reportOutcome={f.reportOutcome} onBack={onBack} />)
  expect(await screen.findByLabelText('browserArchive')).toBeDefined()
  expect(screen.queryByText('publication.draft')).toBeNull()
  expect(f.actions.catalog).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: 'creatorBack' }))
  expect(onBack).toHaveBeenCalledOnce()
})

it('keeps public discovery usable for anonymous visitors and explains where private drafts appear', async () => {
  const f = fixture(); f.actions.identity.mockRejectedValue(Error('login-required'))
  render(<MarketSection {...f} mode="web" />)
  expect(await screen.findByText('emptyWebDiscoveryHint')).toBeDefined()
  expect(screen.getByRole('link', { name: 'browserSignIn' })).toBeDefined()
  const creator = within(screen.getByText('emptyWebDiscoveryHint').parentElement!).getByRole('button', { name: 'publish' })
  fireEvent.click(creator)
  expect(await screen.findByText('browserSignInHint')).toBeDefined()
  expect(f.actions.catalog).not.toHaveBeenCalledWith('', '', true)
})

it('offers the original archive download without installing it on the standalone market', async () => {
  const f = fixture()
  const href = 'https://muse.test/market/downloads/director.tgz'
  f.actions.legacyCatalog.mockResolvedValue([{ id: 'muse/bots/storyboard-director-16-9', kind: 'bot', title: 'Original director',
    description: 'Plan widescreen shots', category: 'script', version: '0.1.0', requirements: [], requiredSkills: [],
    validation: '', sha256: 'd'.repeat(64), href }])
  render(<MarketSection {...f} mode="web" />)
  const original = await screen.findByRole('link', { name: 'legacyDownload' })
  expect(original.getAttribute('href')).toBe(href)
  expect(original.hasAttribute('download')).toBe(true)
  expect(screen.queryByRole('button', { name: 'legacyImport' })).toBeNull()
})

it('starts a verified file download without claiming that the browser installed or enabled it', async () => {
  const f = fixture(), create = vi.fn(() => 'blob:verified-archive'), revoke = vi.fn()
  class DownloadURL extends URL {
    static override createObjectURL = create
    static override revokeObjectURL = revoke
  }
  vi.stubGlobal('URL', DownloadURL)
  const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
  render(<MarketSection {...f} mode="web" initialView="publish" />)
  const download = await screen.findByRole('button', { name: 'browserDownload' })
  await waitFor(() => { expect(download.hasAttribute('disabled')).toBe(false) })
  vi.useFakeTimers({ toFake: ['setTimeout'] })
  await act(async () => { fireEvent.click(download) })
  expect(f.actions.downloadArchive).toHaveBeenCalledWith(f.release)
  expect(click).toHaveBeenCalledOnce()
  expect(f.reportOutcome).toHaveBeenCalledWith('archiveDownloaded', false)
  expect(screen.queryByText('enabled')).toBeNull()
  await act(async () => { await vi.runAllTimersAsync() })
  expect(revoke).toHaveBeenCalledWith('blob:verified-archive')
})

it('previews a ZIP locally, requires confirmation and retains its idempotency key after upload failure', async () => {
  const f = fixture(), onUploaded = vi.fn()
  f.actions.uploadArchive.mockRejectedValueOnce(Error('cloud-unavailable'))
  render(<MarketBrowserUpload {...f} publishers={[{ id: f.release.publisherId, title: f.release.publisher }]} onUploaded={onUploaded} />)
  const archive = new Uint8Array([1, 2, 3])
  fireEvent.change(screen.getByLabelText('browserArchive'), { target: { files: [file(archive)] } })
  await screen.findByText('browserPreviewHint')
  expect(f.actions.previewArchive).toHaveBeenCalledWith(archive)
  expect(f.actions.uploadArchive).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: 'upload' }))
  await waitFor(() => { expect(f.reportOutcome).toHaveBeenCalledWith('error.cloud-unavailable', true) })
  expect(screen.getByText('bot.zip')).toBeDefined()
  expect(onUploaded).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: 'upload' }))
  await waitFor(() => { expect(onUploaded).toHaveBeenCalledWith(f.release) })
  const calls = f.actions.uploadArchive.mock.calls
  expect(calls[0]![2]).toBe(calls[1]![2])
  expect(calls[1]!.slice(0, 2)).toEqual([archive, f.release.publisherId])
})

it('refuses an oversized selection before preview or upload and retains bounded error copy', async () => {
  const f = fixture()
  render(<MarketBrowserUpload {...f} publishers={[{ id: f.release.publisherId, title: f.release.publisher }]} onUploaded={vi.fn()} />)
  fireEvent.change(screen.getByLabelText('browserArchive'), { target: { files: [file(new Uint8Array(f.actions.archiveBytes + 1))] } })
  expect(await screen.findByRole('alert')).toHaveProperty('textContent', 'error.archive-too-large')
  expect(f.actions.previewArchive).not.toHaveBeenCalled()
  expect(f.actions.uploadArchive).not.toHaveBeenCalled()
})

it('discards stale local previews after selecting a different file', async () => {
  const f = fixture(), old = Promise.withResolvers<ReturnType<MarketWebActions['previewArchive']> extends Promise<infer T> ? T : never>()
  f.actions.previewArchive.mockReturnValueOnce(old.promise)
  render(<MarketBrowserUpload {...f} publishers={[{ id: f.release.publisherId, title: f.release.publisher }]} onUploaded={vi.fn()} />)
  fireEvent.change(screen.getByLabelText('browserArchive'), { target: { files: [file(new Uint8Array([1]), 'old.zip')] } })
  await waitFor(() => { expect(f.actions.previewArchive).toHaveBeenCalledOnce() })
  fireEvent.change(screen.getByLabelText('browserArchive'), { target: { files: [file(new Uint8Array([2]), 'new.zip')] } })
  await screen.findByText('new.zip')
  await act(async () => { old.resolve({ ...f.release.manifest, title: 'Stale title' }) })
  expect(screen.queryByText('old.zip')).toBeNull()
  expect(screen.queryByText('Stale title')).toBeNull()
})

it('automatically matches a Bot portrait by purpose and binds the previewed preset on upload', async () => {
  const f = fixture(), onUploaded = vi.fn()
  f.actions.previewArchive.mockResolvedValueOnce({
    ...f.release.manifest, name: 'film-color-grading', title: '电影调色师', category: '影视后期',
    description: '为短剧统一色彩，调整镜头的色彩风格。',
  })
  render(<MarketBrowserUpload {...f} publishers={[{ id: f.release.publisherId, title: f.release.publisher }]} onUploaded={onUploaded} />)
  const archive = new Uint8Array([4, 5, 6])
  fireEvent.change(screen.getByLabelText('browserArchive'), { target: { files: [file(archive)] } })
  const portrait = await screen.findByRole('img', { name: '电影调色师' })
  expect(portrait.getAttribute('src')).toContain('colorist')
  expect(screen.queryByRole('combobox', { name: 'releasePortrait' })).toBeNull()
  expect(f.actions.uploadArchive).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: 'upload' }))
  await waitFor(() => { expect(onUploaded).toHaveBeenCalledWith(f.release) })
  expect(f.actions.uploadArchive).toHaveBeenCalledWith(archive, f.release.publisherId, expect.any(String), 'colorist')
})

it('previews a Bot archive with its saved portrait and uploads the existing binding', async () => {
  const f = fixture(), onUploaded = vi.fn()
  f.actions.previewArchive.mockResolvedValueOnce({ ...f.release.manifest, presetPortrait: 'coding-assistant' })
  render(<MarketBrowserUpload {...f} publishers={[{ id: f.release.publisherId, title: f.release.publisher }]} onUploaded={onUploaded} />)
  const archive = new Uint8Array([7, 8, 9])
  fireEvent.change(screen.getByLabelText('browserArchive'), { target: { files: [file(archive)] } })
  const portrait = await screen.findByRole('img', { name: f.release.manifest.title })
  expect(portrait.getAttribute('src')).toContain('coding-assistant')
  fireEvent.click(screen.getByRole('button', { name: 'upload' }))
  await waitFor(() => { expect(onUploaded).toHaveBeenCalledWith(f.release) })
  expect(f.actions.uploadArchive).toHaveBeenCalledWith(archive, f.release.publisherId, expect.any(String))
})

it('uploads a Skill archive without selecting a Bot portrait', async () => {
  const f = fixture(), onUploaded = vi.fn()
  f.actions.previewArchive.mockResolvedValueOnce(marketFixture[1]!.manifest)
  render(<MarketBrowserUpload {...f} publishers={[{ id: f.release.publisherId, title: f.release.publisher }]} onUploaded={onUploaded} />)
  const archive = new Uint8Array([10, 11, 12])
  fireEvent.change(screen.getByLabelText('browserArchive'), { target: { files: [file(archive, 'skill.zip')] } })
  await screen.findByText('browserPreviewHint')
  expect(screen.queryByRole('combobox', { name: 'releasePortrait' })).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'upload' }))
  await waitFor(() => { expect(onUploaded).toHaveBeenCalledWith(f.release) })
  expect(f.actions.uploadArchive).toHaveBeenCalledWith(archive, f.release.publisherId, expect.any(String))
})

it('keeps the browser upload form unavailable without an admitted publishing team', () => {
  const f = fixture()
  const onUploaded = vi.fn()
  render(<MarketBrowserUpload {...f} publishers={[]} onUploaded={onUploaded} />)
  const upload = screen.getByRole<HTMLButtonElement>('button', { name: 'upload' })

  expect(upload.disabled).toBe(true)
  expect(screen.getByRole('option', { name: 'noPublisher' })).toBeDefined()
  expect(screen.getByLabelText<HTMLInputElement>('browserArchive').disabled).toBe(true)
  fireEvent.submit(upload.closest('form')!)
  expect(f.actions.uploadArchive).not.toHaveBeenCalled()
  expect(onUploaded).not.toHaveBeenCalled()
})

it('keeps only the latest browser ZIP when an earlier file read or preflight rejects late', async () => {
  const f = fixture()
  const earlyFile = new File([Uint8Array.of(1)], 'first.zip', { type: 'application/zip' })
  const firstBytes = Promise.withResolvers<ArrayBuffer>()
  const secondPreview = Promise.withResolvers<typeof f.release.manifest>()
  Object.defineProperty(earlyFile, 'arrayBuffer', { value: () => firstBytes.promise })
  f.actions.previewArchive.mockReturnValueOnce(secondPreview.promise)
  render(<MarketBrowserUpload {...f} publishers={[{ id: f.release.publisherId, title: f.release.publisher }]} onUploaded={vi.fn()} />)
  const picker = screen.getByLabelText('browserArchive')

  fireEvent.change(picker, { target: { files: [] } })
  expect(f.actions.previewArchive).not.toHaveBeenCalled()
  fireEvent.change(picker, { target: { files: [earlyFile] } })
  fireEvent.change(picker, { target: { files: [file(new Uint8Array([2]), 'second.zip')] } })
  await waitFor(() => { expect(f.actions.previewArchive).toHaveBeenCalledOnce() })
  fireEvent.change(picker, { target: { files: [file(new Uint8Array([3]), 'current.zip')] } })
  expect(await screen.findByText('current.zip')).toBeDefined()

  await act(async () => {
    firstBytes.resolve(Uint8Array.of(1).buffer)
    secondPreview.reject(new Error('stale preflight'))
  })
  expect(f.actions.previewArchive).toHaveBeenCalledTimes(2)
  expect(screen.queryByRole('alert')).toBeNull()
  expect(screen.queryByText('first.zip')).toBeNull()
  expect(screen.queryByText('second.zip')).toBeNull()
})

it('uploads for the selected publisher and fences an overlapping form submission', async () => {
  const f = fixture(), onUploaded = vi.fn(), pending = Promise.withResolvers<typeof f.release>()
  const team = { id: 'b'.repeat(32), title: 'Other studio' }
  f.actions.uploadArchive.mockReturnValueOnce(pending.promise)
  render(<MarketBrowserUpload {...f} publishers={[{ id: f.release.publisherId, title: f.release.publisher }, team]}
    onUploaded={onUploaded} />)
  fireEvent.change(screen.getByRole('combobox', { name: 'publisher' }), { target: { value: team.id } })
  fireEvent.change(screen.getByLabelText('browserArchive'), { target: { files: [file(Uint8Array.of(2))] } })
  await screen.findByText('browserPreviewHint')
  const form = screen.getByRole('button', { name: 'upload' }).closest('form')!

  fireEvent.submit(form)
  fireEvent.submit(form)
  expect(f.actions.uploadArchive.mock.calls[0]?.[1]).toBe(team.id)
  expect(f.actions.uploadArchive).toHaveBeenCalledOnce()

  await act(async () => { pending.resolve(f.release) })
  expect(onUploaded).toHaveBeenCalledExactlyOnceWith(f.release)
})

it.each(['accepted', 'rejected'] as const)('suppresses an upload %s after the browser adapter is replaced', async (result) => {
  const old = fixture(), replacement = fixture(), onUploaded = vi.fn()
  const pending = Promise.withResolvers<typeof old.release>()
  const publishers = [{ id: old.release.publisherId, title: old.release.publisher }]
  old.actions.uploadArchive.mockReturnValueOnce(pending.promise)
  const view = render(<MarketBrowserUpload {...old} publishers={publishers} onUploaded={onUploaded} />)
  fireEvent.change(screen.getByLabelText('browserArchive'), { target: { files: [file(Uint8Array.of(5))] } })
  await screen.findByText('browserPreviewHint')
  fireEvent.click(screen.getByRole('button', { name: 'upload' }))
  view.rerender(<MarketBrowserUpload {...replacement} publishers={publishers} onUploaded={onUploaded} />)

  await act(async () => {
    if (result === 'accepted') pending.resolve(old.release)
    else pending.reject(Error('cloud-unavailable'))
  })
  expect(onUploaded).not.toHaveBeenCalled()
  expect(old.reportOutcome).not.toHaveBeenCalled()
  expect(screen.getByText('browserArchivePending')).toBeDefined()
  expect(screen.getByLabelText<HTMLInputElement>('browserArchive').disabled).toBe(false)
})

it('still previews the Bot description if the artwork resolver has no presentation', async () => {
  const f = fixture()
  vi.spyOn(marketArtwork, 'boundMarketPresentation').mockReturnValue(undefined)
  render(<MarketBrowserUpload {...f} publishers={[{ id: f.release.publisherId, title: f.release.publisher }]} onUploaded={vi.fn()} />)
  fireEvent.change(screen.getByLabelText('browserArchive'), { target: { files: [file(Uint8Array.of(1))] } })
  expect(await screen.findByText('stockArtworkHint')).toBeDefined()
  fireEvent.click(screen.getByText('introduce', { selector: 'button' }))
  expect(screen.getAllByText(f.release.manifest.description)).toHaveLength(2)
})
it('downloads a selected release directly from public discovery', async () => {
  const f = fixture(), published = { ...f.release, status: 'published' as const }
  f.actions.catalog.mockResolvedValueOnce([published])
  const revoke = vi.fn()
  class DownloadURL extends URL {
    static override createObjectURL = vi.fn(() => 'blob:published')
    static override revokeObjectURL = revoke
  }
  vi.stubGlobal('URL', DownloadURL)
  const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
  render(<MarketSection {...f} mode="web" />)
  const download = await screen.findByRole('button', { name: 'browserDownload' })
  vi.useFakeTimers({ toFake: ['setTimeout'] })

  await act(async () => { fireEvent.click(download) })
  expect(f.actions.downloadArchive).toHaveBeenCalledExactlyOnceWith(published)
  expect(f.reportOutcome).toHaveBeenCalledExactlyOnceWith('archiveDownloaded', false)
  expect(click).toHaveBeenCalledOnce()
  await act(async () => { await vi.runAllTimersAsync() })
  expect(revoke).toHaveBeenCalledWith('blob:published')
})

it.each(['resolved', 'rejected'] as const)('drops a Web download that %s after leaving the market', async (result) => {
  const f = fixture(), published = { ...f.release, status: 'published' as const }
  const pending = Promise.withResolvers<Awaited<ReturnType<MarketWebActions['downloadArchive']>>>()
  f.actions.catalog.mockResolvedValueOnce([published])
  f.actions.downloadArchive.mockReturnValueOnce(pending.promise)
  const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
  const view = render(<MarketSection {...f} mode="web" />)
  fireEvent.click(await screen.findByRole('button', { name: 'browserDownload' }))
  view.unmount()

  await act(async () => {
    if (result === 'resolved') pending.resolve({ name: 'retired.zip', bytes: Uint8Array.of(1) })
    else pending.reject(Error('cloud-unavailable'))
  })
  expect(f.reportOutcome).not.toHaveBeenCalled()
  expect(click).not.toHaveBeenCalled()
})

it('keeps a preview but prevents submission when publishing access changes', async () => {
  const f = fixture(), onUploaded = vi.fn()
  const view = render(<MarketBrowserUpload {...f} publishers={[{ id: f.release.publisherId, title: f.release.publisher }]}
    onUploaded={onUploaded} />)
  fireEvent.change(screen.getByLabelText('browserArchive'), { target: { files: [file(Uint8Array.of(2))] } })
  await screen.findByText('browserPreviewHint')
  view.rerender(<MarketBrowserUpload {...f} publishers={[{ id: 'other', title: 'Other team' }]} onUploaded={onUploaded} />)
  const upload = screen.getByRole<HTMLButtonElement>('button', { name: 'upload' })

  expect(upload.disabled).toBe(true)
  fireEvent.submit(upload.closest('form')!)
  expect(f.actions.uploadArchive).not.toHaveBeenCalled()
  expect(onUploaded).not.toHaveBeenCalled()
})
