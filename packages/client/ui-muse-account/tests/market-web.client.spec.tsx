// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { MarketSection } from '../src/client/MarketSection.tsx'
import { MarketBrowserUpload } from '../src/client/MarketBrowserUpload.tsx'
import type { MarketWebActions } from '../src/client/market-web-types.ts'
import { marketFixture } from './market-fixture.client.ts'

afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers() })
function fixture() {
  const release = { ...marketFixture[0]!, status: 'draft' as const }
  const actions = {
    archiveBytes: 1048576,
    catalog: vi.fn<MarketWebActions['catalog']>(async (_q, _kind, mine) => mine ? [release] : []),
    identity: vi.fn<MarketWebActions['identity']>(async () => ({ publishers: [{ id: release.publisherId, title: release.publisher }], admin: false })),
    review: vi.fn<MarketWebActions['review']>(async () => ({ ...release, status: 'pending', revision: 2 })),
    previewArchive: vi.fn<MarketWebActions['previewArchive']>(async () => release.manifest),
    uploadArchive: vi.fn<MarketWebActions['uploadArchive']>(async () => release),
    downloadArchive: vi.fn<MarketWebActions['downloadArchive']>(async () => ({ name: 'bot.zip', bytes: new Uint8Array([1, 2]) })),
  } satisfies MarketWebActions
  return { release, actions, reportOutcome: vi.fn(), t: (key: string) => key }
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
  expect(f.actions.uploadArchive).not.toHaveBeenCalled()
})

it('keeps public discovery usable for anonymous visitors and explains where private drafts appear', async () => {
  const f = fixture(); f.actions.identity.mockRejectedValue(Error('login-required'))
  render(<MarketSection {...f} mode="web" />)
  expect(await screen.findByText('emptyWebDiscoveryHint')).toBeDefined()
  expect(screen.getByRole('link', { name: 'browserSignIn' })).toBeDefined()
  const creator = screen.getAllByRole('button', { name: 'publish' })[0]!
  fireEvent.click(creator)
  expect(await screen.findByText('browserSignInHint')).toBeDefined()
  expect(f.actions.catalog).not.toHaveBeenCalledWith('', '', true)
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

it('recommends a Bot portrait by purpose and uploads the portrait chosen in preview', async () => {
  const f = fixture(), onUploaded = vi.fn()
  f.actions.previewArchive.mockResolvedValueOnce({
    ...f.release.manifest, name: 'film-color-grading', title: '电影调色师', category: '影视后期',
    description: '为短剧统一色彩，调整镜头的色彩风格。',
  })
  render(<MarketBrowserUpload {...f} publishers={[{ id: f.release.publisherId, title: f.release.publisher }]} onUploaded={onUploaded} />)
  const archive = new Uint8Array([4, 5, 6])
  fireEvent.change(screen.getByLabelText('browserArchive'), { target: { files: [file(archive)] } })
  const picker = await screen.findByRole('combobox', { name: 'releasePortrait' })
  expect(picker).toHaveProperty('value', 'colorist')
  const recommendedUrl = screen.getByRole('img', { name: '电影调色师' }).getAttribute('src')
  expect(recommendedUrl).toBeTruthy()
  expect(f.actions.uploadArchive).not.toHaveBeenCalled()

  fireEvent.change(picker, { target: { value: 'coding-assistant' } })
  expect(picker).toHaveProperty('value', 'coding-assistant')
  expect(screen.getByRole('img', { name: '电影调色师' }).getAttribute('src')).not.toBe(recommendedUrl)
  fireEvent.click(screen.getByRole('button', { name: 'upload' }))
  await waitFor(() => { expect(onUploaded).toHaveBeenCalledWith(f.release) })
  expect(f.actions.uploadArchive).toHaveBeenCalledWith(archive, f.release.publisherId, expect.any(String), 'coding-assistant')
})

it('keeps a preset stored in a Bot archive when opening its upload preview', async () => {
  const f = fixture(), onUploaded = vi.fn()
  f.actions.previewArchive.mockResolvedValueOnce({ ...f.release.manifest, presetPortrait: 'coding-assistant' })
  render(<MarketBrowserUpload {...f} publishers={[{ id: f.release.publisherId, title: f.release.publisher }]} onUploaded={onUploaded} />)
  const archive = new Uint8Array([7, 8, 9])
  fireEvent.change(screen.getByLabelText('browserArchive'), { target: { files: [file(archive)] } })
  expect(await screen.findByRole('combobox', { name: 'releasePortrait' })).toHaveProperty('value', 'coding-assistant')
  fireEvent.click(screen.getByRole('button', { name: 'upload' }))
  await waitFor(() => { expect(onUploaded).toHaveBeenCalledWith(f.release) })
  expect(f.actions.uploadArchive).toHaveBeenCalledWith(archive, f.release.publisherId, expect.any(String), 'coding-assistant')
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
