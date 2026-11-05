// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { MarketCreatorPage } from '../src/client/MarketCreatorPage.tsx'
import type { MarketActions } from '../src/client/market-mount.ts'
import { marketFixture, marketBotFixture } from './market-fixture.client.ts'

afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers() })

const skill = marketFixture.find(row => row.manifest.kind === 'skill')!
const draft = { ...skill, status: 'draft' as const }

function harness() {
  const actions = {
    catalog: vi.fn<MarketActions['catalog']>(),
    legacyCatalog: vi.fn<MarketActions['legacyCatalog']>(),
    installed: vi.fn<MarketActions['installed']>(async () => []),
    identity: vi.fn<MarketActions['identity']>(async () => ({ publishers: [{ id: draft.publisherId, title: 'Studio' }], admin: false })),
    sources: vi.fn<MarketActions['sources']>(async () => ({ website: 'https://muse.test/market',
      skills: [{ name: 'review', description: 'Review scenes' }, { name: 'script', description: 'Write a script' }] })),
    prepare: vi.fn<MarketActions['prepare']>(async () => ({ release: draft, enabled: false })),
    publishDraft: vi.fn<MarketActions['publishDraft']>(async () => draft),
    install: vi.fn(), installLegacy: vi.fn(), enable: vi.fn(), remove: vi.fn(),
    exportPackage: vi.fn(), importPackage: vi.fn(), review: vi.fn(),
  } satisfies MarketActions
  return { actions, t: (key: string) => key, onBack: vi.fn(), reportOutcome: vi.fn() }
}

it('prepares one selected local Skill for export even without a publishing login', async () => {
  const props = harness()
  props.actions.identity.mockRejectedValueOnce(new Error('login-required'))
  render(<MarketCreatorPage {...props} />)
  expect(screen.getByRole('heading', { name: 'creatorTitle' })).toBeDefined()
  const review = await screen.findByRole('radio', { name: 'review' })
  expect(screen.queryByRole('combobox', { name: 'sourceBot' })).toBeNull()
  const prepare = screen.getByRole<HTMLButtonElement>('button', { name: 'prepare' })
  expect(prepare.disabled).toBe(true)
  fireEvent.click(screen.getByRole('radio', { name: 'script' }))
  fireEvent.click(review)
  expect(screen.getByRole<HTMLInputElement>('radio', { name: 'script' }).checked).toBe(false)
  for (const [name, value] of Object.entries({ name: 'review', label: 'Scene review', summary: 'Check scenes', license: 'MIT', category: 'script' })) {
    fireEvent.change(screen.getByRole('textbox', { name }), { target: { value } })
  }
  fireEvent.click(prepare)

  expect(props.actions.prepare).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ kind: 'skill', name: 'review', skills: [] }), ['review'])
  expect((await screen.findByRole<HTMLButtonElement>('button', { name: 'export' })).disabled).toBe(false)
  expect(screen.getByRole<HTMLButtonElement>('button', { name: 'upload' }).disabled).toBe(true)
  expect(props.actions.publishDraft).not.toHaveBeenCalled()
  expect(props.actions.catalog).not.toHaveBeenCalled()
  expect(props.actions.legacyCatalog).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: 'creatorBack' }))
  expect(props.onBack).toHaveBeenCalledOnce()
})

it('offers local prepared ZIP packages and uploads only the explicitly selected package', async () => {
  const props = harness()
  props.actions.installed.mockResolvedValue([
    { release: draft, enabled: false },
    { release: { ...draft, id: '2'.repeat(64) as typeof draft.id, manifest: { ...draft.manifest, title: 'Original archive' } },
      enabled: false, legacySource: { id: 'muse/skills/review', sha256: 'f'.repeat(64) } },
    { release: { ...skill, id: '3'.repeat(32) as typeof draft.id, manifest: { ...skill.manifest, title: 'Cloud download' } }, enabled: false },
    { release: { ...marketBotFixture, status: 'draft' }, enabled: false },
  ])
  render(<MarketCreatorPage {...props} initialKind="upload" />)
  const selector = await screen.findByRole('combobox', { name: 'localPackages' })
  expect(screen.getAllByRole('option').some(option => option.textContent?.includes('Original archive'))).toBe(false)
  expect(screen.getAllByRole('option').some(option => option.textContent?.includes('Cloud download'))).toBe(false)
  expect(screen.queryByRole('option', { name: /Historical Bot/u })).toBeNull()
  fireEvent.change(selector, { target: { value: draft.id } })
  expect(props.actions.publishDraft).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: 'upload' }))
  expect(props.actions.publishDraft).toHaveBeenCalledExactlyOnceWith(draft.id, draft.publisherId, expect.any(String), 'horizontal-storyboard-director')
  expect(await screen.findByRole('dialog', { name: draft.manifest.title })).toBeDefined()
  expect(props.actions.catalog).not.toHaveBeenCalled()
})

