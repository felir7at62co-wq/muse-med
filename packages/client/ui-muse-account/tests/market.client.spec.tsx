// @vitest-environment jsdom
import { act, cleanup, render, screen, fireEvent, waitFor, within } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { MarketSection, type MarketSectionProps } from '../src/client/MarketSection.tsx'
import type { MarketActions } from '../src/client/market-mount.ts'
import type { MarketInstallation, MarketRelease } from '@deepseek-ai/dsh-muse-market/types'
import { marketZh, marketEn } from '../src/client/market-locales.ts'
import { marketFixture, marketPresentations } from './market-fixture.client.ts'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

afterEach(cleanup)
const release: MarketRelease = { id: 'a'.repeat(32) as MarketRelease['id'], publisherId: 'b'.repeat(32) as MarketRelease['publisherId'],
  publisher: 'Team', sha256: 'c'.repeat(64), bytes: 1024, revision: 1, reviewNote: '', status: 'published', createdAt: '2026-11-02T00:00:00Z',
  manifest: { formatVersion: 1, kind: 'skill', name: 'review', title: 'Review scenes', description: 'Review every scene', version: '1.0.0',
    license: 'MIT', category: 'script', examples: [], requirements: [], skills: [{ name: 'review', path: 'skills/review/SKILL.md' }] } }
function harness() {
  let local: MarketInstallation[] = []
  const actions = {
    catalog: vi.fn<MarketActions['catalog']>(async () => [release]), installed: vi.fn(async () => local),
    sources: vi.fn<MarketActions['sources']>(async () => ({ website: 'https://muse.test/market', skills: [], bots: [] })),
    identity: vi.fn<MarketActions['identity']>(async () => ({ publishers: [], admin: false })),
    install: vi.fn<MarketActions['install']>(async () => { const item = { release, enabled: false }; local = [item]; return item }),
    enable: vi.fn<MarketActions['enable']>(async (_id, enabled) => { const item = { release, enabled }; local = [item]; return item }),
    remove: vi.fn(async () => { local = [] }), exportPackage: vi.fn(), importPackage: vi.fn(),
    prepare: vi.fn(), publishDraft: vi.fn(), review: vi.fn(),
  } satisfies MarketActions
  const props = { actions, reportOutcome: vi.fn(), t: (key: string) => key } as MarketSectionProps
  return { actions, props }
}

it('downloads without enabling and requires a separate enable action', async () => {
  const h = harness(); render(<MarketSection {...h.props} />)
  const download = await screen.findByRole('button', { name: 'download' })
  await waitFor(() => { expect(download.hasAttribute('disabled')).toBe(false) })
  fireEvent.click(download)
  const enable = await screen.findByRole('button', { name: 'enable' })
  expect(h.actions.install).toHaveBeenCalledWith(release.id)
  expect(h.actions.enable).not.toHaveBeenCalled()
  await waitFor(() => { expect(enable.hasAttribute('disabled')).toBe(false) }); fireEvent.click(enable)
  expect(await screen.findByText('enabled')).toBeDefined()
  expect(h.actions.enable).toHaveBeenCalledWith(release.id, true)
})

it('recognizes a ZIP import by digest and enables its local identity from the cloud catalog', async () => {
  const h = harness()
  const localId = release.sha256 as MarketRelease['id']
  const installation = { release: { ...release, id: localId }, enabled: false }
  h.actions.installed.mockResolvedValueOnce([installation])
  h.actions.enable.mockResolvedValueOnce({ ...installation, enabled: true })
  render(<MarketSection {...h.props} />)
  const enable = await screen.findByRole('button', { name: 'enable' })
  expect(h.actions.install).not.toHaveBeenCalled()
  await waitFor(() => { expect(enable.hasAttribute('disabled')).toBe(false) })
  fireEvent.click(enable)
  await screen.findByText('enabled')
  expect(h.actions.enable).toHaveBeenCalledWith(localId, true)
})

it('starts only an enabled Bot and passes the installed ID', async () => {
  const h = harness()
  const bot = marketFixture.find(row => row.manifest.kind === 'bot')!
  const localId = bot.sha256 as MarketRelease['id']
  const installation = { release: { ...bot, id: localId }, enabled: false }
  h.actions.catalog.mockResolvedValue([bot, release])
  h.actions.installed.mockResolvedValue([installation, { release, enabled: true }])
  h.actions.enable.mockResolvedValueOnce({ ...installation, enabled: true })
  const onRunBot = vi.fn(async () => {})
  render(<MarketSection {...h.props} onRunBot={onRunBot} />)
  const enable = await screen.findByRole('button', { name: 'enable' })
  expect(screen.queryByRole('button', { name: 'runBot' })).toBeNull()
  await waitFor(() => { expect(enable.hasAttribute('disabled')).toBe(false) })
  fireEvent.click(enable)
  const start = await screen.findByRole('button', { name: 'runBot' })
  await waitFor(() => { expect(start.hasAttribute('disabled')).toBe(false) })
  fireEvent.click(start)
  expect(onRunBot).toHaveBeenCalledExactlyOnceWith(localId)
})

