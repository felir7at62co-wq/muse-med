// @vitest-environment jsdom
import { act, cleanup, render, screen, fireEvent, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { MarketSection, type MarketSectionProps } from '../src/client/MarketSection.tsx'
import { MarketCreatorPage } from '../src/client/MarketCreatorPage.tsx'
import { rememberMarketGuide } from '../src/client/MarketGuide.tsx'
import type { MarketActions } from '../src/client/market-mount.ts'
import type { MarketInstallation, MarketLegacyResource, MarketRelease } from '@deepseek-ai/dsh-muse-market/types'
import { marketZh, marketEn } from '../src/client/market-locales.ts'
import { marketFixture, marketPresentations } from './market-fixture.client.ts'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

beforeEach(rememberMarketGuide)
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers() })
const release: MarketRelease = { id: 'a'.repeat(32) as MarketRelease['id'], publisherId: 'b'.repeat(32) as MarketRelease['publisherId'],
  publisher: 'Team', sha256: 'c'.repeat(64), bytes: 1024, revision: 1, reviewNote: '', status: 'published', createdAt: '2026-11-02T00:00:00Z',
  manifest: { formatVersion: 1, kind: 'skill', name: 'review', title: 'Review scenes', description: 'Review every scene', version: '1.0.0',
    license: 'MIT', category: 'script', examples: [], requirements: [], skills: [{ name: 'review', path: 'skills/review/SKILL.md' }] } }
function harness() {
  let local: MarketInstallation[] = []
  const actions = {
    catalog: vi.fn<MarketActions['catalog']>(async () => [release]), installed: vi.fn(async () => local),
    legacyCatalog: vi.fn<MarketActions['legacyCatalog']>(async () => []),
    sources: vi.fn<MarketActions['sources']>(async () => ({ website: 'https://muse.test/market', skills: [], bots: [] })),
    identity: vi.fn<MarketActions['identity']>(async () => ({ publishers: [], admin: false })),
    install: vi.fn<MarketActions['install']>(async () => { const item = { release, enabled: false }; local = [item]; return item }),
    installLegacy: vi.fn<MarketActions['installLegacy']>(),
    enable: vi.fn<MarketActions['enable']>(async (_id, enabled) => { const item = { release, enabled }; local = [item]; return item }),
    remove: vi.fn(async () => { local = [] }), exportPackage: vi.fn(), importPackage: vi.fn(),
    prepare: vi.fn(), publishDraft: vi.fn(), review: vi.fn(),
  } satisfies MarketActions
  const props = { actions, reportOutcome: vi.fn(), onOpenCreator: vi.fn(), t: (key: string) => key } as MarketSectionProps
  return { actions, props }
}

it('shows the original desktop catalog alongside releases and keeps original downloads separate', async () => {
  const h = harness()
  const original = { id: 'muse/bots/storyboard-director-16-9', kind: 'bot' as const, title: 'Original storyboard director',
    description: 'Plan widescreen shots', category: 'script', version: '0.1.0', requirements: [], requiredSkills: [],
    validation: 'Manual installation', sha256: 'd'.repeat(64), href: 'https://muse.test/market/downloads/director.tgz' }
  h.actions.legacyCatalog.mockResolvedValue([original, { ...original, id: 'muse/skills/review', kind: 'skill',
    title: 'Duplicate original', sha256: release.sha256 }])
  render(<MarketSection {...h.props} />)
  expect(await screen.findByRole('heading', { name: original.title })).toBeDefined()
  expect(screen.getByRole('heading', { name: release.manifest.title })).toBeDefined()
  expect(screen.queryByRole('heading', { name: 'Duplicate original' })).toBeNull()
  const link = screen.getByRole('link', { name: 'legacyDownload' })
  expect(link.getAttribute('href')).toBe(original.href)
  expect(link.getAttribute('target')).toBe('_blank')
  expect(h.actions.install).not.toHaveBeenCalled()
  expect(h.actions.installLegacy).not.toHaveBeenCalled()
  expect(h.actions.legacyCatalog).toHaveBeenCalledExactlyOnceWith('', '')
  h.actions.installLegacy.mockRejectedValueOnce(new Error('legacy-catalog-changed'))
  fireEvent.click(screen.getByRole('button', { name: 'legacyImport' }))
  await waitFor(() => { expect(h.props.reportOutcome).toHaveBeenCalledWith('error.legacy-catalog-changed', true) })
  expect(screen.getByRole('link', { name: 'legacyDownload' })).toBe(link)
  expect(screen.queryByRole('button', { name: 'enable' })).toBeNull()
})

