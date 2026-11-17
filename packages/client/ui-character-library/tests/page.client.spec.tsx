// @vitest-environment jsdom
/** People can browse, filter and inspect references without modifying the library. */
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it } from 'vitest'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import type { CharacterLibraryEntry } from '@deepseek-ai/dsh-api-character-library/types'
import { LibraryPage } from '../src/client/LibraryPage.tsx'
import { en } from '../src/client/locales.ts'
import type {} from '../src/client/index.ts'

afterEach(cleanup)

type Props = Parameters<typeof LibraryPage>[0]
const entry: CharacterLibraryEntry = {
  catalogAssetId: 'character:muse-character-reference-qa:ancient-a' as CharacterLibraryEntry['catalogAssetId'],
  originalAssetId: 'ancient-a' as CharacterLibraryEntry['originalAssetId'], collection: 'ancient', format: 'legacy_v1',
  metadataStatus: 'pending_review', metadataKey: 'reference.metadata.json', imageKey: 'reference.png',
  category: 'character', setting: 'ancient', artStyle: '3D', era: ['ancient'], gender: 'female',
  appearance: ['gentle'], tags: ['blue costume'],
  safety: { canPublish: false, canReuse: false, canBind: false, applyAllowed: false },
}

function props({ configured = true, failed = false, imageFailed = false, imageLoading = false,
  catalogLoading = false, metadata = true, retainedCatalog = false, emptyNextPage = false }: {
  configured?: boolean
  failed?: boolean
  imageFailed?: boolean
  imageLoading?: boolean
  catalogLoading?: boolean
  metadata?: boolean
  retainedCatalog?: boolean
  emptyNextPage?: boolean
} = {}) {
  const addresses: string[] = []
  const useResource = ((address: string) => {
    addresses.push(address)
    const host = new URL(address).hostname
    if (host === 'character-library-status') return { status: 'live', value: { configured, readOnly: true }, failure: undefined }
    const nextPageEmpty = emptyNextPage && new URL(address).searchParams.has('cursor')
    if (host === 'character-library-catalog') return {
      status: catalogLoading ? 'loading' : failed ? 'failed' : 'live',
      value: catalogLoading || (failed && !retainedCatalog) ? undefined : {
        entries: nextPageEmpty ? [] : [metadata ? entry : { ...entry, artStyle: '', appearance: [], tags: [] }],
        nextCursor: nextPageEmpty ? null : 'next-page', scanned: 1,
      },
      failure: undefined,
    }
    if (host === 'character-library-image') return {
      status: imageLoading ? 'loading' : imageFailed ? 'failed' : 'live',
      value: imageFailed || imageLoading ? undefined : { dataUrl: 'data:image/png;base64,AQID', sha256: 'a'.repeat(64) }, failure: undefined,
    }
    return { status: 'none', value: undefined, failure: undefined }
  }) as Props['useResource']
  return { addresses, value: { useResource, t: makeTranslate(en) } as Props }
}

it('shows character cards, collection filters and a dismissable image preview', () => {
  const fixture = props()
  const view = render(<LibraryPage {...fixture.value} />)
  expect(screen.getByRole('heading', { name: 'Character library' })).toBeTruthy()
  expect(screen.getByText('Read-only references')).toBeTruthy()
  expect(screen.queryByRole('button', { name: /upload|delete|edit/i })).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'View character reference: ancient-a' }))
  expect(screen.getByRole('dialog', { name: 'ancient-a' })).toBeTruthy()
  expect(screen.getByText(en.referenceOnly)).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'Close' }))
  expect(screen.queryByRole('dialog')).toBeNull()
  fireEvent.click(screen.getByRole('tab', { name: 'Urban' }))
  expect(fixture.addresses.some(address => address.includes('collection=urban'))).toBe(true)
  fireEvent.change(screen.getByRole('textbox', { name: en.search }), { target: { value: 'gentle' } })
  fireEvent.click(screen.getByRole('button', { name: 'Search' }))
  expect(fixture.addresses.some(address => address.includes('query=gentle'))).toBe(true)
  fireEvent.click(screen.getByRole('button', { name: 'Next' }))
  expect(fixture.addresses.some(address => address.includes('cursor=next-page'))).toBe(true)
  fireEvent.click(screen.getByRole('button', { name: 'Previous' }))
  fireEvent.click(screen.getByRole('button', { name: 'Refresh' }))
  expect(fixture.addresses.some(address => address.includes('revision=1'))).toBe(true)
  expect(view.container.querySelector('img')?.getAttribute('src')).toBe('data:image/png;base64,AQID')
})

