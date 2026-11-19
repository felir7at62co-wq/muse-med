// @vitest-environment jsdom
/** Shared-role search, original-image preview and account changes in the native studio panel. */
import { fireEvent, render } from '@testing-library/react'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { expect, it } from 'vitest'
import { Assets } from '../src/client/Production.tsx'
import { en } from '../src/client/locales.ts'

type Props = Parameters<typeof Assets>[0]

it('opens a reference from the shared character filter and drops it when the account changes', () => {
  let epoch = 1
  const paths: URL[] = []
  const item = { id: 'mref-portrait', name: 'Portrait', kind: 'character', thumbnail: '/fw/media/character-references/portrait.png',
    description: 'Hairpin', referenceOnly: true }
  const useResource = ((address: string) => {
    const path = new URL(address)
    paths.push(path)
    return { status: 'live', failure: undefined, value: path.hostname === 'jingliu-image' ? 'data:image/png;base64,AQID' :
      { total: epoch === 1 ? 1 : 0, items: epoch === 1 ? [item] : [] } }
  }) as Props['useResource']
  const props = { t: makeTranslate(en), useResource, useAccountEpoch: <T,>(select: (value: number) => T) => select(epoch) } as Props
  const view = render(<Assets {...props} />)
  fireEvent.click(view.getByRole('tab', { name: 'Characters' }))
  fireEvent.change(view.getByRole('textbox', { name: 'Search shared assets' }), { target: { value: 'Hairpin' } })
  fireEvent.click(view.getByRole('button', { name: 'Search' }))
  expect(paths.some(p => p.searchParams.get('kind') === 'character' && p.searchParams.get('query') === 'Hairpin')).toBe(true)
  fireEvent.click(view.getByRole('button', { name: 'Portrait' }))
  expect(view.getByRole('dialog', { name: 'Portrait' })).toBeTruthy()
  expect(view.getByText('Creative reference')).toBeTruthy()
  expect(paths.some(p => p.hostname === 'jingliu-image' && p.searchParams.get('path') === item.thumbnail)).toBe(true)
  epoch = 2
  view.rerender(<Assets {...props} />)
  expect(view.queryByRole('dialog')).toBeNull()
  expect(view.getByText('No matching assets')).toBeTruthy()
  view.unmount()
})