it('imports the selected original Bot digest, then enables and starts its local version', async () => {
  const h = harness()
  const bot = marketFixture.find(row => row.manifest.kind === 'bot')!
  const source = { id: 'muse/bots/storyboard-director-16-9', kind: 'bot' as const, title: bot.manifest.title,
    description: bot.manifest.description, category: bot.manifest.category, version: bot.manifest.version,
    requirements: [], requiredSkills: [], validation: '', sha256: 'd'.repeat(64), href: 'https://muse.test/market/downloads/director.tgz' }
  const local = { release: bot, enabled: false, legacySource: { id: source.id, sha256: source.sha256 } }
  h.actions.legacyCatalog.mockResolvedValue([source])
  h.actions.installLegacy.mockResolvedValue(local)
  h.actions.enable.mockResolvedValueOnce({ ...local, enabled: true })
  const onRunBot = vi.fn(async () => {})
  render(<MarketSection {...h.props} onRunBot={onRunBot} />)

  fireEvent.click(await screen.findByRole('button', { name: 'legacyImport' }))
  expect(h.actions.installLegacy).toHaveBeenCalledExactlyOnceWith(source.id, source.sha256)
  const enable = await screen.findByRole('button', { name: 'enable' })
  expect(h.actions.enable).not.toHaveBeenCalled()
  expect(screen.queryByRole('button', { name: 'runBot' })).toBeNull()
  expect(screen.getByRole('link', { name: 'legacyDownload' }).getAttribute('href')).toBe(source.href)

  fireEvent.click(enable)
  fireEvent.click(await screen.findByRole('button', { name: 'runBot' }))
  expect(h.actions.enable).toHaveBeenCalledExactlyOnceWith(local.release.id, true)
  expect(onRunBot).toHaveBeenCalledExactlyOnceWith(local.release.id, local.release.manifest.title)
})

it('shows usage for an enabled original Skill after reloading and excludes it from local publications', async () => {
  const h = harness()
  const source = { id: 'muse/skills/review', sha256: 'd'.repeat(64) }
  h.actions.catalog.mockResolvedValue([])
  h.actions.installed.mockResolvedValue([{ release, enabled: true, legacySource: source }])
  h.actions.legacyCatalog.mockResolvedValue([{ ...source, kind: 'skill', title: release.manifest.title,
    description: release.manifest.description, category: release.manifest.category, version: release.manifest.version,
    requirements: [], requiredSkills: [], validation: '', href: 'https://muse.test/market/downloads/review.zip' }])
  render(<MarketSection {...h.props} />)
  expect(await screen.findByText('enabled')).toBeDefined()
  expect(screen.queryByRole('button', { name: 'legacyImport' })).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'details' }))
  expect(await screen.findByText('legacySkillUsage')).toBeDefined()
  fireEvent.click(screen.getByRole('button', { name: 'close' }))
  fireEvent.click(screen.getByRole('button', { name: 'installed' }))
  expect(await screen.findByRole('button', { name: 'details' })).toBeDefined()
  expect(screen.queryByRole('button', { name: 'export' })).toBeNull()
  await waitFor(() => { expect(screen.getByRole('button', { name: 'publish' }).hasAttribute('disabled')).toBe(false) })
  fireEvent.click(screen.getByRole('button', { name: 'publish' }))
  expect(await screen.findByRole('region', { name: 'cloudPublications' })).toBeDefined()
  expect(screen.queryByText('localPackages')).toBeNull()
  expect(screen.queryByRole('heading', { name: release.manifest.title })).toBeNull()
})

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

