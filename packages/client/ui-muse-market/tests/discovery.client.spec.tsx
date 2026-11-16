// @vitest-environment jsdom
/** Independent catalog failures, exact installation identities and automatic progressive rendering. */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { bindSnapshotSelector } from '@deepseek-ai/dsh-client-test-runtime'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { MarketPage, type MarketPageProps } from '../src/client/MarketSection.tsx'
import type { MarketAccess } from '../src/client/market-controller.ts'
import { createMarketViewStore } from '../src/client/market-view-store.ts'
import { marketEn } from '../src/client/market-locales.ts'
import { installMarketListing, listingInstallation, marketListings, nextMarketListingCount } from '../src/client/market-listing.ts'
import { installation, operations, original, publication } from './discovery-fixtures.client.ts'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { MarketActions, MarketIdentity, MarketPublication } from '../src/client/market-actions.ts'

afterEach(cleanup)

function mount(actions: MarketActions, initial: Partial<MarketAccess> = {}) {
  const store = createMarketViewStore().create()
  const access = createSnapshotStore<MarketAccess>({ revision: 0, ...initial })
  const props = { operations: actions, reportOutcome: vi.fn(), isCurrentAccess: () => true,
    useAccess: bindSnapshotSelector(access), useStore: bindSnapshotSelector(store), actions: store.actions,
    onOpenCreator: vi.fn(), onBackMarket: vi.fn(), onOpenPublications: vi.fn(),
    t: (key: keyof typeof marketEn) => marketEn[key] } as MarketPageProps
  return render(<MarketPage {...props} />)
}