it('rejects a Bot returned by an older ZIP import without offering upload or export', async () => {
  const props = harness()
  props.actions.importPackage.mockResolvedValue({ release: marketBotFixture, enabled: false })
  render(<MarketCreatorPage {...props} initialKind="upload" />)
  const file = new File(['ZIP'], 'historic-bot.zip')
  Object.defineProperty(file, 'arrayBuffer', { value: async () => new TextEncoder().encode('ZIP').buffer })
  fireEvent.change(await screen.findByLabelText('browserArchive'), { target: { files: [file] } })
  await waitFor(() => { expect(props.reportOutcome).toHaveBeenCalledWith('error.skill-only', true) })
  expect(screen.queryByRole('button', { name: 'upload' })).toBeNull()
  expect(screen.queryByRole('button', { name: 'export' })).toBeNull()
  expect(props.actions.publishDraft).not.toHaveBeenCalled()
})

it('automatically matches the imported Skill ZIP portrait and passes it with the confirmed upload', async () => {
  const props = harness()
  const source = marketFixture[0]!
  const imported = { ...source, status: 'draft' as const,
    manifest: { ...source.manifest, title: '电影调色师', category: '影视后期', description: '为短剧统一色彩。' } }
  props.actions.importPackage.mockResolvedValue({ release: imported, enabled: false })
  props.actions.publishDraft.mockResolvedValue(imported)
  render(<MarketCreatorPage {...props} initialKind="upload" />)
  const file = new File(['ZIP'], 'colorist.zip', { type: 'application/zip' })
  Object.defineProperty(file, 'arrayBuffer', { value: async () => new TextEncoder().encode('ZIP').buffer })
  fireEvent.change(await screen.findByLabelText('browserArchive'), { target: { files: [file] } })
  const portrait = await screen.findByRole('img', { name: imported.manifest.title })
  expect(portrait.getAttribute('src')).toContain('colorist')
  expect(screen.queryByRole('combobox', { name: 'releasePortrait' })).toBeNull()
  expect(props.actions.importPackage).toHaveBeenCalledExactlyOnceWith('WklQ')
  expect(props.actions.publishDraft).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: 'upload' }))
  expect(props.actions.publishDraft).toHaveBeenCalledExactlyOnceWith(imported.id, draft.publisherId, expect.any(String), 'colorist')
  expect(await screen.findByRole('dialog', { name: imported.manifest.title })).toBeDefined()
})

it('retries a failed authoring identity and renders source availability from the new read', async () => {
  const props = harness()
  props.actions.identity.mockRejectedValueOnce(Error('cloud-unavailable'))
  props.actions.sources.mockResolvedValue({ website: 'https://muse.test/market', skills: [] })
  render(<MarketCreatorPage {...props} initialKind="skill" />)
  expect(await screen.findByRole('alert')).toHaveProperty('textContent', 'error.cloud-unavailable')
  fireEvent.click(screen.getByRole('button', { name: 'retry' }))
  expect(await screen.findByText('creatorNoSkills')).toBeDefined()
  expect(screen.queryByRole('button', { name: 'creatorNewBot' })).toBeNull()
  expect(screen.getByRole<HTMLButtonElement>('button', { name: 'prepare' }).disabled).toBe(true)
  expect(props.actions.identity).toHaveBeenCalledTimes(2)
})

it.each(['resolved', 'rejected'] as const)('ignores an authoring read that %s after its adapter is replaced', async (outcome) => {
  const old = harness(), replacement = harness()
  const first = Promise.withResolvers<Awaited<ReturnType<MarketActions['identity']>>>()
  old.actions.identity.mockReturnValueOnce(first.promise)
  const view = render(<MarketCreatorPage {...old} />)
  view.rerender(<MarketCreatorPage {...replacement} />)
  expect(await screen.findByRole('radio', { name: 'review' })).toBeDefined()

  await act(async () => {
    if (outcome === 'resolved') first.resolve({ admin: false, publishers: [] })
    else first.reject(Error('cloud-unavailable'))
  })
  expect(screen.queryByRole('alert')).toBeNull()
  expect(screen.getByRole('option', { name: 'Studio' })).toBeDefined()
})

