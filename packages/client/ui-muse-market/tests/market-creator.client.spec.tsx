// @vitest-environment jsdom
/** Creator controls retain draft data and original upload identities across failed operations. */
import { useSyncExternalStore, type ComponentProps } from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { parseMarketAccountId, parseMarketUploadRequestId } from '@deepseek-ai/dsh-muse-market/cloud-values'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import { MarketCreatorPage } from '../src/client/MarketCreatorPage.tsx'
import { createMarketViewStore, type MarketCreatorDraft } from '../src/client/market-view-store.ts'
import { marketEn } from '../src/client/market-locales.ts'
import { identity, installation, marketActions, marketTranslate, metadata, publication, sources } from './market-fixtures.client.ts'

afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals() })

function mount(options: Partial<ComponentProps<typeof MarketCreatorPage>> = {}, draft: Partial<MarketCreatorDraft> = {}) {
  const store = createMarketViewStore().create()
  store.actions.setCreator({ ...store.getSnapshot().creator, metadata, ...draft })
  const props = {
    actions: marketActions(), sources, identity, installed: [installation],
    onPrepared: vi.fn(), onPublished: vi.fn(), reportOutcome: vi.fn(), t: marketTranslate,
    ...options,
  }
  const subscribe = store.subscribe.bind(store), getSnapshot = store.getSnapshot.bind(store)
  function Creator() {
    const current = useSyncExternalStore(subscribe, getSnapshot)
    return <MarketCreatorPage {...props} draft={current.creator} setDraft={store.actions.setCreator}
      prepared={store.actions.prepared} completeUpload={store.actions.completeUpload} discardUpload={store.actions.discardUpload} />
  }
  return { ...render(<Creator />), store, props }
}

const ready = { source: 'writer', selectedId: installation.release.id, publisher: identity.publishers[0]!.id }
const submit = () => {
  const button = screen.getByRole('button', { name: marketEn.prepare })
  const form = button.closest('form')
  if (!form) throw new Error('Creator form was not rendered')
  fireEvent.submit(form)
}

it('edits metadata and selections, filters empty lines, and selects the prepared local release', async () => {
  const pending = Promise.withResolvers<typeof installation>(), prepare = vi.fn(() => pending.promise)
  const page = mount({ actions: marketActions({ prepare }), sources: { ...sources, complete: false } })
  expect(screen.getByText(marketEn.sourcesIncomplete)).toBeTruthy()
  expect(screen.getByRole('button', { name: marketEn.prepare })).toHaveProperty('disabled', true)
  submit()
  expect(prepare).not.toHaveBeenCalled()
  fireEvent.change(screen.getByLabelText(marketEn.source), { target: { value: 'writer' } })
  for (const field of ['name', 'title', 'description', 'version', 'license', 'category'] as const) {
    fireEvent.change(screen.getByLabelText(marketEn[`field.${field}`]), { target: { value: `${field}-edited` } })
  }
  for (const field of ['requirements', 'examples'] as const) {
    fireEvent.change(screen.getByLabelText(marketEn[`field.${field}`]), { target: { value: `\n${field}-edited\n   ` } })
  }
  fireEvent.change(screen.getByLabelText(marketEn.chooseLocal), { target: { value: installation.release.id } })
  fireEvent.change(screen.getByLabelText(marketEn.publisher), { target: { value: identity.publishers[0]!.id } })
  fireEvent.change(screen.getByLabelText(marketEn.chooseLocal), { target: { value: '' } })
  expect(page.store.getSnapshot().creator.selectedId).toBeNull()
  submit(); submit()
  expect(prepare).toHaveBeenCalledExactlyOnceWith({ name: 'name-edited', title: 'title-edited', description: 'description-edited',
    version: 'version-edited', license: 'license-edited', category: 'category-edited',
    requirements: ['requirements-edited'], examples: ['examples-edited'] }, 'writer')
  await act(async () => { pending.resolve(installation); await pending.promise })
  expect(page.props.onPrepared).toHaveBeenCalledExactlyOnceWith(installation)
  expect(page.store.getSnapshot().creator.selectedId).toBe(installation.release.id)
  expect(page.props.reportOutcome).toHaveBeenCalledExactlyOnceWith('done', false)
})

