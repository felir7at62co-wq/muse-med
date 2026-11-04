// @vitest-environment jsdom
/** Cloud review uses the displayed revision and never advances before Host confirmation. */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { MarketPublications } from '../src/client/MarketPublications.tsx'
import type { MarketSectionProps } from '../src/client/MarketSection.tsx'
import type { MarketRelease } from '@deepseek-ai/dsh-muse-market/types'
import { marketFixture } from './market-fixture.client.ts'
import { marketZh, marketEn, type MarketLocaleKey } from '../src/client/market-locales.ts'
import { resolve } from 'node:path'

afterEach(cleanup)
const draft: MarketRelease = { ...marketFixture[0]!, status: 'draft' }
function harness() {
  const catalog = vi.fn(async () => [draft])
  const review = vi.fn(async (): Promise<MarketRelease> => ({ ...draft, status: 'pending', revision: 2 }))
  const unavailable = async (): Promise<never> => { throw new Error('not-used') }
  const actions: MarketSectionProps['actions'] = { catalog, review, installed: async () => [], sources: unavailable,
    identity: unavailable, install: unavailable, enable: unavailable, remove: unavailable, prepare: unavailable,
    importPackage: unavailable, exportPackage: unavailable, publishDraft: unavailable }
  const props = { actions,
    publishers: [{ id: draft.publisherId, title: draft.publisher }], admin: false, refreshKey: 0,
    reportOutcome: vi.fn(), onDetails: vi.fn(), onDownload: vi.fn(), localBusy: false, t: (key: string) => key }
  return { catalog, review, props }
}

it('submits the shown revision only after explicit confirmation and keeps pending distinct from published', async () => {
  const h = harness(), response = Promise.withResolvers<MarketRelease>()
  h.review.mockReturnValueOnce(response.promise)
  render(<MarketPublications {...h.props} />)
  await screen.findByText('publication.draft')
  expect(h.catalog).toHaveBeenCalledWith('', '', true)
  fireEvent.click(screen.getByRole('button', { name: 'review.submit' }))
  expect(h.review).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: 'confirmReview' }))
  expect(screen.getByText('publication.draft')).toBeDefined()
  expect(h.review).toHaveBeenCalledWith(draft.id, 1, 'submit', '')
  await act(async () => { response.resolve({ ...draft, status: 'pending', revision: 2 }) })
  expect(screen.getByText('publication.pending')).toBeDefined()
  expect(screen.queryByText('publication.published')).toBeNull()
  expect(h.props.reportOutcome).toHaveBeenCalledWith('reviewDone', false)
})

it('shows author actions only for admitted teams and review actions only for administrators', async () => {
  const h = harness(); h.catalog.mockResolvedValue([{ ...draft, status: 'pending' }])
  const view = render(<MarketPublications {...h.props} publishers={[]} />)
  await screen.findByText('publication.pending')
  expect(screen.queryByRole('button', { name: 'review.approve' })).toBeNull()
  view.rerender(<MarketPublications {...h.props} admin />)
  fireEvent.click(screen.getByRole('button', { name: 'review.reject' }))
  const dialog = screen.getByRole('dialog')
  expect(within(dialog).getByRole('button', { name: 'confirmReview' }).hasAttribute('disabled')).toBe(true)
  fireEvent.change(within(dialog).getByRole('textbox', { name: 'reviewNote' }), { target: { value: '  Missing example  ' } })
  fireEvent.click(within(dialog).getByRole('button', { name: 'confirmReview' }))
  await waitFor(() => { expect(h.review).toHaveBeenCalledWith(draft.id, 1, 'reject', 'Missing example') })
})

it('refreshes on a generic cloud conflict without guessing a revision error or retrying the transition', async () => {
  const h = harness(); h.review.mockRejectedValue(Error('cloud-conflict'))
  render(<MarketPublications {...h.props} />)
  await screen.findByText('publication.draft')
  h.catalog.mockResolvedValue([{ ...draft, status: 'published', revision: 4 }])
  fireEvent.click(screen.getByRole('button', { name: 'review.submit' }))
  fireEvent.click(screen.getByRole('button', { name: 'confirmReview' }))
  await screen.findByText('publication.published')
  expect(h.review).toHaveBeenCalledTimes(1)
  expect(screen.queryByRole('dialog')).toBeNull()
  expect(h.props.reportOutcome).toHaveBeenLastCalledWith('error.cloud-conflict', true)
  expect(screen.getByRole('button', { name: 'review.withdraw' })).toBeDefined()
})

it('retains cloud releases after a failed refresh and hides raw failure details', async () => {
  const h = harness(); render(<MarketPublications {...h.props} />)
  await screen.findByText('publication.draft')
  h.catalog.mockRejectedValue(Error('private upstream account response'))
  fireEvent.click(screen.getByRole('button', { name: 'refresh' }))
  await screen.findByRole('alert')
  expect(screen.getByText('publication.draft')).toBeDefined()
  expect(screen.queryByText('private upstream account response')).toBeNull()
  expect(h.props.reportOutcome).not.toHaveBeenCalled()
})

it('ignores a stale cloud list after replacing the Host adapter', async () => {
  const h = harness(), other = harness(), response = Promise.withResolvers<MarketRelease[]>()
  h.catalog.mockReturnValue(response.promise)
  other.catalog.mockResolvedValue([{ ...draft, status: 'withdrawn' }])
  const view = render(<MarketPublications {...h.props} />)
  view.rerender(<MarketPublications {...other.props} />)
  await screen.findByText('publication.withdrawn')
  await act(async () => { response.resolve([draft]) })
  expect(screen.queryByText('publication.draft')).toBeNull()
})

it('records the five cloud statuses and administrator controls in both locales', async () => {
  const output = []
  for (const copy of [marketZh, marketEn]) {
    const h = harness()
    h.catalog.mockResolvedValue((['draft', 'pending', 'published', 'rejected', 'withdrawn'] as const).map((status, index) => ({
      ...draft, id: String(index + 1).repeat(32) as MarketRelease['id'], status,
    })))
    render(<MarketPublications {...h.props} admin t={key => Object.hasOwn(copy, key) ? copy[key as MarketLocaleKey] : key} />)
    await screen.findByText(copy['publication.withdrawn'])
    output.push(screen.getAllByRole('article').map((article, index) => ({
      status: within(article).getByText(copy[`publication.${(['draft', 'pending', 'published', 'rejected', 'withdrawn'] as const)[index]!}`]).textContent,
      actions: within(article).getAllByRole('button').filter(button => button.getAttribute('aria-label') !== copy.introduce && button.textContent !== copy.introduce).map(button => button.textContent),
    })))
    cleanup()
  }
  await expect(`${JSON.stringify(output, null, 2)}\n`).toMatchFileSnapshot(resolve('packages/client/ui-muse-account/tests/expected/publications.txt'))
})
