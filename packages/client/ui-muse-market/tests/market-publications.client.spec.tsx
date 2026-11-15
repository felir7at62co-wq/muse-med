// @vitest-environment jsdom
/** Publication review stays tied to the selected revision and current account authority. */
import type { ComponentProps } from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { parseMarketPublicationId, parseMarketPublisherId } from '@deepseek-ai/dsh-muse-market/cloud-values'
import { MarketPublications } from '../src/client/MarketPublications.tsx'
import { marketEn } from '../src/client/market-locales.ts'
import { identity, marketActions, marketTranslate, publication } from './market-fixtures.client.ts'

afterEach(cleanup)

function mount(options: Partial<ComponentProps<typeof MarketPublications>> = {}) {
  const props = { accessRevision: 4, isCurrentAccess: vi.fn(() => true), items: [publication], identity,
    actions: marketActions(), busy: false, onReplace: vi.fn(), onDetails: vi.fn(), onInstall: vi.fn(),
    reportOutcome: vi.fn(), t: marketTranslate, ...options }
  return { ...render(<MarketPublications {...props} />), props }
}

function choose(action: 'submit' | 'approve' | 'reject' | 'withdraw') {
  fireEvent.click(screen.getByRole('button', { name: marketEn[`review.${action}`] }))
  return screen.getByRole('dialog', { name: marketEn[`review.${action}`] })
}

function confirm(dialog: HTMLElement) {
  const form = within(dialog).getByRole('button', { name: marketEn.confirm }).closest('form')
  if (!form) throw new Error('Review confirmation form was not rendered')
  fireEvent.submit(form)
}

it('shows owner actions by status and keeps other publishers read-only', () => {
  const statuses = ['draft', 'rejected', 'pending', 'published', 'withdrawn'] as const
  const items = statuses.map((status, index) => ({ ...publication, status,
    id: parseMarketPublicationId(String(index + 1).repeat(32)),
    manifest: { ...publication.manifest, title: status }, reviewNote: status === 'rejected' ? 'Add an example' : '' }))
  const page = mount({ items })
  expect(screen.getAllByRole('button', { name: marketEn['review.submit'] })).toHaveLength(2)
  expect(screen.getAllByRole('button', { name: marketEn['review.withdraw'] })).toHaveLength(1)
  expect(screen.queryByRole('button', { name: marketEn['review.approve'] })).toBeNull()
  expect(screen.queryByRole('button', { name: marketEn['review.reject'] })).toBeNull()
  expect(screen.getByText('Add an example')).toBeTruthy()
  const card = screen.getByRole('heading', { name: 'draft' }).closest('article')
  if (!card) throw new Error('Draft publication was not rendered')
  fireEvent.click(within(card).getByRole('button', { name: marketEn.details }))
  fireEvent.click(within(card).getByRole('button', { name: marketEn.install }))
  expect(page.props.onDetails).toHaveBeenCalledExactlyOnceWith(items[0])
  expect(page.props.onInstall).toHaveBeenCalledExactlyOnceWith(items[0])
  page.rerender(<MarketPublications {...page.props} identity={{ ...identity, publishers: [{ id: parseMarketPublisherId('e'.repeat(32)), title: 'Other team' }] }} busy />)
  expect(screen.queryByRole('button', { name: marketEn['review.submit'] })).toBeNull()
  expect(screen.queryByRole('button', { name: marketEn['review.withdraw'] })).toBeNull()
  expect(screen.getAllByRole('button', { name: marketEn.install }).every(button => (button as HTMLButtonElement).disabled)).toBe(true)
})

it.each(['submit', 'approve', 'reject', 'withdraw'] as const)('confirms %s once against the original revision', async (action) => {
  const pending = Promise.withResolvers<typeof publication>(), review = vi.fn(() => pending.promise)
  const status = action === 'submit' ? 'draft' : action === 'withdraw' ? 'published' : 'pending'
  const original = { ...publication, status } as const
  const page = mount({ items: [original], identity: { ...identity, admin: true }, actions: marketActions({ review }) })
  let dialog = choose(action)
  fireEvent.click(within(dialog).getByRole('button', { name: marketEn.close }))
  expect(screen.queryByRole('dialog')).toBeNull()
  dialog = choose(action)
  if (action === 'approve') expect(within(dialog).getByText(marketEn.reviewPackageFirst)).toBeTruthy()
  if (action === 'reject') {
    expect(within(dialog).getByRole('button', { name: marketEn.confirm })).toHaveProperty('disabled', true)
    fireEvent.change(within(dialog).getByLabelText(marketEn.reviewNote), { target: { value: '  Please add an example  ' } })
  }
  confirm(dialog); confirm(dialog)
  expect(review).toHaveBeenCalledExactlyOnceWith(original.id, original.revision, action, action === 'reject' ? 'Please add an example' : '')
  fireEvent.click(within(dialog).getByRole('button', { name: marketEn.close }))
  expect(screen.getByRole('dialog')).toBe(dialog)
  expect(screen.getByRole('button', { name: marketEn.install })).toHaveProperty('disabled', true)
  const returned = { ...original, revision: 3 }
  await act(async () => { pending.resolve(returned); await pending.promise })
  expect(page.props.onReplace).toHaveBeenCalledExactlyOnceWith(returned)
  expect(page.props.reportOutcome).toHaveBeenCalledExactlyOnceWith('reviewDone', false)
  expect(screen.queryByRole('dialog')).toBeNull()
})