it.each([false, true])('reports preparation failure with an unmounted page=%s', async (unmount) => {
  const pending = Promise.withResolvers<typeof installation>()
  const page = mount({ actions: marketActions({ prepare: () => pending.promise }) }, { source: 'writer' })
  submit()
  if (unmount) page.unmount()
  await act(async () => { pending.reject(new RemoteError('muse-market/operation-failed', 'Invalid', { code: 'invalid-archive' })); await pending.promise.catch(() => undefined) })
  expect(page.props.reportOutcome).toHaveBeenCalledExactlyOnceWith('invalidPackage', true)
  expect(page.props.onPrepared).not.toHaveBeenCalled()
})

it('downloads the selected archive without changing its bytes', async () => {
  const create = vi.fn((_object: Blob | MediaSource) => 'blob:market-export'), revoke = vi.fn()
  vi.stubGlobal('URL', class extends URL { static override createObjectURL = create; static override revokeObjectURL = revoke })
  const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
  const exportPackage = vi.fn(async () => ({ name: 'writer.zip', base64: 'AAEC/w==' }))
  const page = mount({ actions: marketActions({ exportPackage }) }, ready)
  fireEvent.click(screen.getByRole('button', { name: marketEn.export }))
  await waitFor(() => { expect(page.props.reportOutcome).toHaveBeenCalledWith('done', false) })
  expect(exportPackage).toHaveBeenCalledExactlyOnceWith(installation.release.id)
  expect(create.mock.calls[0]?.[0]).toBeInstanceOf(Blob)
  const blob = create.mock.calls[0]?.[0]
  if (!(blob instanceof Blob)) throw new Error('Export did not create a Blob')
  const bytes = await new Promise<ArrayBuffer>((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => { resolve(reader.result as ArrayBuffer) }
    reader.onerror = () => { reject(new Error(reader.error?.message ?? 'Reading exported Blob failed', { cause: reader.error })) }
    reader.readAsArrayBuffer(blob)
  })
  expect([...new Uint8Array(bytes)]).toEqual([0, 1, 2, 255])
  expect(click.mock.instances[0]).toMatchObject({ download: 'writer.zip', href: 'blob:market-export' })
  await waitFor(() => { expect(revoke).toHaveBeenCalledExactlyOnceWith('blob:market-export') })
})

it.each([false, true])('reports export failure with an unmounted page=%s', async (unmount) => {
  const pending = Promise.withResolvers<{ name: string; base64: string }>()
  const page = mount({ actions: marketActions({ exportPackage: () => pending.promise }) }, ready)
  fireEvent.click(screen.getByRole('button', { name: marketEn.export }))
  if (unmount) page.unmount()
  await act(async () => { pending.reject(new Error('Unavailable')); await pending.promise.catch(() => undefined) })
  expect(page.props.reportOutcome).toHaveBeenCalledExactlyOnceWith('cloudUnavailable', true)
})

it('retains an unsuccessful upload identity and reuses it for the explicit retry', async () => {
  const publishDraft = vi.fn().mockRejectedValueOnce(new Error('Connection lost')).mockResolvedValue(publication)
  const page = mount({ actions: marketActions({ publishDraft }) }, ready)
  fireEvent.click(screen.getByRole('button', { name: marketEn.upload }))
  await waitFor(() => { expect(page.props.reportOutcome).toHaveBeenCalledWith('cloudUnavailable', true) })
  const attempt = page.store.getSnapshot().creator.uploadRequest
  expect(attempt).toMatchObject({ releaseId: installation.release.id, publisherId: ready.publisher, accountId: identity.accountId })
  expect(screen.getByLabelText(marketEn.source)).toHaveProperty('disabled', true)
  submit()
  fireEvent.click(screen.getByRole('button', { name: marketEn.retryUpload }))
  await waitFor(() => { expect(page.props.onPublished).toHaveBeenCalledOnce() })
  expect(publishDraft.mock.calls).toEqual([[installation.release.id, ready.publisher, attempt?.key],
    [installation.release.id, ready.publisher, attempt?.key]])
  expect(page.store.getSnapshot().creator.uploadRequest).toBeNull()
  expect(page.props.reportOutcome).toHaveBeenLastCalledWith('draftDone', false)
})

it('finishes an upload after unmount without navigating the closed page', async () => {
  const pending = Promise.withResolvers<typeof publication>()
  const page = mount({ actions: marketActions({ publishDraft: () => pending.promise }) }, ready)
  fireEvent.click(screen.getByRole('button', { name: marketEn.upload }))
  page.unmount()
  await act(async () => { pending.resolve(publication); await pending.promise })
  expect(page.props.onPublished).not.toHaveBeenCalled()
  expect(page.store.getSnapshot().creator.uploadRequest).toBeNull()
  expect(page.props.reportOutcome).toHaveBeenCalledWith('draftDone', false)
})