it('reports missing access and failed reads without offering mutation controls', () => {
  const disconnected = props({ configured: false })
  const view = render(<LibraryPage {...disconnected.value} />)
  expect(screen.getByText(en.unavailable)).toBeTruthy()
  view.unmount()
  const failure = props({ failed: true })
  render(<LibraryPage {...failure.value} />)
  expect(screen.getByRole('alert').textContent).toContain(en.failed)
  fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
  expect(failure.addresses.some(address => address.includes('revision=1'))).toBe(true)
})

it('reports thumbnail failure and lets the person retry from the image preview', () => {
  const fixture = props({ imageFailed: true })
  render(<LibraryPage {...fixture.value} />)
  expect(screen.getByText(en.imageFailed)).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'View character reference: ancient-a' }))
  expect(screen.getByRole('alert').textContent).toContain(en.previewFailed)
  fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
  expect(fixture.addresses.some(address => address.includes('revision=1'))).toBe(true)
})

it('keeps a route back from an empty later page and refreshes from the first page', () => {
  const fixture = props({ emptyNextPage: true })
  render(<LibraryPage {...fixture.value} />)
  fireEvent.click(screen.getByRole('button', { name: 'Next' }))
  expect(screen.getByText(en.empty)).toBeTruthy()
  expect(screen.getByRole('button', { name: 'Previous' }).hasAttribute('disabled')).toBe(false)
  fireEvent.click(screen.getByRole('button', { name: 'Refresh' }))
  expect(screen.getByRole('button', { name: 'View character reference: ancient-a' })).toBeTruthy()
  const refreshed = fixture.addresses.filter(address => address.includes('character-library-catalog') && address.includes('revision=1'))
  expect(refreshed.every(address => !address.includes('cursor='))).toBe(true)
})

it('shows catalog skeletons while a first read is pending', () => {
  const fixture = props({ catalogLoading: true })
  render(<LibraryPage {...fixture.value} />)
  expect(screen.getByRole('tabpanel').getAttribute('aria-busy')).toBe('true')
  expect(screen.getByLabelText(en.loading)).toBeTruthy()
  expect(screen.queryByText(en.empty)).toBeNull()
  expect(screen.queryByRole('button', { name: 'View character reference: ancient-a' })).toBeNull()
})

it('keeps unloaded images pending in cards and previews and names a sparse entry by collection', () => {
  const fixture = props({ imageLoading: true, metadata: false })
  const view = render(<LibraryPage {...fixture.value} />)
  const card = screen.getByRole('button', { name: 'View character reference: ancient-a' })
  expect(card.querySelector('[aria-busy="true"]')).toBeTruthy()
  expect(card.textContent).toContain(en.ancient)
  expect(view.container.querySelector('img')).toBeNull()
  fireEvent.click(card)
  expect(screen.getByRole('dialog', { name: 'ancient-a' })).toBeTruthy()
  expect(screen.getByLabelText(en.loading)).toBeTruthy()
  expect(screen.queryByRole('alert')).toBeNull()
  expect(screen.queryByRole('img')).toBeNull()
})

it('retains cards next to the retry notice after a refresh fails', () => {
  const fixture = props({ failed: true, retainedCatalog: true })
  render(<LibraryPage {...fixture.value} />)
  expect(screen.getByRole('alert').textContent).toContain(en.failed)
  expect(screen.getByRole('button', { name: 'View character reference: ancient-a' })).toBeTruthy()
  expect(screen.queryByText(en.empty)).toBeNull()
})