it('does not upload when entering the creator form and renders bounded failures', async () => {
  const h = harness(); h.actions.identity.mockRejectedValue(Error('secret response with cookie'))
  render(<MarketSection {...h.props} />)
  await screen.findByText('Review scenes')
  const publish = screen.getByRole('button', { name: 'publish' })
  await waitFor(() => { expect(publish.hasAttribute('disabled')).toBe(false) }); fireEvent.click(publish)
  expect(await screen.findByText('readFailed')).toBeDefined()
  expect(h.actions.publishDraft).not.toHaveBeenCalled(); expect(h.actions.prepare).not.toHaveBeenCalled()
  expect(screen.queryByText('secret response with cookie')).toBeNull()
})

it('keeps Chinese and English market dictionaries aligned', () => { expect(Object.keys(marketEn).sort()).toEqual(Object.keys(marketZh).sort()) })

it('introduces the Bot by hover and touch without downloading or enabling it', async () => {
  const h = harness(); h.actions.catalog.mockResolvedValue(marketFixture)
  render(<MarketSection {...h.props} presentations={marketPresentations} />)
  const buttons = await screen.findAllByRole('button', { name: 'introduce' })
  fireEvent.pointerEnter(buttons[0]!.parentElement!)
  const introduction = marketPresentations['1'.repeat(32)]!.introduction
  expect(await screen.findByText(introduction)).toBeDefined()
  fireEvent.keyDown(window, { key: 'Escape' })
  await waitFor(() => { expect(screen.queryByText(introduction)).toBeNull() })
  fireEvent.click(buttons[1]!)
  expect(screen.getByText(introduction)).toBeDefined()
  fireEvent.keyDown(buttons[1]!, { key: 'Escape' })
  expect(screen.queryByText(introduction)).toBeNull()
  expect(h.actions.install).not.toHaveBeenCalled(); expect(h.actions.enable).not.toHaveBeenCalled()
})

it('keeps role edits and portrait selection local while previewing package metadata', async () => {
  const h = harness()
  h.actions.sources.mockResolvedValue({ website: 'https://muse.test/market',
    bots: [{ id: 'director', name: 'Director' }], skills: [] })
  render(<MarketSection {...h.props} />)
  await screen.findByText('Review scenes')
  const publish = screen.getByRole('button', { name: 'publish' })
  await waitFor(() => { expect(publish.hasAttribute('disabled')).toBe(false) }); fireEvent.click(publish)
  await waitFor(() => { expect(publish.hasAttribute('disabled')).toBe(false) })
  fireEvent.change(screen.getByRole('combobox', { name: 'sourceBot' }), { target: { value: 'director' } })
  fireEvent.change(screen.getByRole('textbox', { name: 'label' }), { target: { value: '我的导演' } })
  fireEvent.change(screen.getByRole('textbox', { name: 'role' }), { target: { value: '镜头规划师' } })
  fireEvent.change(screen.getByRole('textbox', { name: 'introduction' }), { target: { value: '我帮你安排镜头' } })
  expect(screen.getByRole('heading', { name: '我的导演' })).toBeDefined()
  expect(screen.getByText('镜头规划师')).toBeDefined()
  expect(screen.getByText('portraitLocalOnly')).toBeDefined()
  const portrait = screen.getByLabelText('portrait')
  fireEvent.change(portrait, { target: { files: [new File(['bad'], 'bad.svg', { type: 'image/svg+xml' })] } })
  expect(screen.getByRole('alert').textContent).toBe('portraitError')
  fireEvent.change(portrait, { target: { files: [new File(['preview'], 'portrait.png', { type: 'image/png' })] } })
  await waitFor(() => { expect(screen.queryByRole('alert')).toBeNull() })
  expect(screen.getByRole('img', { name: '镜头规划师' }).getAttribute('src')).toMatch(/^data:image\/png;base64,/)
  expect(h.actions.prepare).not.toHaveBeenCalled(); expect(h.actions.publishDraft).not.toHaveBeenCalled()
})