describe('combined Skill discovery', () => {
  it.each(['publication', 'legacy'] as const)('retains the other in-flight catalog while retrying %s', async (source) => {
    const publications = Promise.withResolvers<MarketPublication[]>()
    const originals = Promise.withResolvers<Awaited<ReturnType<MarketActions['legacyCatalog']>>>()
    const catalog = vi.fn<MarketActions['catalog']>(), legacyCatalog = vi.fn<MarketActions['legacyCatalog']>()
    if (source === 'publication') {
      catalog.mockRejectedValueOnce(new Error('Offline')).mockResolvedValue([publication()])
      legacyCatalog.mockImplementation(() => originals.promise)
    } else {
      catalog.mockImplementation(() => publications.promise)
      legacyCatalog.mockRejectedValueOnce(new Error('Offline')).mockResolvedValue([original()])
    }
    mount(operations({ catalog, legacyCatalog }))
    await screen.findByText(marketEn[source === 'publication' ? 'publishedReadFailed' : 'originalReadFailed'])
    fireEvent.click(screen.getByRole('button', { name: marketEn[source === 'publication' ? 'retryPublished' : 'retryOriginal'] }))
    await act(async () => {
      publications.resolve([publication()]); originals.resolve([original()])
      await Promise.all([publications.promise, originals.promise])
    })
    await screen.findByRole('heading', { name: publication().manifest.title })
    await screen.findByRole('heading', { name: original().title })
    expect(screen.queryByRole('status', { name: marketEn.loading })).toBeNull()
    expect(catalog).toHaveBeenCalledTimes(source === 'publication' ? 2 : 1)
    expect(legacyCatalog).toHaveBeenCalledTimes(source === 'legacy' ? 2 : 1)
  })
  it.each(['installed', 'defaults'] as const)('keeps public discovery usable when the initial %s read fails', async (source) => {
    const value = operations({ catalog: async () => [publication()], legacyCatalog: async () => [original()],
      [source]: async () => { throw new Error('Local storage is unavailable') } })
    mount(value)
    await screen.findByRole('heading', { name: 'storyboard-review' })
    await screen.findByRole('heading', { name: 'anime-3d-assets' })
    expect(screen.getByRole('alert').textContent).toBe(marketEn.readFailedRetained)
    expect(screen.getByRole('searchbox').hasAttribute('disabled')).toBe(false)
    expect(screen.queryByRole('status', { name: marketEn.loading })).toBeNull()
  })

  it('does not make public search wait for a pending local inventory read', async () => {
    const pending = Promise.withResolvers<Awaited<ReturnType<MarketActions['installed']>>>()
    mount(operations({ installed: () => pending.promise, catalog: async () => [publication()], legacyCatalog: async () => [original()] }))
    await screen.findByRole('heading', { name: 'storyboard-review' })
    expect(screen.getByRole('searchbox').hasAttribute('disabled')).toBe(false)
    expect(screen.queryByRole('status', { name: marketEn.loading })).toBeNull()
    await act(async () => { pending.resolve([]); await pending.promise })
  })

  it('retains local cards when a later local refresh fails', async () => {
    const canonical = installation(), installed = vi.fn<MarketActions['installed']>()
      .mockResolvedValueOnce([canonical]).mockRejectedValue(new Error('Local storage is unavailable'))
    mount(operations({ installed }))
    await waitFor(() => { expect(screen.queryByRole('status', { name: marketEn.loading })).toBeNull() })
    fireEvent.click(screen.getByRole('tab', { name: marketEn.installed }))
    await screen.findByRole('alert')
    expect(screen.getByRole('heading', { name: canonical.release.manifest.title })).toBeTruthy()
  })

  it('retains distinct source identities even when their names and versions match', () => {
    const item = publication('anime-3d-assets', '0.1.1')
    const found = marketListings([item, item], [original('anime-3d-assets', '0.1.1')])
    expect(found.map(row => [row.source, row.version])).toEqual([['publication', '0.1.1'], ['legacy', '0.1.1']])
    expect(marketListings([item], [original()], 'studio')).toHaveLength(1)
    expect(marketListings([item], [original()], '', 'Visual')[0]?.source).toBe('legacy')
  })

  it('uses the selected source id and digest and retains the canonical local identity returned by conversion', async () => {
    const resource = original(), canonical = installation()
    const installLegacy = vi.fn(async () => ({ resource, installation: canonical }))
    const item = marketListings([], [resource])[0]!
    expect(await installMarketListing(operations({ installLegacy }), item)).toBe(canonical)
    expect(installLegacy).toHaveBeenCalledWith(resource.id, resource.sha256)
    expect(listingInstallation(item, [canonical], {})).toBeUndefined()
    expect(listingInstallation(item, [canonical], { [item.key]: canonical.release.id })).toBe(canonical)
    expect(listingInstallation({ ...item, key: item.key + '-changed' }, [canonical], { [item.key]: canonical.release.id })).toBeUndefined()
  })

  it('keeps original resources usable while the publication request fails and retries only that source', async () => {
    const legacyCatalog = vi.fn(async () => [original()])
    const catalog = vi.fn<MarketActions['catalog']>().mockRejectedValueOnce(new Error('Offline')).mockResolvedValue([publication()])
    mount(operations({ catalog, legacyCatalog }))
    await screen.findByText(marketEn.publishedReadFailed)
    expect(screen.getByRole('heading', { name: 'anime-3d-assets' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: marketEn.retryPublished }))
    await screen.findByRole('heading', { name: 'storyboard-review' })
    expect(legacyCatalog).toHaveBeenCalledTimes(1)
    expect(screen.queryByText(marketEn.publishedReadFailed)).toBeNull()
  })

  it('keeps published resources when the original catalog fails, then combines the recovered catalog', async () => {
    const catalog = vi.fn(async () => [publication()])
    const legacyCatalog = vi.fn<MarketActions['legacyCatalog']>().mockRejectedValueOnce(new Error('Offline')).mockResolvedValue([original()])
    mount(operations({ catalog, legacyCatalog }))
    await screen.findByText(marketEn.originalReadFailed)
    expect(screen.getByRole('heading', { name: 'storyboard-review' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: marketEn.retryOriginal }))
    await screen.findByRole('heading', { name: 'anime-3d-assets' })
    expect(catalog).toHaveBeenCalledTimes(1)
  })

  it('loads more cards when scrolling near the end without a load-more button', async () => {
    const view = mount(operations({ legacyCatalog: async () => Array.from({ length: 30 }, (_, n) => original(`skill-${n}`)) }))
    await waitFor(() => { expect(view.container.querySelectorAll('[data-market-legacy]')).toHaveLength(12) })
    const page = view.container.querySelector('[data-muse-skill-market]')!
    Object.defineProperties(page, { scrollHeight: { value: 2000 }, clientHeight: { value: 700 }, scrollTop: { value: 1200 } })
    fireEvent.scroll(page)
    expect(view.container.querySelectorAll('[data-market-legacy]')).toHaveLength(24)
    fireEvent.scroll(page)
    expect(view.container.querySelectorAll('[data-market-legacy]')).toHaveLength(30)
    expect(screen.queryByRole('button', { name: /load more/i })).toBeNull()
  })

  it('uses the returned installation for activation and keeps a failed refresh from removing visible cards', async () => {
    const resource = original(), canonical = installation()
    const catalog = vi.fn<MarketActions['catalog']>().mockResolvedValueOnce([]).mockRejectedValue(new Error('Offline'))
    const installLegacy = vi.fn(async () => ({ resource, installation: canonical }))
    const view = mount(operations({ catalog, legacyCatalog: async () => [resource], installLegacy }))
    await screen.findByRole('heading', { name: resource.title })
    const card = view.container.querySelector('[data-market-legacy]')!
    fireEvent.click(within(card as HTMLElement).getByRole('button', { name: marketEn.install }))
    await within(card as HTMLElement).findByRole('button', { name: marketEn.useVersion })
    fireEvent.click(screen.getByRole('button', { name: marketEn.refresh }))
    await screen.findByText(marketEn.publishedReadFailed)
    expect(screen.getByRole('heading', { name: resource.title })).toBeTruthy()
    expect(installLegacy).toHaveBeenCalledTimes(1)
    await act(async () => undefined)
  })

  it('settles both sources when installation invalidates an in-flight original-catalog read', async () => {
    const item = publication(), canonical = installation(item, item.sha256)
    const pending = Promise.withResolvers<ReturnType<MarketActions['legacyCatalog']> extends Promise<infer T> ? T : never>()
    const legacyCatalog = vi.fn<MarketActions['legacyCatalog']>().mockImplementationOnce(() => pending.promise).mockResolvedValue([original()])
    const state = { installed: false }
    const view = mount(operations({ catalog: async () => [item], legacyCatalog,
      installed: async () => state.installed ? [canonical] : [],
      installPublication: async () => { state.installed = true; return { publication: item, installation: canonical } } }))
    await screen.findByRole('heading', { name: item.manifest.title })
    const card = view.container.querySelector('[data-market-publication]')!
    fireEvent.click(within(card as HTMLElement).getByRole('button', { name: marketEn.install }))
    await screen.findByRole('heading', { name: 'anime-3d-assets' })
    await waitFor(() => { expect(screen.queryByRole('status', { name: marketEn.loading })).toBeNull() })
    expect(legacyCatalog).toHaveBeenCalledTimes(2)
    expect(within(card as HTMLElement).getByRole('button', { name: marketEn.useVersion })).toBeTruthy()
    await act(async () => { pending.resolve([]); await pending.promise })
    expect(screen.getByRole('heading', { name: 'anime-3d-assets' })).toBeTruthy()
  })
})