it('explains that the web authoring page requires sign-in', async () => {
  const props = harness()
  const unavailable = async (): Promise<never> => { throw Error('unused') }
  render(<MarketCreatorPage mode="web" initialKind="upload" actions={{
    archiveBytes: 4096, identity: async () => { throw Error('login-required') }, catalog: async () => [],
    legacyCatalog: async () => [], review: unavailable, previewArchive: unavailable, uploadArchive: unavailable,
    downloadArchive: unavailable,
  }} onBack={props.onBack} t={props.t} reportOutcome={props.reportOutcome} />)

  expect(await screen.findByText('browserSignInHint')).toBeDefined()
  expect(screen.getByRole('link', { name: 'browserSignIn' }).getAttribute('href')).toBe('/login')
  expect(screen.queryByLabelText('browserArchive')).toBeNull()
})

it('prepares the selected Skill once, exports its bytes and supports changing the publishing team', async () => {
  const props = harness()
  const bot = marketFixture[0]!
  const release = { ...bot, status: 'draft' as const, manifest: { ...bot.manifest, presetPortrait: 'video-editor' as const } }
  const other = { id: 'd'.repeat(32), title: 'Other studio' }
  const first = Promise.withResolvers<Awaited<ReturnType<MarketActions['prepare']>>>()
  props.actions.sources.mockResolvedValue({ website: 'https://muse.test/market',
    skills: [{ name: 'review', description: 'Review' }, { name: 'script', description: 'Write' }] })
  props.actions.identity.mockResolvedValue({ publishers: [{ id: release.publisherId, title: 'Studio' }, other], admin: false })
  props.actions.prepare.mockReturnValueOnce(first.promise)
  props.actions.publishDraft.mockResolvedValue(release)
  props.actions.exportPackage.mockResolvedValue({ name: 'editor.zip', base64: 'WklQ' })
  const create = vi.fn(() => 'blob:editor'), revoke = vi.fn()
  class DownloadURL extends URL {
    static override createObjectURL = create
    static override revokeObjectURL = revoke
  }
  vi.stubGlobal('URL', DownloadURL)
  const download = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
  render(<MarketCreatorPage {...props} />)
  await screen.findByRole('radio', { name: 'review' })
  expect(screen.queryByRole('button', { name: 'creatorNewBot' })).toBeNull()
  fireEvent.click(screen.getByRole('radio', { name: 'review' }))
  fireEvent.click(screen.getByRole('radio', { name: 'script' }))
  for (const [name, value] of Object.entries({
    name: 'film-editor', label: '电影剪辑师', summary: '镜头剪辑与后期', license: 'MIT', category: '影视后期',
  })) fireEvent.change(screen.getByRole('textbox', { name }), { target: { value } })
  const form = screen.getByRole('button', { name: 'prepare' }).closest('form')!
  fireEvent.submit(form)
  fireEvent.submit(form)
  expect(props.actions.prepare).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({ kind: 'skill', name: 'film-editor', presetPortrait: 'video-editor' }), ['script'],
  )

  await act(async () => { first.resolve({ release, enabled: false }) })
  vi.useFakeTimers({ toFake: ['setTimeout'] })
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'export' })) })
  expect(props.actions.exportPackage).toHaveBeenCalledExactlyOnceWith(release.id)
  expect(download).toHaveBeenCalledOnce()
  await act(async () => { await vi.runAllTimersAsync() })
  expect(revoke).toHaveBeenCalledExactlyOnceWith('blob:editor')
  vi.useRealTimers()

  fireEvent.click(screen.getByRole('button', { name: 'upload' }))
  const details = await screen.findByRole('dialog', { name: release.manifest.title })
  fireEvent.click(within(details).getByRole('button', { name: 'close' }))
  expect(screen.getByRole<HTMLButtonElement>('button', { name: 'upload' }).disabled).toBe(true)
  fireEvent.change(screen.getByRole('combobox', { name: 'publisher' }), { target: { value: other.id } })
  expect(screen.getByRole<HTMLButtonElement>('button', { name: 'upload' }).disabled).toBe(false)
  fireEvent.click(screen.getByRole('button', { name: 'upload' }))
  await screen.findByRole('dialog', { name: release.manifest.title })
  expect(props.actions.publishDraft).toHaveBeenLastCalledWith(release.id, other.id, expect.any(String))
})

it('does not apply a preparation that completes after the authoring adapter changes', async () => {
  const old = harness(), replacement = harness()
  const pending = Promise.withResolvers<Awaited<ReturnType<MarketActions['prepare']>>>()
  old.actions.prepare.mockReturnValueOnce(pending.promise)
  const view = render(<MarketCreatorPage {...old} />)
  fireEvent.click(await screen.findByRole('radio', { name: 'review' }))
  fireEvent.submit(screen.getByRole('button', { name: 'prepare' }).closest('form')!)
  expect(old.actions.prepare).toHaveBeenCalledOnce()
  view.rerender(<MarketCreatorPage {...replacement} />)
  await screen.findByRole('radio', { name: 'review' })

  await act(async () => { pending.resolve({ release: draft, enabled: false }) })
  expect(screen.queryByText('creatorPrepared')).toBeNull()
  expect(old.reportOutcome).toHaveBeenCalledExactlyOnceWith('done', false)
})

