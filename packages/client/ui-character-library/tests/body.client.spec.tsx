// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { CharacterLibraryBody } from '../src/client/CharacterLibraryBody.tsx'
import { defaultLibraryBrowserSource } from '../src/client/catalog.ts'
import { en, zh } from '../src/client/locales.ts'
import type { LibraryBrowserResult, LibraryBrowserSource, LibraryDisplayItem } from '../src/client/types.ts'
import { fixtureLibraryBrowserSource, syntheticLibraryItems, syntheticPreviewSources } from './fixtures/catalog.client.ts'

afterEach(cleanup)

const t = makeTranslate(en)
const unknownItem: LibraryDisplayItem = {
  displayId: 'synthetic:missing', name: 'Missing information', category: 'unknown',
  tags: [], appearanceTags: [], approvalStatus: 'unknown', metadataSummary: [],
}

function readySource(items: readonly LibraryDisplayItem[], origin: 'catalog' | 'fixture' = 'catalog'): LibraryBrowserSource {
  return { load: async () => ({ kind: 'ready', items, origin }) }
}

function pendingSource() {
  let resolveResult: ((result: LibraryBrowserResult) => void) | undefined
  let rejectResult: ((error: Error) => void) | undefined
  const promise = new Promise<LibraryBrowserResult>((resolve, reject) => { resolveResult = resolve; rejectResult = reject })
  const signals: AbortSignal[] = []
  const source: LibraryBrowserSource = { load: ({ signal }) => { signals.push(signal); return promise } }
  return {
    source, signals,
    resolve(result: LibraryBrowserResult): void {
      if (resolveResult === undefined) throw new Error('pending source has no resolver')
      resolveResult(result)
    },
    reject(): void {
      if (rejectResult === undefined) throw new Error('pending source has no rejecter')
      rejectResult(new Error('private source details'))
    },
  }
}

function cardNames(): string[] {
  return within(screen.getByRole('list', { name: en.list })).getAllByRole('button').map(button => button.getAttribute('aria-label') ?? '')
}

function chooseFilter(label: string, option: string): void {
  fireEvent.click(screen.getByRole('button', { name: new RegExp(`^${label}:`) }))
  fireEvent.click(screen.getByRole('menuitem', { name: option }))
}

