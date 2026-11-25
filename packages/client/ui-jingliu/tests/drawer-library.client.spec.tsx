// @vitest-environment jsdom
/** The asset library tab of the Bot team's details drawer: kinds, search and handing an asset to Muse. */
import { fireEvent, render } from '@testing-library/react'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import type { StudioLibrary } from '@deepseek-ai/dsh-jingliu-connection/types'
import { expect, it, vi } from 'vitest'
import { DrawerLibrary, type DrawerLibraryProps } from '../src/client/DrawerLibrary.tsx'
import { en } from '../src/client/locales.ts'

const night = { id: 'a1', kind: 'location', name: 'Night market', thumbnail: '', description: 'Lantern street at night', referenceOnly: false, uses: 7 }

type LibraryRead = (url: URL) => { status: 'live' | 'loading' | 'failed'; value?: StudioLibrary }

function setup(readLibrary?: LibraryRead) {
  const reads: string[] = []
  const useResource = ((address: string) => {
    reads.push(address)
    if (!address.startsWith('dsh-resource://')) return { status: 'none', failure: undefined, value: undefined }
    const url = new URL(address)
    if (readLibrary && url.hostname === 'jingliu-library') return { failure: undefined, ...readLibrary(url) }
    const kind = url.searchParams.get('kind')
    return { status: 'live', failure: undefined, value: { total: 1, items: kind === 'location' || kind === 'all' ? [night] : [] } }
  }) as DrawerLibraryProps['useResource']
  const props: DrawerLibraryProps = { t: makeTranslate(en), useResource, useAccountEpoch: select => select(1), compose: vi.fn() }
  return { props, reads }
}

it('lists a kind with its use count and prompt, and hands a picked asset to the message box', () => {
  const { props, reads } = setup()
  const view = render(<DrawerLibrary {...props} />)
  const kinds = view.getByRole('group', { name: en.assetType })
  expect([...kinds.querySelectorAll('button')].map(button => button.textContent)).toEqual(
    ['Characters', 'Locations', 'Props', 'Posters', 'Videos', 'Effects', 'Audio', 'Sound effects', 'BGM'])
  fireEvent.click(view.getByRole('button', { name: en.location }))
  const row = view.getByRole('button', { name: 'Night market, used 7 times; drag it into the message box for Muse' })
  expect(row.textContent).toContain('7×')
  expect(row.textContent).toContain('Lantern street at night')
  expect(reads.some(address => address.includes('kind=location'))).toBe(true)
  fireEvent.click(row)
  expect(props.compose).toHaveBeenCalledWith('Night market (Locations from the asset library)')
  view.unmount()
})

it('reads nothing for a kind the shared library does not hold, and a search covers every kind', () => {
  const { props, reads } = setup()
  const view = render(<DrawerLibrary {...props} />)
  fireEvent.click(view.getByRole('button', { name: en.bgm }))
  expect(view.getByText('Nothing found')).toBeTruthy()
  expect(reads.at(-1)).toBe('studio://inactive')
  fireEvent.change(view.getByRole('textbox', { name: 'Search by name' }), { target: { value: 'Night' } })
  fireEvent.submit(view.getByRole('search'))
  expect(reads.some(address => address.includes('kind=all') && address.includes('query=Night'))).toBe(true)
  expect(view.getByRole('button', { name: /Night market/u })).toBeTruthy()
  view.unmount()
})

it('reports an active library read and retries a failed request with a new revision', () => {
  let status: 'loading' | 'failed' = 'loading'
  const { props, reads } = setup(url => url.searchParams.get('revision') === '0'
    ? { status }
    : { status: 'live', value: { items: [night], total: 1 } })
  const view = render(<DrawerLibrary {...props} />)
  expect(view.getByText(en.loading)).toBeTruthy()

  status = 'failed'
  view.rerender(<DrawerLibrary {...props} />)
  expect(view.getByRole('alert').textContent).toContain(en.failed)
  fireEvent.click(view.getByRole('button', { name: en.refresh }))
  expect(reads.some(address => address.includes('revision=1'))).toBe(true)
  expect(view.queryByRole('alert')).toBeNull()
  expect(view.getByRole('button', { name: /Night market/u })).toBeTruthy()
  view.unmount()
})

it('pages through matches, drags a general asset reference, and restores the chosen kind on clearing the query', () => {
  const reel = { ...night, id: 'v1', kind: 'video', name: 'Market reel', description: '', uses: 0 }
  const { props, reads } = setup((url) => {
    const matched = url.searchParams.get('offset') === '24' ? reel : night
    return { status: 'live', value: { items: [matched], total: 25 } }
  })
  const view = render(<DrawerLibrary {...props} />)
  fireEvent.click(view.getByRole('button', { name: en.location }))
  const search = view.getByRole('textbox', { name: en.searchLibrary })
  fireEvent.change(search, { target: { value: 'Market' } })
  fireEvent.submit(view.getByRole('search'))
  fireEvent.click(view.getByRole('button', { name: en.next }))
  expect(reads.some(address => address.includes('kind=all&query=Market&offset=24'))).toBe(true)
  const row = view.getByRole('button', { name: /Market reel/u })
  const dataTransfer = { setData: vi.fn(), effectAllowed: 'none' }
  fireEvent.dragStart(row, { dataTransfer })
  expect(dataTransfer.setData).toHaveBeenCalledExactlyOnceWith('text/plain', 'Market reel (Asset from the asset library)')
  expect(dataTransfer.effectAllowed).toBe('copy')

  fireEvent.click(view.getByRole('button', { name: en.previous }))
  expect(view.getByRole('button', { name: /Night market/u })).toBeTruthy()
  fireEvent.change(search, { target: { value: '' } })
  expect(reads.filter(address => address.startsWith('dsh-resource:')).at(-1)).toContain('kind=location&query=&offset=0')
  view.unmount()
})