it('requires confirmation to discard an attempt from another account without changing the author draft', () => {
  const attempt = { key: parseMarketUploadRequestId('retained-upload'), releaseId: installation.release.id,
    publisherId: ready.publisher, accountId: parseMarketAccountId('e'.repeat(16)) }
  const publishDraft = vi.fn()
  const page = mount({ actions: marketActions({ publishDraft }) }, { ...ready, uploadRequest: attempt })
  expect(screen.getByRole('button', { name: marketEn.retryUpload })).toHaveProperty('disabled', true)
  fireEvent.click(screen.getByRole('button', { name: marketEn.retryUpload }))
  expect(publishDraft).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: marketEn.discardUpload }))
  let dialog = screen.getByRole('dialog', { name: marketEn.discardUpload })
  fireEvent.click(within(dialog).getByRole('button', { name: marketEn.close }))
  expect(page.store.getSnapshot().creator.uploadRequest).toEqual(attempt)
  fireEvent.click(screen.getByRole('button', { name: marketEn.discardUpload }))
  dialog = screen.getByRole('dialog', { name: marketEn.discardUpload })
  fireEvent.click(within(dialog).getByRole('button', { name: marketEn.confirm }))
  expect(page.store.getSnapshot().creator).toMatchObject({ ...ready, metadata, uploadRequest: null })
  expect(screen.queryByRole('dialog')).toBeNull()
})

it('leaves a completed upload intact if it settles while the discard confirmation is open', async () => {
  const pending = Promise.withResolvers<typeof publication>()
  const page = mount({ actions: marketActions({ publishDraft: () => pending.promise }) }, ready)
  fireEvent.click(screen.getByRole('button', { name: marketEn.upload }))
  fireEvent.click(screen.getByRole('button', { name: marketEn.discardUpload }))
  const dialog = screen.getByRole('dialog', { name: marketEn.discardUpload })
  await act(async () => { pending.resolve(publication); await pending.promise })
  const completed = page.store.getSnapshot().creator
  expect(completed.uploadRequest).toBeNull()
  fireEvent.click(within(dialog).getByRole('button', { name: marketEn.confirm }))
  expect(page.store.getSnapshot().creator).toBe(completed)
  expect(screen.queryByRole('dialog')).toBeNull()
})

it.each([undefined, { ...identity, publishers: [] }])('keeps local management available without a publisher', (account) => {
  const publishDraft = vi.fn()
  mount({ identity: account, actions: marketActions({ publishDraft }) }, ready)
  expect(screen.getByText(marketEn.noPublisher)).toBeTruthy()
  expect(screen.getByRole('button', { name: marketEn.upload })).toHaveProperty('disabled', true)
  expect(screen.getByRole('button', { name: marketEn.export })).toHaveProperty('disabled', false)
  fireEvent.click(screen.getByRole('button', { name: marketEn.upload }))
  expect(publishDraft).not.toHaveBeenCalled()
})

it('does not upload without a selected local release or matching publisher', () => {
  const publishDraft = vi.fn()
  const first = mount({ actions: marketActions({ publishDraft }) }, { ...ready, selectedId: null })
  expect(screen.queryByRole('button', { name: marketEn.upload })).toBeNull()
  first.unmount()
  mount({ actions: marketActions({ publishDraft }) }, { ...ready, publisher: 'unavailable-team' })
  fireEvent.click(screen.getByRole('button', { name: marketEn.upload }))
  expect(publishDraft).not.toHaveBeenCalled()
})

it('does not start another upload or export while an upload is pending', async () => {
  const pending = Promise.withResolvers<typeof publication>(), publishDraft = vi.fn(() => pending.promise), exportPackage = vi.fn()
  mount({ actions: marketActions({ publishDraft, exportPackage }) }, ready)
  fireEvent.click(screen.getByRole('button', { name: marketEn.upload }))
  fireEvent.click(screen.getByRole('button', { name: marketEn.retryUpload }))
  fireEvent.click(screen.getByRole('button', { name: marketEn.export }))
  expect(publishDraft).toHaveBeenCalledOnce()
  expect(exportPackage).not.toHaveBeenCalled()
  await act(async () => { pending.resolve(publication); await pending.promise })
})