it('prepares the manually selected desktop Bot portrait without uploading', async () => {
  const h = harness()
  h.actions.sources.mockResolvedValue({ website: 'https://muse.test/market',
    bots: [{ id: 'director', name: 'Director' }], skills: [] })
  h.actions.prepare.mockResolvedValue({ release, enabled: false })
  render(<MarketSection {...h.props} initialView="publish" />)
  fireEvent.change(await screen.findByRole('combobox', { name: 'sourceBot' }), { target: { value: 'director' } })
  const title = screen.getByRole('textbox', { name: 'label' })
  fireEvent.change(title, { target: { value: '调色师' } })
  const portrait = screen.getByRole<HTMLSelectElement>('combobox', { name: 'releasePortrait' })
  expect(portrait.value).toBe('colorist')
  expect(screen.getByRole('img', { name: '调色师' }).getAttribute('src')).toContain('colorist')
  fireEvent.change(portrait, { target: { value: 'coding-assistant' } })
  fireEvent.change(title, { target: { value: '剧本编辑' } })
  expect(portrait.value).toBe('coding-assistant')
  expect(screen.getByRole('img', { name: '剧本编辑' }).getAttribute('src')).toContain('coding-assistant')
  fireEvent.submit(screen.getByRole('button', { name: 'prepare' }).closest('form')!)
  await waitFor(() => expect(h.actions.prepare).toHaveBeenCalledWith(
    expect.objectContaining({ kind: 'bot', presetPortrait: 'coding-assistant' }), [], 'director'))
  expect(h.actions.publishDraft).not.toHaveBeenCalled()
})

it('shows loading, then retryable read failure without an empty-market claim or success outcome', async () => {
  const h = harness(), catalog = Promise.withResolvers<MarketRelease[]>()
  h.actions.catalog.mockReturnValueOnce(catalog.promise)
  render(<MarketSection {...h.props} />)
  expect(screen.getByRole('status', { name: 'loading' })).toBeDefined()
  expect(screen.queryByText('emptyDiscovery')).toBeNull()
  await act(async () => { catalog.reject(Error('private upstream response')) })
  expect(screen.getByRole('alert').textContent).toBe('readFailed')
  expect(screen.queryByText('emptyDiscovery')).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'retry' }))
  expect(await screen.findByText('Review scenes')).toBeDefined()
  expect(screen.queryByRole('alert')).toBeNull()
  expect(h.props.reportOutcome).not.toHaveBeenCalled()
})

it('retains publications after a failed refresh and distinguishes a successful empty search', async () => {
  const h = harness(); render(<MarketSection {...h.props} />)
  await screen.findByText('Review scenes')
  h.actions.catalog.mockRejectedValueOnce(Error('generic'))
  fireEvent.click(screen.getByRole('button', { name: 'search' }))
  expect(await screen.findByText('readFailedRetained')).toBeDefined()
  expect(screen.getByText('Review scenes')).toBeDefined()
  expect(screen.queryByText('emptyDiscovery')).toBeNull()
  h.actions.catalog.mockResolvedValueOnce([])
  fireEvent.click(screen.getByRole('button', { name: 'retry' }))
  expect(await screen.findByText('emptyDiscovery')).toBeDefined()
  expect(screen.queryByText('Review scenes')).toBeNull()
})

it('keeps failed download and enable actions retryable without reporting success', async () => {
  const h = harness(); h.actions.install.mockRejectedValueOnce(Error('generic'))
  render(<MarketSection {...h.props} />)
  const download = await screen.findByRole('button', { name: 'download' })
  fireEvent.click(download)
  await waitFor(() => { expect(h.props.reportOutcome).toHaveBeenLastCalledWith('error.generic', true) })
  expect(screen.queryByRole('button', { name: 'enable' })).toBeNull()
  fireEvent.click(download)
  const enable = await screen.findByRole('button', { name: 'enable' })
  h.actions.enable.mockRejectedValueOnce(Error('release-in-use'))
  fireEvent.click(enable)
  await waitFor(() => { expect(h.props.reportOutcome).toHaveBeenLastCalledWith('error.release-in-use', true) })
  expect(screen.queryByText('enabled')).toBeNull()
  expect(screen.getByText('disabled')).toBeDefined()
  fireEvent.click(enable)
  expect(await screen.findByText('enabled')).toBeDefined()
  expect(h.props.reportOutcome).toHaveBeenLastCalledWith('done', false)
})