it('keeps the activation and actions of byte-identical Bot installations separate', async () => {
  const h = harness()
  const bot = marketFixture.find(row => row.manifest.kind === 'bot')!
  const cloud = { release: bot, enabled: true }
  const local = { release: { ...bot, id: bot.sha256 as MarketRelease['id'], publisher: 'Local import' }, enabled: false }
  h.actions.catalog.mockResolvedValue([bot])
  h.actions.installed.mockResolvedValueOnce([local, cloud]).mockResolvedValue([cloud, local])
  h.actions.enable.mockResolvedValueOnce({ ...local, enabled: true })
  const onRunBot = vi.fn(async () => {})
  render(<MarketSection {...h.props} onRunBot={onRunBot} t={(key, args) => key === 'creator' ? String(args?.publisher) : key} />)

  expect(await screen.findByRole('button', { name: 'runBot' })).toBeDefined()
  fireEvent.click(screen.getByRole('button', { name: 'installed' }))
  const localCard = within((await screen.findByText(local.release.publisher)).closest('article')!)
  const cloudCard = within(screen.getByText(cloud.release.publisher).closest('article')!)
  expect(localCard.getByText('disabled')).toBeDefined()
  expect(localCard.queryByRole('button', { name: 'runBot' })).toBeNull()
  expect(cloudCard.getByText('enabled')).toBeDefined()

  const runCloud = cloudCard.getByRole('button', { name: 'runBot' })
  await waitFor(() => { expect(runCloud.hasAttribute('disabled')).toBe(false) })
  fireEvent.click(runCloud)
  expect(onRunBot).toHaveBeenNthCalledWith(1, cloud.release.id, bot.manifest.title)
  const enable = localCard.getByRole('button', { name: 'enable' })
  await waitFor(() => { expect(enable.hasAttribute('disabled')).toBe(false) })
  fireEvent.click(enable)
  expect(h.actions.enable).toHaveBeenCalledExactlyOnceWith(local.release.id, true)
  const runLocal = await localCard.findByRole('button', { name: 'runBot' })
  await waitFor(() => { expect(runLocal.hasAttribute('disabled')).toBe(false) })
  fireEvent.click(runLocal)
  expect(onRunBot).toHaveBeenNthCalledWith(2, local.release.id, bot.manifest.title)
})

it('starts only an enabled Bot and passes its installed ID and title', async () => {
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
  expect(onRunBot).toHaveBeenCalledExactlyOnceWith(localId, bot.manifest.title)
})