describe('CharacterLibraryBody', () => {
  it('shows loading before the explicit unconfigured source settles', async () => {
    render(<CharacterLibraryBody source={defaultLibraryBrowserSource} t={t} />)
    expect(screen.getByRole('status').textContent).toBe(en.loading)
    expect(await screen.findByText(en.unconfigured)).toBeDefined()
    expect(screen.getByText(en.unconfiguredDescription)).toBeDefined()
    expect(screen.queryByRole('list')).toBeNull()
    expect(screen.queryByText(en.fixtureBanner)).toBeNull()
  })

  it('keeps fixture labels visible in cards and details and separates every review state', async () => {
    render(<CharacterLibraryBody source={fixtureLibraryBrowserSource} t={t} />)
    expect(await screen.findByText(en.fixtureBanner)).toBeDefined()
    expect(cardNames()).toHaveLength(4)
    const pendingCard = screen.getByRole('button', { name: t('openDetails', { name: 'Test Urban A' }) })
    expect(within(pendingCard).getByText(en['approval.pending_review'])).toBeDefined()
    expect(within(pendingCard).queryByText(en['approval.approved'])).toBeNull()
    expect(screen.getByText(en['approval.approved'])).toBeDefined()
    expect(screen.getByText(en['approval.rejected'])).toBeDefined()
    expect(screen.getByText(en['approval.unknown'])).toBeDefined()

    fireEvent.click(screen.getByRole('button', { name: t('openDetails', { name: 'Test Ancient B' }) }))
    expect(screen.getByText(en.fixtureBanner)).toBeDefined()
    const details = screen.getByRole('article', { name: en.details })
    expect(within(details).getByText('synthetic:ancient-01')).toBeDefined()
    expect(within(details).getByText('Synthetic browser fixture')).toBeDefined()
    expect(within(details).getByText('long hair · robe')).toBeDefined()
    expect(within(details).getByText('Fixture version')).toBeDefined()
    expect(within(details).getByText('test-1')).toBeDefined()
    expect(within(details).getByText(en['approval.approved'])).toBeDefined()
    expect(within(details).getByText(en.bindingUnavailable)).toBeDefined()
    expect(within(details).queryByRole('button', { name: /bind|upload|generate/i })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: en.back }))
    expect(cardNames()).toHaveLength(4)
  })

  it('searches names, display IDs, and tags and restores the list after an empty match', async () => {
    render(<CharacterLibraryBody source={fixtureLibraryBrowserSource} t={t} />)
    const search = await screen.findByRole('textbox', { name: en.search })
    fireEvent.change(search, { target: { value: '  TEST ANCIENT  ' } })
    expect(cardNames()).toEqual([t('openDetails', { name: 'Test Ancient B' })])
    fireEvent.change(search, { target: { value: 'synthetic:urban-02' } })
    expect(cardNames()).toEqual([t('openDetails', { name: 'Test Urban C' })])
    fireEvent.change(search, { target: { value: 'studio' } })
    expect(cardNames()).toEqual([t('openDetails', { name: 'Test Urban A' })])
    fireEvent.change(search, { target: { value: 'absent' } })
    expect(screen.getByText(en.noMatches)).toBeDefined()
    expect(screen.queryByRole('list')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: en.resetFilters }))
    expect(screen.getByRole<HTMLInputElement>('textbox', { name: en.search }).value).toBe('')
    expect(cardNames()).toHaveLength(4)
    expect(screen.getByText(en.fixtureBanner)).toBeDefined()
  })

  it.each([
    [en['category.ancient'], ['Test Ancient B']],
    [en['category.urban'], ['Test Urban A', 'Test Urban C']],
    [en['category.unknown'], ['Test Unknown D']],
  ] as const)('filters the %s category and keeps unknown categories selectable', async (option, names) => {
    render(<CharacterLibraryBody source={fixtureLibraryBrowserSource} t={t} />)
    await screen.findByRole('textbox', { name: en.search })
    chooseFilter(en['filter.category'], option)
    expect(cardNames()).toEqual(names.map(name => t('openDetails', { name })))
    chooseFilter(en['filter.category'], en.all)
    expect(cardNames()).toHaveLength(4)
  })

  it('combines gender, style, appearance, and review filters and retains them after closing details', async () => {
    render(<CharacterLibraryBody source={fixtureLibraryBrowserSource} t={t} />)
    await screen.findByRole('textbox', { name: en.search })
    chooseFilter(en['filter.gender'], 'female')
    expect(cardNames()).toHaveLength(2)
    chooseFilter(en['filter.style'], 'illustrated')
    chooseFilter(en['filter.appearance'], 'robe')
    chooseFilter(en['filter.approval'], en['approval.approved'])
    expect(cardNames()).toEqual([t('openDetails', { name: 'Test Ancient B' })])
    fireEvent.click(screen.getByRole('button', { name: t('openDetails', { name: 'Test Ancient B' }) }))
    fireEvent.click(screen.getByRole('button', { name: en.back }))
    expect(cardNames()).toEqual([t('openDetails', { name: 'Test Ancient B' })])
    chooseFilter(en['filter.approval'], en['approval.pending_review'])
    expect(screen.getByText(en.noMatches)).toBeDefined()
    fireEvent.click(screen.getByRole('button', { name: en.resetFilters }))
    expect(cardNames()).toHaveLength(4)
    for (const label of ['filter.category', 'filter.gender', 'filter.style', 'filter.appearance', 'filter.approval'] as const) {
      expect(screen.getByRole('button', { name: t('filterNamed', { label: en[label], value: en.all }) })).toBeDefined()
    }
  })

  it('offers unknown filters for missing gender, style, appearance, and review information', async () => {
    render(<CharacterLibraryBody source={fixtureLibraryBrowserSource} t={t} />)
    await screen.findByRole('textbox', { name: en.search })
    for (const label of [en['filter.gender'], en['filter.style'], en['filter.appearance']]) {
      chooseFilter(label, en.unknown)
      expect(cardNames()).toEqual([t('openDetails', { name: 'Test Unknown D' })])
    }
    chooseFilter(en['filter.approval'], en['approval.unknown'])
    expect(cardNames()).toEqual([t('openDetails', { name: 'Test Unknown D' })])
    fireEvent.click(screen.getByRole('button', { name: t('openDetails', { name: 'Test Unknown D' }) }))
    expect(screen.getByText(en.noMetadata)).toBeDefined()
    expect(screen.getByText(en['approval.unknown'])).toBeDefined()
  })

  it('dismisses a filter menu with Escape or an outside press without changing the active facet', async () => {
    render(<CharacterLibraryBody source={fixtureLibraryBrowserSource} t={t} />)
    await screen.findByRole('textbox', { name: en.search })
    chooseFilter(en['filter.gender'], 'female')
    const trigger = screen.getByRole('button', { name: t('filterNamed', { label: en['filter.gender'], value: 'female' }) })
    trigger.focus()
    fireEvent.click(trigger)
    expect(screen.getByRole('menu')).toBeDefined()
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByRole('menu')).toBeNull()
    expect(trigger.getAttribute('aria-expanded')).toBe('false')
    expect(document.activeElement).toBe(trigger)
    expect(cardNames()).toHaveLength(2)

    fireEvent.click(trigger)
    fireEvent.pointerDown(document.body)
    expect(screen.queryByRole('menu')).toBeNull()
    expect(trigger.getAttribute('aria-expanded')).toBe('false')
    expect(cardNames()).toHaveLength(2)
  })

  it('allows clearing a retained facet after a replacement source has no matching option', async () => {
    const view = render(<CharacterLibraryBody source={fixtureLibraryBrowserSource} t={t} />)
    await screen.findByRole('textbox', { name: en.search })
    chooseFilter(en['filter.gender'], 'male')
    expect(cardNames()).toEqual([t('openDetails', { name: 'Test Urban A' })])

    view.rerender(<CharacterLibraryBody source={readySource([unknownItem])} t={t} />)
    expect(await screen.findByText(en.noMatches)).toBeDefined()
    chooseFilter(en['filter.gender'], en.all)
    expect(cardNames()).toEqual([t('openDetails', { name: unknownItem.name })])
    expect(screen.queryByText(en.fixtureBanner)).toBeNull()
  })

  it('shows a catalog empty state without marking it as fixture data', async () => {
    render(<CharacterLibraryBody source={readySource([])} t={t} />)
    expect(await screen.findByText(en.empty)).toBeDefined()
    expect(screen.queryByText(en.fixtureBanner)).toBeNull()
    expect(screen.queryByRole('button', { name: en.resetFilters })).toBeNull()
  })

  it('shows missing detail fields without inventing metadata, approval, or a binding action', async () => {
    render(<CharacterLibraryBody source={readySource([unknownItem])} t={t} />)
    fireEvent.click(await screen.findByRole('button', { name: t('openDetails', { name: unknownItem.name }) }))
    const details = screen.getByRole('article', { name: en.details })
    expect(within(details).getAllByText(en.unknown).length).toBeGreaterThan(0)
    expect(within(details).getByText(en['approval.unknown'])).toBeDefined()
    expect(within(details).queryByText(en['approval.approved'])).toBeNull()
    expect(within(details).getByText(en.noMetadata)).toBeDefined()
    expect(within(details).getByText(en.noImage)).toBeDefined()
    expect(within(details).getByText(en.bindingUnavailable)).toBeDefined()
    expect(within(details).queryByRole('button')).toBeNull()
  })

  it('handles image loading and errors in cards, details, and the shared preview modal', async () => {
    const item = syntheticLibraryItems[0]
    if (item === undefined) throw new Error('missing urban fixture')
    render(<CharacterLibraryBody source={readySource([item])} t={t} />)
    const card = await screen.findByRole('button', { name: t('openDetails', { name: item.name }) })
    const cardImage = within(card).getByRole('img')
    expect(within(card).getByText(en.imageLoading)).toBeDefined()
    fireEvent.load(cardImage)
    expect(within(card).queryByText(en.imageLoading)).toBeNull()
    fireEvent.error(cardImage)
    expect(within(card).getByText(en.imageError)).toBeDefined()
    expect(within(card).queryByRole('img')).toBeNull()
    fireEvent.click(card)
    const details = screen.getByRole('article', { name: en.details })
    fireEvent.error(within(details).getByRole('img'))
    expect(within(details).getByText(en.imageError)).toBeDefined()

    const opener = screen.getByRole('button', { name: t('openPreview', { name: item.name }) })
    opener.focus()
    fireEvent.click(opener)
    const dialog = screen.getByRole('dialog', { name: t('previewTitle', { name: item.name }) })
    expect(within(dialog).getByRole('img').getAttribute('src')).toBe(syntheticPreviewSources.urban)
    fireEvent.error(within(dialog).getByRole('img'))
    expect(within(dialog).getByText(en.imageError)).toBeDefined()
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(document.activeElement).toBe(opener)
    fireEvent.click(opener)
    fireEvent.click(screen.getByRole('button', { name: en.closePreview }))
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it.each(['https://example.com/person.png', 'http://example.com/person.png', 'file:///C:/person.png', 'javascript:alert(1)'])('does not put %s into an image or preview link', async (src) => {
    const item = { ...unknownItem, thumbnailSrc: src, previewSrc: src }
    const view = render(<CharacterLibraryBody source={readySource([item])} t={t} />)
    fireEvent.click(await screen.findByRole('button', { name: t('openDetails', { name: item.name }) }))
    expect(view.container.querySelector('img')).toBeNull()
    expect(view.container.querySelector('a')).toBeNull()
    expect(screen.queryByRole('button', { name: t('openPreview', { name: item.name }) })).toBeNull()
    expect(screen.getByText(en.noImage)).toBeDefined()
  })

  it('accepts a controlled blob preview without offering a network navigation target', async () => {
    const blob = 'blob:http://localhost/11111111-2222-3333-4444-555555555555'
    const item = { ...unknownItem, thumbnailSrc: blob, previewSrc: blob }
    const view = render(<CharacterLibraryBody source={readySource([item])} t={t} />)
    const card = await screen.findByRole('button', { name: t('openDetails', { name: item.name }) })
    expect(within(card).getByRole('img').getAttribute('src')).toBe(blob)
    fireEvent.click(card)
    fireEvent.click(screen.getByRole('button', { name: t('openPreview', { name: item.name }) }))
    expect(within(screen.getByRole('dialog')).getByRole('img').getAttribute('src')).toBe(blob)
    expect(view.container.querySelector('a')).toBeNull()
  })

  it('uses fixed error copy and retries with a new cancellable load', async () => {
    const pending = pendingSource()
    const load = vi.fn<LibraryBrowserSource['load']>()
      .mockRejectedValueOnce(new Error('private source details'))
      .mockImplementation(options => pending.source.load(options))
    render(<CharacterLibraryBody source={{ load }} t={t} />)
    expect(await screen.findByRole('alert')).toHaveProperty('textContent', `${en.error}${en.retry}`)
    expect(screen.queryByText('private source details')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: en.retry }))
    expect(screen.getByRole('status').textContent).toBe(en.loading)
    expect(load).toHaveBeenCalledTimes(2)
    expect(load.mock.calls[0]?.[0].signal.aborted).toBe(true)
    await act(async () => { pending.resolve({ kind: 'ready', items: syntheticLibraryItems, origin: 'fixture' }) })
    expect(screen.getByText(en.fixtureBanner)).toBeDefined()
    expect(cardNames()).toHaveLength(4)
  })

  it('also contains a synchronously thrown source failure', async () => {
    const source: LibraryBrowserSource = { load: () => { throw new Error('private synchronous details') } }
    render(<CharacterLibraryBody source={source} t={t} />)
    expect(await screen.findByText(en.error)).toBeDefined()
    expect(screen.queryByText('private synchronous details')).toBeNull()
  })

  it.each(['resolve', 'reject'] as const)('ignores an old source %s after the view moves to a new source', async (settlement) => {
    const old = pendingSource()
    const next = pendingSource()
    const view = render(<CharacterLibraryBody source={old.source} t={t} />)
    view.rerender(<CharacterLibraryBody source={next.source} t={t} />)
    expect(old.signals[0]?.aborted).toBe(true)
    await act(async () => { next.resolve({ kind: 'ready', items: [unknownItem], origin: 'catalog' }) })
    await act(async () => {
      if (settlement === 'resolve') old.resolve({ kind: 'ready', items: syntheticLibraryItems, origin: 'fixture' })
      else old.reject()
    })
    expect(cardNames()).toEqual([t('openDetails', { name: unknownItem.name })])
    expect(screen.queryByText(en.fixtureBanner)).toBeNull()
    expect(screen.queryByRole('alert')).toBeNull()
    view.unmount()
    expect(next.signals[0]?.aborted).toBe(true)
  })

  it.each(['resolve', 'reject'] as const)('aborts a load on unmount and contains its later %s', async (settlement) => {
    const pending = pendingSource()
    const view = render(<CharacterLibraryBody source={pending.source} t={t} />)
    view.unmount()
    expect(pending.signals[0]?.aborted).toBe(true)
    await act(async () => {
      if (settlement === 'resolve') pending.resolve({ kind: 'ready', items: syntheticLibraryItems, origin: 'fixture' })
      else pending.reject()
    })
    expect(screen.queryByRole('list')).toBeNull()
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it.each([en, zh])('renders controls and review labels through the active locale', async (dictionary) => {
    render(<CharacterLibraryBody source={fixtureLibraryBrowserSource} t={makeTranslate(dictionary)} />)
    expect(await screen.findByRole('textbox', { name: dictionary.search })).toHaveProperty('placeholder', dictionary.searchPlaceholder)
    expect(screen.getByText(dictionary.fixtureBanner)).toBeDefined()
    expect(screen.getByText(dictionary['approval.pending_review'])).toBeDefined()
    expect(screen.getByText(dictionary['approval.unknown'])).toBeDefined()
    expect(Object.keys(en).sort()).toEqual(Object.keys(zh).sort())
  })
})