it('ignores a completed query from a replaced adapter', async () => {
  const first = harness(), second = harness(), oldCatalog = Promise.withResolvers<MarketRelease[]>()
  first.actions.catalog.mockReturnValueOnce(oldCatalog.promise)
  second.actions.catalog.mockResolvedValue(marketFixture)
  const view = render(<MarketSection {...first.props} />)
  view.rerender(<MarketSection {...second.props} />)
  await screen.findByText('分镜入门工作法')
  await act(async () => { oldCatalog.resolve([release]) })
  expect(screen.queryByText('Review scenes')).toBeNull()
  expect(screen.getByText('分镜入门工作法')).toBeDefined()
})

it('reports confirmed operations to the shell after the page unmounts', async () => {
  const h = harness(), installing = Promise.withResolvers<MarketInstallation>()
  h.actions.install.mockReturnValueOnce(installing.promise)
  const view = render(<MarketSection {...h.props} />)
  fireEvent.click(await screen.findByRole('button', { name: 'download' }))
  view.unmount()
  await act(async () => { installing.resolve({ release, enabled: false }) })
  expect(h.props.reportOutcome).toHaveBeenCalledWith('done', false)
})

it('opens publication details without downloading and returns to the selected card', async () => {
  const h = harness(); render(<MarketSection {...h.props} />)
  const details = await screen.findByRole('button', { name: 'details' })
  fireEvent.click(details)
  const dialog = screen.getByRole('dialog', { name: 'Review scenes' })
  expect(within(dialog).getByText('MIT')).toBeDefined()
  expect(within(dialog).getByText('review')).toBeDefined()
  expect(h.actions.install).not.toHaveBeenCalled()
  fireEvent.click(within(dialog).getByRole('button', { name: 'close' }))
  await waitFor(() => { expect(screen.queryByRole('dialog')).toBeNull() })
})

it('sends the selected type immediately and filters categories without another Host query', async () => {
  const h = harness()
  h.actions.catalog.mockImplementation(async (_query, kind) => marketFixture.filter(row => !kind || row.manifest.kind === kind))
  render(<MarketSection {...h.props} />)
  await screen.findByRole('heading', { name: '分镜入门工作法' })
  const calls = h.actions.catalog.mock.calls.length
  fireEvent.click(screen.getByRole('button', { name: '分镜创作' }))
  expect(screen.queryByRole('heading', { name: '分镜入门工作法' })).toBeNull()
  expect(h.actions.catalog).toHaveBeenCalledTimes(calls)
  fireEvent.click(screen.getByRole('button', { name: 'skill' }))
  expect(await screen.findByRole('heading', { name: '分镜入门工作法' })).toBeDefined()
  expect(h.actions.catalog).toHaveBeenLastCalledWith('', 'skill', false)
  expect(screen.queryByRole('heading', { name: '分镜导演' })).toBeNull()
})

it('opens the creator form from the upload entry without preparing or uploading a package', async () => {
  const h = harness()
  h.actions.sources.mockResolvedValue({ website: 'https://muse.test/market',
    bots: [{ id: 'director', name: 'Director' }], skills: [] })
  render(<MarketSection {...h.props} />)
  await screen.findByText('Review scenes')
  fireEvent.click(screen.getAllByRole('button', { name: 'uploadEntry' })[0]!)
  const source = await screen.findByRole('combobox', { name: 'sourceBot' })
  expect(source.getAttribute('value') ?? (source as HTMLSelectElement).value).toBe('director')
  expect(h.actions.prepare).not.toHaveBeenCalled(); expect(h.actions.publishDraft).not.toHaveBeenCalled()
})

it('renders the backend handoff installation records and enables their exact local digest identities', async () => {
  const h = harness()
  const fixture = JSON.parse(readFileSync(resolve('packages/host/muse-market/tests/fixtures/handoff/local-installations.json'), 'utf8')) as {
    installations: MarketInstallation[]
  }
  h.actions.installed.mockResolvedValue(fixture.installations)
  h.actions.enable.mockResolvedValue({ release: fixture.installations[0]!.release, enabled: true })
  render(<MarketSection {...h.props} />)
  await screen.findByText('Review scenes')
  fireEvent.click(screen.getByRole('button', { name: 'installed' }))
  await screen.findByRole('heading', { name: fixture.installations[0]!.release.manifest.title })
  expect(screen.getByRole('heading', { name: fixture.installations[1]!.release.manifest.title })).toBeDefined()
  expect(h.actions.install).not.toHaveBeenCalled()
  const enable = screen.getAllByRole('button', { name: 'enable' })[0]!
  await waitFor(() => { expect(enable.hasAttribute('disabled')).toBe(false) })
  fireEvent.click(enable)
  expect(h.actions.enable).toHaveBeenCalledWith(fixture.installations[0]!.release.id, true)
  expect(fixture.installations[0]!.release.id).toHaveLength(64)
})