it('rejects oversized ZIPs before reading them and reuses a successfully imported package', async () => {
  const props = harness()
  props.actions.importPackage.mockResolvedValue({ release: draft, enabled: false })
  render(<MarketCreatorPage {...props} initialKind="upload" />)
  const picker = await screen.findByLabelText('browserArchive')
  fireEvent.change(picker, { target: { files: [] } })
  const tooLarge = new File([], 'large.zip')
  const read = vi.fn()
  Object.defineProperties(tooLarge, { size: { value: 64 * 1024 * 1024 + 1 }, arrayBuffer: { value: read } })
  fireEvent.change(picker, { target: { files: [tooLarge] } })
  await waitFor(() => { expect(props.reportOutcome).toHaveBeenCalledWith('error.expanded-limit', true) })
  expect(read).not.toHaveBeenCalled()
  expect(props.actions.importPackage).not.toHaveBeenCalled()

  const zip = new File(['ZIP'], 'skill.zip')
  Object.defineProperty(zip, 'arrayBuffer', { value: async () => new TextEncoder().encode('ZIP').buffer })
  fireEvent.change(picker, { target: { files: [zip] } })
  await screen.findByText('creatorPrepared')
  await act(async () => { fireEvent.change(picker, { target: { files: [zip] } }) })
  expect(props.actions.importPackage).toHaveBeenCalledTimes(2)
  expect(screen.getAllByRole('option', { name: draft.manifest.title + ' · ' + draft.manifest.version })).toHaveLength(1)
})

it.each(['file-read', 'Host-import', 'Host-export'] as const)('ignores retired ZIP work at %s', async (stage) => {
  const old = harness(), replacement = harness()
  const file = new File(['ZIP'], 'skill.zip')
  const bytes = Promise.withResolvers<ArrayBuffer>()
  const imported = Promise.withResolvers<Awaited<ReturnType<MarketActions['importPackage']>>>()
  const exported = Promise.withResolvers<Awaited<ReturnType<MarketActions['exportPackage']>>>()
  const encoded = new TextEncoder().encode('ZIP').buffer
  Object.defineProperty(file, 'arrayBuffer', { value: () => stage === 'file-read' ? bytes.promise : Promise.resolve(encoded) })
  old.actions.importPackage.mockImplementation(() => stage === 'Host-import' ? imported.promise : Promise.resolve({ release: draft, enabled: false }))
  old.actions.exportPackage.mockReturnValue(exported.promise)
  const view = render(<MarketCreatorPage {...old} initialKind="upload" />)
  fireEvent.change(await screen.findByLabelText('browserArchive'), { target: { files: [file] } })
  if (stage === 'Host-import') await waitFor(() => { expect(old.actions.importPackage).toHaveBeenCalledOnce() })
  if (stage === 'Host-export') fireEvent.click(await screen.findByRole('button', { name: 'export' }))
  view.rerender(<MarketCreatorPage {...replacement} initialKind="upload" />)
  await screen.findByLabelText('browserArchive')

  await act(async () => {
    bytes.resolve(encoded)
    imported.resolve({ release: draft, enabled: false })
    exported.resolve({ name: 'retired.zip', base64: 'WklQ' })
  })
  expect(screen.queryByText('creatorPrepared')).toBeNull()
  if (stage === 'file-read') expect(old.actions.importPackage).not.toHaveBeenCalled()
  expect(old.reportOutcome).toHaveBeenLastCalledWith('done', false)
})

it('reports a confirmed upload after changing the authoring adapter without opening retired details', async () => {
  const old = harness(), replacement = harness()
  const response = Promise.withResolvers<typeof draft>()
  old.actions.installed.mockResolvedValue([{ release: draft, enabled: false }])
  old.actions.publishDraft.mockReturnValueOnce(response.promise)
  const view = render(<MarketCreatorPage {...old} initialKind="upload" />)
  fireEvent.change(await screen.findByRole('combobox', { name: 'localPackages' }), { target: { value: draft.id } })
  fireEvent.click(screen.getByRole('button', { name: 'upload' }))
  view.rerender(<MarketCreatorPage {...replacement} initialKind="upload" />)
  await screen.findByLabelText('browserArchive')

  await act(async () => { response.resolve(draft) })
  expect(old.reportOutcome).toHaveBeenCalledExactlyOnceWith('draft', false)
  expect(screen.queryByRole('dialog')).toBeNull()
})