it('keeps same-name publications from different teams visible', () => {
  const first = publication(), second = { ...first, id: brandString<typeof first.id>('d'.repeat(32)), publisher: 'Another studio' }
  expect(marketListings([first, first, second], [])).toHaveLength(2)
})

it('recognizes the verified canonical installation returned with an original catalog entry', async () => {
  const canonical = installation(), resource = { ...original(), installationId: canonical.release.id }
  const installLegacy = vi.fn()
  mount(operations({ legacyCatalog: async () => [resource], installed: async () => [canonical], installLegacy }))
  await screen.findByRole('button', { name: marketEn.useVersion })
  expect(screen.queryByRole('button', { name: marketEn.install })).toBeNull()
  expect(installLegacy).not.toHaveBeenCalled()
})

it('opens full original requirements and installs directly from the details dialog', async () => {
  const canonical = installation(), resource = { ...original(), requiredSkills: ['audio-transcribe'], validation: 'Requires supplied source material' }
  const installLegacy = vi.fn(async () => ({ resource, installation: canonical }))
  const view = mount(operations({ legacyCatalog: async () => [resource], installLegacy }))
  await screen.findByRole('heading', { name: resource.title })
  fireEvent.click(screen.getByRole('button', { name: marketEn.details }))
  const dialog = screen.getByRole('dialog', { name: resource.title })
  expect(within(dialog).getByText(resource.validation)).toBeTruthy()
  expect(within(dialog).getByRole('button', { name: 'audio-transcribe' })).toBeTruthy()
  fireEvent.click(within(dialog).getByRole('button', { name: marketEn.install }))
  await within(dialog).findByRole('button', { name: marketEn.useVersion })
  expect(installLegacy).toHaveBeenCalledWith(resource.id, resource.sha256)
  view.unmount()
})

it('shows cloud management even when local Skill sources cannot be read', async () => {
  const item = publication(), identity = { accountId: brandString<MarketIdentity['accountId']>('c'.repeat(16)), publishers: [], admin: true }
  const sources = vi.fn(async () => { throw new Error('Local source is offline') })
  mount(operations({ catalog: async () => [item], sources, identity: async () => identity }), { identity })
  fireEvent.click(screen.getByRole('tab', { name: marketEn.publish }))
  await screen.findByRole('heading', { name: item.manifest.title })
  expect(screen.getByRole('group', { name: marketEn.publicationFilter })).toBeTruthy()
  expect(sources).not.toHaveBeenCalled()
})

it('keeps a loading indicator visible while creator publications are pending', async () => {
  const pending = Promise.withResolvers<MarketPublication[]>()
  const identity = { accountId: brandString<MarketIdentity['accountId']>('c'.repeat(16)), publishers: [], admin: true }
  mount(operations({ catalog: async (_query, mine) => mine ? await pending.promise : [], identity: async () => identity }), { identity })
  await waitFor(() => { expect(screen.queryByRole('status', { name: marketEn.loading })).toBeNull() })
  fireEvent.click(screen.getByRole('tab', { name: marketEn.publish }))
  await screen.findByRole('status', { name: marketEn.loading })
  await act(async () => { pending.resolve([publication()]); await pending.promise })
  await screen.findByRole('heading', { name: publication().manifest.title })
  expect(screen.queryByRole('status', { name: marketEn.loading })).toBeNull()
})

it.each([
  { remaining: 321, shown: 12, total: 30, expected: 12 },
  { remaining: 320, shown: 12, total: 30, expected: 12 },
  { remaining: 319, shown: 12, total: 30, expected: 24 },
  { remaining: 100, shown: 24, total: 30, expected: 30 },
  { remaining: 100, shown: 30, total: 30, expected: 30 },
  { remaining: 100, shown: 30, total: 20, expected: 30 },
])('renders $expected cards when $remaining pixels remain with $shown of $total requested', ({ remaining, shown, total, expected }) => {
  expect(nextMarketListingCount({ scrollHeight: 2000, clientHeight: 600, scrollTop: 1400 - remaining }, shown, total)).toBe(expected)
})
