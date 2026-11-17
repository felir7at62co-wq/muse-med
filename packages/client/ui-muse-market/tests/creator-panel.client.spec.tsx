// @vitest-environment jsdom
/** Dedicated creator reads fail independently while the original draft and ZIP workflow remain available. */
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, onTestFinished, vi } from 'vitest'
import { bindSnapshotSelector } from '@deepseek-ai/dsh-client-test-runtime'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { GlobalStandardProps } from '@deepseek-ai/dsh-client-ui-slots'
import { MarketCreatorPanel } from '../src/client/MarketCreatorPanel.tsx'
import { createMarketViewStore } from '../src/client/market-view-store.ts'
import { marketEn } from '../src/client/market-locales.ts'
import type { MarketActions, MarketTranslate } from '../src/client/market-actions.ts'
import { MarketController, type MarketAccess } from '../src/client/market-controller.ts'
import { installation, operations } from './discovery-fixtures.client.ts'

afterEach(cleanup)
const messages: Readonly<Record<string, string>> = marketEn
const translate: MarketTranslate = key => messages[key] ?? key

function mount(operations: MarketActions, mode: 'skill' | 'upload' = 'upload', controller?: MarketController) {
  const store = createMarketViewStore().create()
  store.actions.setCreatorMode(mode)
  const access = createSnapshotStore<MarketAccess>({ revision: 0 })
  const onBackMarket = vi.fn()
  const view = render(<MarketCreatorPanel {...({} as GlobalStandardProps)} operations={operations} useStore={bindSnapshotSelector(store)}
    useAccess={bindSnapshotSelector(controller?.access ?? access)} actions={store.actions}
    isCurrentAccess={revision => controller?.isCurrentAccess(revision) ?? true}
    reportOutcome={() => {}} onBackMarket={onBackMarket} onOpenCreator={() => {}} onOpenPublications={() => {}}
    t={translate} />)
  return { ...view, store, onBackMarket }
}

it('opens the requested ZIP mode and retries only failed local sources', async () => {
  const sources = vi.fn<MarketActions['sources']>().mockRejectedValueOnce(new Error('Source offline'))
    .mockResolvedValue({ complete: true, skills: [{ name: 'storyboard-review', description: 'Review shots' }] })
  const installed = vi.fn<MarketActions['installed']>().mockResolvedValue([])
  const identity = vi.fn<MarketActions['identity']>().mockRejectedValue(new Error('Signed out'))
  const view = mount(operations({ sources, installed, identity }))
  await screen.findByText(marketEn.creatorSourcesFailed)
  expect(screen.getByRole('button', { name: marketEn.creatorUploadZip }).getAttribute('aria-pressed')).toBe('true')
  expect(view.container.querySelector<HTMLInputElement>('input[type="file"]')?.disabled).toBe(false)
  fireEvent.click(screen.getByRole('button', { name: marketEn.creatorRetrySources }))
  await waitFor(() => { expect(screen.queryByText(marketEn.creatorSourcesFailed)).toBeNull() })
  expect(sources).toHaveBeenCalledTimes(2)
  expect(installed).toHaveBeenCalledOnce()
  expect(identity).toHaveBeenCalledOnce()
  fireEvent.click(screen.getByRole('button', { name: marketEn.creatorBack }))
  expect(view.onBackMarket).toHaveBeenCalledOnce()
})

it('retains a newly prepared ZIP when the initial inventory read resolves later', async () => {
  const priorInventory = Promise.withResolvers<Awaited<ReturnType<MarketActions['installed']>>>()
  onTestFinished(() => { priorInventory.resolve([]) })
  const imported = installation()
  const prepareUpload = vi.fn<MarketActions['prepareUpload']>().mockResolvedValue(imported)
  const view = mount(operations({ installed: () => priorInventory.promise, importPackage: async () => imported, prepareUpload }))
  const file = new File(['zip'], 'review.zip', { type: 'application/zip' })
  Object.defineProperty(file, 'arrayBuffer', { value: async () => new TextEncoder().encode('zip').buffer })
  const input = view.container.querySelector<HTMLInputElement>('input[type="file"]')
  if (!input) throw new Error('ZIP input missing')
  fireEvent.change(input, { target: { files: [file] } })
  await screen.findByText(marketEn.creatorPreparedTitle)
  expect(prepareUpload).toHaveBeenCalledOnce()
  await act(async () => { priorInventory.resolve([]); await priorInventory.promise })
  expect(view.store.getSnapshot().creator.selectedId).toBe(imported.release.id)
  expect(screen.getByText(marketEn.creatorPreparedTitle)).toBeTruthy()
})

it('opens the requested creation mode without a cloud account', async () => {
  const view = mount(operations(), 'skill')
  await screen.findByText(marketEn.creatorIdentityFailed)
  expect(screen.getByRole('button', { name: marketEn.creatorNewSkill }).getAttribute('aria-pressed')).toBe('true')
  expect(screen.getByRole('button', { name: marketEn.prepare })).toBeTruthy()
  expect(view.store.getSnapshot().creatorMode).toBe('skill')
})

it('settles a rejected identity after one access-revocation refresh', async () => {
  const identity = vi.fn<MarketActions['identity']>().mockRejectedValue(new Error('Signed out'))
  const controller = new MarketController(operations({ identity }))
  onTestFinished(() => { controller.dispose() })
  mount(controller.operations, 'upload', controller)
  await screen.findByText(marketEn.creatorIdentityFailed)
  expect(identity).toHaveBeenCalledTimes(2)
  expect(screen.queryByRole('status', { name: marketEn.loading })).toBeNull()
  expect(screen.getByRole('button', { name: marketEn.creatorUploadZip }).hasAttribute('disabled')).toBe(false)
})

it('refreshes all reads and replaces a stored version with the verified imported result', async () => {
  const imported = installation(), sources = vi.fn<MarketActions['sources']>().mockResolvedValue({ skills: [], complete: true })
  const installed = vi.fn<MarketActions['installed']>().mockResolvedValue([imported])
  const identity = vi.fn<MarketActions['identity']>().mockRejectedValue(new Error('Signed out'))
  const view = mount(operations({ sources, installed, identity, importPackage: async () => imported,
    prepareUpload: async () => imported }))
  await screen.findByText(marketEn.creatorNoSkills)
  fireEvent.click(screen.getByRole('button', { name: marketEn.refresh }))
  await waitFor(() => { expect(installed).toHaveBeenCalledTimes(2) })
  expect(sources).toHaveBeenCalledTimes(2)
  expect(identity).toHaveBeenCalledTimes(2)
  const file = new File(['zip'], 'review.zip')
  Object.defineProperty(file, 'arrayBuffer', { value: async () => Uint8Array.of(80, 75).buffer })
  fireEvent.change(view.container.querySelector('input[type=file]')!, { target: { files: [file] } })
  await screen.findByText(marketEn.creatorPreparedTitle)
  expect(view.store.getSnapshot().creator.selectedId).toBe(imported.release.id)
})

it('does not change a creator inventory after its page has closed', async () => {
  const pending = Promise.withResolvers<Awaited<ReturnType<MarketActions['importPackage']>>>()
  const item = installation(), view = mount(operations({ importPackage: () => pending.promise, prepareUpload: async () => item }))
  const file = new File(['zip'], 'review.zip')
  Object.defineProperty(file, 'arrayBuffer', { value: async () => Uint8Array.of(80, 75).buffer })
  fireEvent.change(view.container.querySelector('input[type=file]')!, { target: { files: [file] } })
  view.unmount()
  await act(async () => { pending.resolve(item); await pending.promise })
  expect(view.container.childElementCount).toBe(0)
})