it('renders bounded failures when opening creator records', async () => {
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

it('matches the desktop Bot portrait as the metadata changes and prepares that exact preset', async () => {
  const h = harness()
  h.actions.sources.mockResolvedValue({ website: 'https://muse.test/market',
    bots: [{ id: 'director', name: 'Director' }], skills: [] })
  const bot = marketFixture[0]!
  const prepared = { ...bot, status: 'draft' as const,
    manifest: { ...bot.manifest, title: '编程助手', presetPortrait: 'coding-assistant' as const } }
  h.actions.identity.mockResolvedValue({ publishers: [{ id: bot.publisherId, title: bot.publisher }], admin: false })
  h.actions.prepare.mockResolvedValue({ release: prepared, enabled: false })
  render(<MarketCreatorPage actions={h.actions} t={h.props.t} reportOutcome={h.props.reportOutcome} onBack={vi.fn()} initialKind="bot" />)
  await screen.findByRole('combobox', { name: 'sourceBot' })
  const title = screen.getByRole('textbox', { name: 'label' })
  fireEvent.change(title, { target: { value: '调色师' } })
  expect(screen.getByRole('img', { name: '调色师' }).getAttribute('src')).toContain('colorist')
  expect(screen.queryByRole('combobox', { name: 'releasePortrait' })).toBeNull()
  expect(screen.queryByLabelText('portrait')).toBeNull()
  expect(screen.queryByRole('button', { name: 'characterGenerate' })).toBeNull()
  fireEvent.change(title, { target: { value: '编程助手' } })
  expect(screen.getByRole('img', { name: '编程助手' }).getAttribute('src')).toContain('coding-assistant')
  expect(h.actions.prepare).not.toHaveBeenCalled()
  fireEvent.submit(screen.getByRole('button', { name: 'prepare' }).closest('form')!)
  await waitFor(() => {
    expect(h.actions.prepare).toHaveBeenCalledWith(expect.objectContaining({ kind: 'bot', presetPortrait: 'coding-assistant' }), [], 'director')
  })
  const upload = await screen.findByRole<HTMLButtonElement>('button', { name: 'upload' })
  expect(upload.disabled).toBe(false)
  fireEvent.change(title, { target: { value: '调色师' } })
  expect(screen.getByRole('img', { name: '调色师' }).getAttribute('src')).toContain('colorist')
  expect(screen.queryByRole('button', { name: 'upload' })).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'creatorUploadZip' }))
  expect(screen.getByRole('combobox', { name: 'localPackages' })).toHaveProperty('value', prepared.id)
  expect(screen.getByRole('img', { name: prepared.manifest.title }).getAttribute('src')).toContain('coding-assistant')
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

it('opens the dedicated Skill and upload pages directly from the market', async () => {
  const h = harness()
  h.actions.sources.mockResolvedValue({ website: 'https://muse.test/market',
    bots: [{ id: 'director', name: 'Director' }], skills: [] })
  render(<MarketSection {...h.props} />)
  await screen.findByText('Review scenes')
  fireEvent.click(screen.getByRole('button', { name: 'creatorNewSkill' }))
  expect(h.props.onOpenCreator).toHaveBeenLastCalledWith('skill')
  fireEvent.click(screen.getAllByRole('button', { name: 'uploadEntry' })[0]!)
  expect(h.props.onOpenCreator).toHaveBeenLastCalledWith('upload')
  expect(screen.queryByRole('combobox', { name: 'sourceBot' })).toBeNull()
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
function originalCatalog(count: number): MarketLegacyResource[] {
  return Array.from({ length: count }, (_, index) => ({
    id: index === 0 ? 'muse/bots/storyboard-director-16-9' : 'muse/skills/original-' + index,
    kind: index === 0 ? 'bot' : 'skill', title: 'Original resource ' + index,
    description: 'Original creative workflow', category: index === 0 ? 'Camera' : 'Resources', version: '0.1.0',
    requirements: ['Available local model'], requiredSkills: index === 0 ? ['script'] : [],
    validation: '', sha256: index.toString(16).padStart(64, '0'), href: 'https://muse.test/market/downloads/original-' + index + '.zip',
  }))
}

it('loads original catalog pages on intersection and ignores a retired observer', async () => {
  const h = harness()
  h.actions.legacyCatalog.mockResolvedValue(originalCatalog(26))
  const observers: IntersectionProbe[] = []
  class IntersectionProbe {
    readonly observe = vi.fn()
    readonly disconnect = vi.fn()
    constructor(readonly report: (entries: { isIntersecting: boolean }[]) => void) { observers.push(this) }
  }
  vi.stubGlobal('IntersectionObserver', IntersectionProbe)
  const view = render(<MarketSection {...h.props} />)
  await screen.findByRole('heading', { name: 'Original resource 0' })
  expect(observers).toHaveLength(1)
  expect(observers[0]!.observe).toHaveBeenCalledOnce()
  expect(screen.queryByRole('heading', { name: 'Original resource 12' })).toBeNull()
  expect(screen.getAllByText('Available local model')).toHaveLength(12)
  expect(screen.getByText('sourceSkillsShort: script')).toBeDefined()
  expect(screen.getAllByRole('button', { name: 'uploadEntry' })).toHaveLength(2)
  act(() => { observers[0]!.report([{ isIntersecting: false }]) })
  expect(screen.queryByRole('heading', { name: 'Original resource 12' })).toBeNull()

  act(() => { observers[0]!.report([{ isIntersecting: true }]) })
  expect(screen.getByRole('heading', { name: 'Original resource 12' })).toBeDefined()
  expect(screen.queryByRole('heading', { name: 'Original resource 25' })).toBeNull()
  expect(observers[0]!.disconnect).toHaveBeenCalled()
  act(() => { observers[0]!.report([{ isIntersecting: true }]) })
  expect(screen.queryByRole('heading', { name: 'Original resource 25' })).toBeNull()
  act(() => { observers[1]!.report([{ isIntersecting: true }]) })
  expect(screen.getByRole('heading', { name: 'Original resource 25' })).toBeDefined()
  view.unmount()
  expect(observers[1]!.disconnect).toHaveBeenCalled()
})

it('keeps every legacy item usable when the browser has no intersection observer', async () => {
  const h = harness()
  h.actions.legacyCatalog.mockResolvedValue(originalCatalog(15))
  vi.stubGlobal('IntersectionObserver', undefined)
  render(<MarketSection {...h.props} />)
  expect(await screen.findByRole('heading', { name: 'Original resource 14' })).toBeDefined()
  fireEvent.click(screen.getByRole('button', { name: 'Camera' }))
  expect(screen.getByRole('heading', { name: 'Original resource 0' })).toBeDefined()
  expect(screen.queryByRole('heading', { name: 'Original resource 14' })).toBeNull()
})

it('keeps the modern catalog usable during a legacy outage and retries the failed source', async () => {
  const h = harness()
  h.actions.legacyCatalog.mockRejectedValueOnce(Error('legacy network unavailable')).mockResolvedValueOnce(originalCatalog(1))
  render(<MarketSection {...h.props} />)
  expect(await screen.findByRole('alert')).toHaveProperty('textContent', 'legacyUnavailable')
  expect(screen.getByRole('heading', { name: release.manifest.title })).toBeDefined()
  fireEvent.click(screen.getByRole('button', { name: 'retry' }))
  expect(await screen.findByRole('heading', { name: 'Original resource 0' })).toBeDefined()
  expect(screen.queryByRole('alert')).toBeNull()
})

it('opens the guide on demand, remembers dismissal, and searches the entered name', async () => {
  const h = harness()
  render(<MarketSection {...h.props} />)
  await screen.findByRole('heading', { name: release.manifest.title })
  fireEvent.click(screen.getByRole('button', { name: 'guideEntry' }))
  const guide = screen.getByRole('dialog', { name: 'guideTitle' })
  fireEvent.click(within(guide).getByRole('button', { name: 'guideSkip' }))
  expect(screen.queryByRole('dialog')).toBeNull()
  const query = screen.getByRole('textbox', { name: 'query' })
  fireEvent.change(query, { target: { value: 'wide shots' } })
  const pending = Promise.withResolvers<MarketRelease[]>()
  h.actions.catalog.mockReturnValueOnce(pending.promise)
  const searchForm = query.closest('form')!
  fireEvent.submit(searchForm)
  fireEvent.submit(searchForm)
  expect(h.actions.catalog.mock.calls).toEqual([['', '', false], ['wide shots', '', false]])
  await act(async () => { pending.resolve([release]) })
})

it('commits the first navigation when two market tabs receive clicks before rendering', async () => {
  const h = harness()
  render(<MarketSection {...h.props} />)
  await screen.findByRole('heading', { name: release.manifest.title })
  const creator = screen.getByRole('button', { name: 'publish' })
  const installed = screen.getByRole('button', { name: 'installed' })
  act(() => {
    creator.click()
    installed.click()
  })
  await screen.findByRole('region', { name: 'cloudPublications' })
  expect(creator.getAttribute('aria-pressed')).toBe('true')
  expect(installed.getAttribute('aria-pressed')).toBe('false')
  expect(h.actions.installed).toHaveBeenCalledTimes(2)
})

it('uses bounded read errors and ignores a rejection from a retired market adapter', async () => {
  const old = harness(), replacement = harness(), first = Promise.withResolvers<MarketRelease[]>()
  old.actions.catalog.mockReturnValueOnce(first.promise)
  replacement.actions.catalog.mockRejectedValueOnce(Error('login-required'))
  const view = render(<MarketSection {...old.props} />)
  view.rerender(<MarketSection {...replacement.props} />)
  expect(await screen.findByRole('alert')).toHaveProperty('textContent', 'error.login-required')
  await act(async () => { first.reject(Error('retired adapter')) })
  expect(screen.getByRole('alert')).toHaveProperty('textContent', 'error.login-required')
})

it('checks ZIP size and uses the returned local installation for refresh, export, and removal', async () => {
  const h = harness()
  const local = { release, enabled: false }
  const imported = Promise.withResolvers<MarketInstallation>()
  const file = new File(['ZIP'], 'review.zip', { type: 'application/zip' })
  const oversized = new File([], 'oversized.zip')
  const readOversized = vi.fn()
  Object.defineProperty(file, 'arrayBuffer', { value: async () => new TextEncoder().encode('ZIP').buffer })
  Object.defineProperties(oversized, { size: { value: 64 * 1024 * 1024 + 1 }, arrayBuffer: { value: readOversized } })
  h.actions.importPackage.mockReturnValueOnce(imported.promise)
  h.actions.exportPackage.mockResolvedValue({ name: file.name, base64: 'WklQ' })
  const create = vi.fn(() => 'blob:review'), revoke = vi.fn()
  class DownloadURL extends URL {
    static override createObjectURL = create
    static override revokeObjectURL = revoke
  }
  vi.stubGlobal('URL', DownloadURL)
  const download = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
  render(<MarketSection {...h.props} />)
  await screen.findByRole('heading', { name: release.manifest.title })
  fireEvent.click(screen.getByRole('button', { name: 'installed' }))
  await screen.findByText('emptyInstalledHint')
  const picker = screen.getByLabelText('import')
  fireEvent.change(picker, { target: { files: [] } })
  fireEvent.change(picker, { target: { files: [oversized] } })
  await waitFor(() => { expect(h.props.reportOutcome).toHaveBeenCalledWith('error.expanded-limit', true) })
  expect(readOversized).not.toHaveBeenCalled()
  expect(h.actions.importPackage).not.toHaveBeenCalled()

  fireEvent.change(picker, { target: { files: [file] } })
  fireEvent.change(picker, { target: { files: [file] } })
  await waitFor(() => { expect(h.actions.importPackage).toHaveBeenCalledExactlyOnceWith('WklQ') })
  await act(async () => { imported.resolve(local) })
  expect(screen.getByText('disabled')).toBeDefined()
  vi.useFakeTimers({ toFake: ['setTimeout'] })
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'export' })) })
  expect(h.actions.exportPackage).toHaveBeenCalledExactlyOnceWith(release.id)
  expect(download).toHaveBeenCalledOnce()
  await act(async () => { await vi.runAllTimersAsync() })
  expect(revoke).toHaveBeenCalledWith('blob:review')
  vi.useRealTimers()

  h.actions.installed.mockResolvedValueOnce([local])
  fireEvent.click(screen.getByRole('button', { name: 'refresh' }))
  await waitFor(() => { expect(screen.getByRole<HTMLButtonElement>('button', { name: 'remove' }).disabled).toBe(false) })
  fireEvent.click(screen.getByRole('button', { name: 'remove' }))
  expect(await screen.findByText('emptyInstalledHint')).toBeDefined()
  expect(h.actions.remove).toHaveBeenCalledExactlyOnceWith(release.id)
  const empty = screen.getByText('emptyInstalledHint').parentElement!
  fireEvent.click(within(empty).getByRole('button', { name: 'discover' }))
  expect(await screen.findByRole('heading', { name: release.manifest.title })).toBeDefined()
})

