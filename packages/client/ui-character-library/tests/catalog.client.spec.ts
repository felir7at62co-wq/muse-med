/** Local display filtering, test-source labels, denied mutation capability, and restricted previews. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  defaultLibraryBrowserSource,
  filterLibraryItems,
  libraryReadOnlyCapability,
  safeLibraryPreviewSrc,
} from '../src/client/catalog.ts'
import type { LibraryBrowserSource, LibraryDisplayItem, LibraryFilters } from '../src/client/types.ts'
import { fixtureLibraryBrowserSource, syntheticLibraryItems, syntheticPreviewSources } from './fixtures/catalog.client.ts'

afterEach(() => { vi.unstubAllGlobals() })

const ids = (items: readonly LibraryDisplayItem[]) => items.map(item => item.displayId)
const allIds = ids(syntheticLibraryItems)

describe('display sources', () => {
  it('keeps the shipped source unconfigured without issuing network requests', async () => {
    const fetcher = vi.fn()
    vi.stubGlobal('fetch', fetcher)
    const result = await defaultLibraryBrowserSource.load({ signal: new AbortController().signal })
    expect(result).toEqual({ kind: 'unconfigured' })
    expect(fetcher).not.toHaveBeenCalled()
  })

  it('labels opted-in test data as fixtures with synthetic display identities', async () => {
    const result = await fixtureLibraryBrowserSource.load({ signal: new AbortController().signal })
    expect(result).toEqual({ kind: 'ready', items: syntheticLibraryItems, origin: 'fixture' })
    expect(syntheticLibraryItems.every(item => item.displayId.startsWith('synthetic:'))).toBe(true)
    expect(syntheticLibraryItems.every(item => item.sourceDescription === 'Synthetic browser fixture')).toBe(true)
    expect(Object.values(syntheticPreviewSources).every(source => safeLibraryPreviewSrc(source) === source)).toBe(true)
    expect(new Set(Object.values(syntheticPreviewSources)).size).toBe(3)
  })

  it('keeps a catalog adapter result distinct from fixture results', async () => {
    const catalogSource: LibraryBrowserSource = {
      async load({ signal }) {
        signal.throwIfAborted()
        return { kind: 'ready', items: [], origin: 'catalog' }
      },
    }
    expect(await catalogSource.load({ signal: new AbortController().signal })).toEqual({
      kind: 'ready', items: [], origin: 'catalog',
    })
  })

  it.each([defaultLibraryBrowserSource, fixtureLibraryBrowserSource])('rejects a cancelled source load', async (source) => {
    const controller = new AbortController()
    const reason = new Error('Cancelled browser load')
    controller.abort(reason)
    await expect(source.load({ signal: controller.signal })).rejects.toBe(reason)
  })

  it('keeps every displayed review state read only', () => {
    expect(syntheticLibraryItems.map(item => item.approvalStatus)).toEqual([
      'pending_review', 'approved', 'rejected', 'unknown',
    ])
    expect(libraryReadOnlyCapability).toEqual({ kind: 'no_bind' })
    expect(Object.isFrozen(libraryReadOnlyCapability)).toBe(true)
    expect(Reflect.set(libraryReadOnlyCapability, 'kind', 'bind')).toBe(false)
    expect(libraryReadOnlyCapability.kind).toBe('no_bind')
    expect(syntheticLibraryItems.some(item => 'canBind' in item)).toBe(false)
  })
})

describe('display filters', () => {
  it('preserves empty lists and leaves the source list unchanged', () => {
    expect(filterLibraryItems([], {})).toEqual([])
    expect(filterLibraryItems(syntheticLibraryItems, {})).toEqual(syntheticLibraryItems)
    expect(ids(syntheticLibraryItems)).toEqual(allIds)
  })

  const searches: readonly { q: string; expected: readonly string[] }[] = [
    { q: 'SYNTHETIC:URBAN-01', expected: ['synthetic:urban-01'] },
    { q: ' test ancient ', expected: ['synthetic:ancient-01'] },
    { q: 'STUDIO', expected: ['synthetic:urban-01'] },
    { q: 'missing search term', expected: [] },
    { q: '  ', expected: allIds },
  ]

  it.each(searches)('searches display IDs, names and tags for $q', ({ q, expected }) => {
    expect(ids(filterLibraryItems(syntheticLibraryItems, { q }))).toEqual(expected)
  })

  const facets: readonly { filters: LibraryFilters; expected: readonly string[] }[] = [
    { filters: { category: 'urban' }, expected: ['synthetic:urban-01', 'synthetic:urban-02'] },
    { filters: { category: 'ancient' }, expected: ['synthetic:ancient-01'] },
    { filters: { category: 'unknown' }, expected: ['synthetic:unknown-01'] },
    { filters: { gender: 'female' }, expected: ['synthetic:ancient-01', 'synthetic:urban-02'] },
    { filters: { gender: 'male' }, expected: ['synthetic:urban-01'] },
    { filters: { style: 'realistic' }, expected: ['synthetic:urban-01', 'synthetic:urban-02'] },
    { filters: { style: 'illustrated' }, expected: ['synthetic:ancient-01'] },
    { filters: { approvalStatus: 'pending_review' }, expected: ['synthetic:urban-01'] },
    { filters: { approvalStatus: 'approved' }, expected: ['synthetic:ancient-01'] },
    { filters: { approvalStatus: 'rejected' }, expected: ['synthetic:urban-02'] },
    { filters: { approvalStatus: 'unknown' }, expected: ['synthetic:unknown-01'] },
    { filters: { appearance: 'long hair' }, expected: ['synthetic:ancient-01', 'synthetic:urban-02'] },
    { filters: { category: 'ancient', style: 'realistic' }, expected: [] },
    {
      filters: { q: 'modern', category: 'urban', gender: 'female', style: 'realistic', approvalStatus: 'rejected', appearance: 'long hair' },
      expected: ['synthetic:urban-02'],
    },
  ]

  it.each(facets)('combines selected facets: $filters', ({ filters, expected }) => {
    expect(ids(filterLibraryItems(syntheticLibraryItems, filters))).toEqual(expected)
  })

  it('allows all filters to be cleared', () => {
    expect(ids(filterLibraryItems(syntheticLibraryItems, {
      category: 'all', gender: '', style: 'all', approvalStatus: 'all', appearance: 'all',
    }))).toEqual(allIds)
  })

  it('keeps unknown values selectable for optional fields and absent appearance tags', () => {
    const unknownItems: readonly LibraryDisplayItem[] = [
      syntheticLibraryItems[3]!,
      { ...syntheticLibraryItems[3]!, displayId: 'synthetic:unknown-empty', gender: '', style: '', appearanceTags: ['unknown'] },
      { ...syntheticLibraryItems[3]!, displayId: 'synthetic:unknown-label', gender: 'unknown', style: 'unknown' },
      { ...syntheticLibraryItems[3]!, displayId: 'synthetic:unknown-space', gender: ' ', style: ' ' },
    ]
    expect(filterLibraryItems(unknownItems, {
      category: 'unknown', gender: 'unknown', style: 'unknown', approvalStatus: 'unknown', appearance: 'unknown',
    })).toEqual(unknownItems)
    expect(ids(filterLibraryItems(syntheticLibraryItems, { gender: 'unknown', style: 'unknown', appearance: 'unknown' })))
      .toEqual(['synthetic:unknown-01'])
    expect(filterLibraryItems(syntheticLibraryItems, { appearance: 'unknown', category: 'urban' })).toEqual([])
  })
})

describe('preview sources', () => {
  const objectId = '12345678-1234-1234-1234-123456789abc'

  it.each([
    syntheticPreviewSources.urban,
    'data:image/jpeg;base64,AAAA',
    'data:image/webp;base64,AAA=',
    `blob:https://example.test/${objectId}`,
    `blob:http://127.0.0.1:3210/${objectId}`,
    `blob:null/${objectId}`,
  ])('accepts controlled inline raster or browser object URLs', (source) => {
    expect(safeLibraryPreviewSrc(source)).toBe(source)
  })

  it.each([
    undefined,
    '',
    'file:///C:/private/portrait.png',
    'C:\\private\\portrait.png',
    'https://example.test/portrait.png',
    'http://example.test/portrait.png',
    '//example.test/portrait.png',
    'javascript:alert(1)',
    'data:text/html;base64,AAAA',
    'data:image/svg+xml;base64,AAAA',
    'data:image/gif;base64,AA==',
    'data:image/avif;base64,AAAA',
    'data:image/png,<svg/>',
    'data:image/png;base64,',
    'data:image/png;base64,A',
    'data:image/png;base64,AAAA==',
    'data:image/png;base64,AA_A',
    ' data:image/png;base64,AAAA',
    `blob:file:///${objectId}`,
    'blob:javascript:alert(1)',
    'blob:https://example.test/not-an-object-id',
    `blob:https://[broken]/${objectId}`,
    `blob:https://user@example.test/${objectId}`,
    `blob:https://example.test/${objectId}?query=1`,
    `blob:https://example.test/${objectId}#fragment`,
  ])('rejects remote, file, active and malformed preview sources', (source) => {
    expect(safeLibraryPreviewSrc(source)).toBeUndefined()
  })
})