it('does not submit after account authority has already changed', () => {
  const review = vi.fn(), page = mount({ isCurrentAccess: () => false, actions: marketActions({ review }) })
  confirm(choose('submit'))
  expect(review).not.toHaveBeenCalled()
  expect(page.props.onReplace).not.toHaveBeenCalled()
  expect(page.props.reportOutcome).not.toHaveBeenCalled()
})

it.each([false, true])('ignores a late review %s after authority is revoked', async (reject) => {
  let current = true
  const pending = Promise.withResolvers<typeof publication>(), getPublication = vi.fn()
  const page = mount({ isCurrentAccess: () => current, actions: marketActions({ review: () => pending.promise, getPublication }) })
  confirm(choose('submit'))
  current = false
  await act(async () => {
    if (reject) pending.reject(new Error('Reply lost'))
    else pending.resolve({ ...publication, revision: 3 })
    await pending.promise.catch(() => undefined)
  })
  expect(page.props.onReplace).not.toHaveBeenCalled()
  expect(page.props.reportOutcome).not.toHaveBeenCalled()
  expect(getPublication).not.toHaveBeenCalled()
})

it('does not read back a request explicitly refused after an account change', async () => {
  const getPublication = vi.fn(), page = mount({ actions: marketActions({
    review: async () => { throw { code: 'muse-market/access-changed' } }, getPublication,
  }) })
  confirm(choose('submit'))
  await waitFor(() => { expect(within(screen.getByRole('dialog')).getByRole('button', { name: marketEn.confirm })).toHaveProperty('disabled', false) })
  expect(getPublication).not.toHaveBeenCalled()
  expect(page.props.reportOutcome).not.toHaveBeenCalled()
})

it.each([null, 'Reply lost', { code: 'transport/offline' }, new Error('Disconnected')])('reads back the original publication after an uncertain error %#', async (error) => {
  const observed = { ...publication, status: 'pending' } as const, getPublication = vi.fn(async () => observed)
  const page = mount({ actions: marketActions({ review: async () => { throw error }, getPublication }) })
  confirm(choose('submit'))
  await waitFor(() => { expect(page.props.reportOutcome).toHaveBeenCalledExactlyOnceWith('reviewUnconfirmed', true) })
  expect(getPublication).toHaveBeenCalledExactlyOnceWith(publication.id)
  expect(page.props.onReplace).toHaveBeenCalledExactlyOnceWith(observed)
  expect(screen.queryByRole('dialog')).toBeNull()
})

it('retains the existing row when readback also fails', async () => {
  const page = mount({ actions: marketActions({ review: async () => { throw new Error('Reply lost') },
    getPublication: async () => { throw new Error('Offline') } }) })
  confirm(choose('submit'))
  await waitFor(() => { expect(page.props.reportOutcome).toHaveBeenCalledWith('reviewUnconfirmed', true) })
  expect(page.props.onReplace).not.toHaveBeenCalled()
  expect(screen.getByRole('heading', { name: publication.manifest.title })).toBeTruthy()
})

it('suppresses readback and feedback if account authority changes during readback', async () => {
  let current = true
  const pending = Promise.withResolvers<typeof publication>(), getPublication = vi.fn(() => pending.promise)
  const page = mount({ isCurrentAccess: () => current, actions: marketActions({
    review: async () => { throw new Error('Reply lost') }, getPublication,
  }) })
  confirm(choose('submit'))
  await waitFor(() => { expect(getPublication).toHaveBeenCalledOnce() })
  current = false
  await act(async () => { pending.resolve(publication); await pending.promise })
  expect(page.props.onReplace).not.toHaveBeenCalled()
  expect(page.props.reportOutcome).not.toHaveBeenCalled()
})