it.each(['enable', 'installLegacy', 'importPackage', 'remove', 'cloudDownload'] as const)(
  'reports the confirmed %s result without mutating a replaced market panel', async (operation) => {
    const old = harness(), replacement = harness()
    const local = { release, enabled: false }
    const pending = Promise.withResolvers<MarketInstallation>(), remove = Promise.withResolvers<undefined>()
    let start = () => {}
    let expected = 'done'
    if (operation === 'enable' || operation === 'remove') {
      old.actions.installed.mockResolvedValue([local])
      old.actions.enable.mockReturnValueOnce(pending.promise)
      old.actions.remove.mockReturnValueOnce(remove.promise)
      start = () => { fireEvent.click(screen.getByRole('button', { name: operation })) }
    } else if (operation === 'installLegacy') {
      old.actions.legacyCatalog.mockResolvedValue(originalCatalog(1))
      old.actions.installLegacy.mockReturnValueOnce(pending.promise)
      expected = 'legacyImported'
      start = () => { fireEvent.click(screen.getByRole('button', { name: 'legacyImport' })) }
    } else if (operation === 'importPackage') {
      old.actions.importPackage.mockReturnValueOnce(pending.promise)
      start = () => {
        const file = new File(['ZIP'], 'review.zip')
        Object.defineProperty(file, 'arrayBuffer', { value: async () => new TextEncoder().encode('ZIP').buffer })
        fireEvent.change(screen.getByLabelText('import'), { target: { files: [file] } })
      }
    } else {
      old.actions.install.mockReturnValueOnce(pending.promise)
      start = () => { fireEvent.click(screen.getByRole('button', { name: 'download' })) }
    }
    const view = render(<MarketSection {...old.props} {...operation === 'cloudDownload' ? { initialView: 'publish' } : {}} />)
    await screen.findByRole('heading', { name: release.manifest.title })
    if (operation === 'importPackage') {
      fireEvent.click(screen.getByRole('button', { name: 'installed' }))
      await screen.findByText('emptyInstalledHint')
    }
    start()
    if (operation === 'importPackage') await waitFor(() => { expect(old.actions.importPackage).toHaveBeenCalledOnce() })
    if (operation === 'cloudDownload') expect(old.actions.install).toHaveBeenCalledExactlyOnceWith(release.id)
    view.rerender(<MarketSection {...replacement.props} />)
    await act(async () => {
      pending.resolve({ ...local, enabled: true })
      remove.resolve(undefined)
    })
    expect(old.props.reportOutcome).toHaveBeenCalledExactlyOnceWith(expected, false)
    expect(screen.queryByText('enabled')).toBeNull()
  },
)

it('installs an explicitly downloaded publication from the creator center without enabling it', async () => {
  const h = harness()
  render(<MarketSection {...h.props} initialView="publish" />)
  fireEvent.click(await screen.findByRole('button', { name: 'download' }))
  await waitFor(() => { expect(h.props.reportOutcome).toHaveBeenCalledWith('done', false) })
  expect(h.actions.install).toHaveBeenCalledExactlyOnceWith(release.id)
  expect(h.actions.enable).not.toHaveBeenCalled()
})
