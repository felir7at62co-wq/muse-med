// @vitest-environment jsdom
/** Market navigation preserves local operations and fences asynchronous catalog refreshes. */
import { File as NodeFile } from 'node:buffer'
import { useSyncExternalStore } from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { GlobalStandardProps } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import { brandString } from '@deepseek-ai/dsh-brand'
import { parseMarketPublicationId } from '@deepseek-ai/dsh-muse-market/cloud-values'
import type { MarketActions, MarketDefaultSnapshot } from '../src/client/market-actions.ts'
import type { MarketAccess } from '../src/client/market-controller.ts'
import { MarketPage } from '../src/client/MarketSection.tsx'
import { createMarketViewStore } from '../src/client/market-view-store.ts'
import { marketEn } from '../src/client/market-locales.ts'
import { identity, installation, marketActions, marketTranslate, publication, sources } from './market-fixtures.client.ts'

afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals() })

const published = { ...publication, status: 'published' } as const
const emptyDefaults: MarketDefaultSnapshot = { revision: 0, defaults: [] }
function mount(overrides: Partial<MarketActions> = {}, initialAccess: MarketAccess = { revision: 1, identity }) {
  let access = initialAccess
  const listeners = new Set<() => void>()
  const source = { getSnapshot: () => access, subscribe: (listener: () => void) => {
    listeners.add(listener); return () => { listeners.delete(listener) }
  } }
  const actions = marketActions({ installed: async () => [installation], defaults: async () => emptyDefaults,
    sources: async () => sources, catalog: async () => [published], identity: async () => identity, ...overrides })
  const store = createMarketViewStore().create(), reportOutcome = vi.fn()
  const subscribe = store.subscribe.bind(store), getSnapshot = store.getSnapshot.bind(store)
  function Harness() {
    const current = useSyncExternalStore(source.subscribe, source.getSnapshot)
    const view = useSyncExternalStore(subscribe, getSnapshot)
    return <MarketPage {...({} as GlobalStandardProps)} operations={actions} reportOutcome={reportOutcome}
      isCurrentAccess={revision => revision === access.revision} useAccess={selector => selector(current)}
      useStore={selector => selector(view)} actions={store.actions} t={marketTranslate} />
  }
  return { ...render(<Harness />), actions, store, reportOutcome,
    setAccess(next: MarketAccess) { access = next; for (const listener of listeners) listener() } }
}

async function ready() {
  await waitFor(() => { expect(screen.queryByRole('status', { name: marketEn.loading })).toBeNull() })
}
async function tab(name: 'installed' | 'publish') {
  fireEvent.click(screen.getByRole('tab', { name: marketEn[name] }))
  await ready()
}
function card() {
  const heading = screen.getByRole('heading', { name: installation.release.manifest.title })
  const article = heading.closest('article')
  if (!article) throw new Error('Market card was not rendered')
  return article
}

it('searches and filters public releases and shows the original detail fields', async () => {
  const other = { ...published, id: parseMarketPublicationId('e'.repeat(32)),
    manifest: { ...published.manifest, title: 'Audio', category: 'audio' } }
  const catalog = vi.fn(async () => [published, other])
  mount({ catalog })
  await screen.findByRole('heading', { name: 'Audio' })
  fireEvent.click(screen.getByRole('button', { name: 'audio' }))
  expect(screen.queryByRole('heading', { name: 'Writer' })).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: marketEn.allCategories }))
  const query = screen.getByRole('searchbox', { name: marketEn.query })
  fireEvent.change(query, { target: { value: 'scene' } })
  const form = query.closest('form')
  if (!form) throw new Error('Search form was not rendered')
  fireEvent.submit(form)
  await waitFor(() => { expect(catalog).toHaveBeenLastCalledWith('scene', false) })
  await ready()
  fireEvent.click(within(card()).getByRole('button', { name: marketEn.details }))
  const dialog = screen.getByRole('dialog', { name: 'Writer' })
  expect(within(dialog).getByText('A script')).toBeTruthy()
  expect(within(dialog).getByText('A short scene')).toBeTruthy()
  expect(within(dialog).getByText(installation.release.sha256)).toBeTruthy()
  fireEvent.click(within(dialog).getByRole('button', { name: marketEn.close }))
  expect(screen.queryByRole('dialog')).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: marketEn.refresh }))
  await waitFor(() => { expect(catalog).toHaveBeenCalledTimes(3) })
})

it('confirms a default against its displayed revision and can disable it from installed packages', async () => {
  const setDefault = vi.fn<MarketActions['setDefault']>().mockResolvedValueOnce({ revision: 1,
    defaults: [{ skillName: 'writer', releaseId: installation.release.id }] }).mockResolvedValue(emptyDefaults)
  const defaults = vi.fn<MarketActions['defaults']>().mockResolvedValueOnce(emptyDefaults).mockResolvedValue({ revision: 1,
    defaults: [{ skillName: 'writer', releaseId: installation.release.id }] })
  const page = mount({ setDefault, defaults })
  await screen.findByRole('heading', { name: 'Writer' })
  fireEvent.click(screen.getByRole('button', { name: marketEn.useVersion }))
  let dialog = screen.getByRole('dialog', { name: marketEn.useVersion })
  fireEvent.click(within(dialog).getByRole('button', { name: marketEn.close }))
  fireEvent.click(screen.getByRole('button', { name: marketEn.useVersion }))
  dialog = screen.getByRole('dialog', { name: marketEn.useVersion })
  fireEvent.click(within(dialog).getByRole('button', { name: marketEn.confirm }))
  await waitFor(() => { expect(page.reportOutcome).toHaveBeenCalledWith('defaultDone', false) })
  expect(setDefault).toHaveBeenNthCalledWith(1, { skillName: 'writer', expected: null, target: installation.release.id })
  expect(screen.getByRole('button', { name: marketEn.default })).toHaveProperty('disabled', true)
  await tab('installed')
  expect(screen.getByRole('button', { name: marketEn.remove })).toHaveProperty('disabled', true)
  fireEvent.click(screen.getByRole('button', { name: marketEn.disable }))
  dialog = screen.getByRole('dialog', { name: marketEn.disable })
  fireEvent.click(within(dialog).getByRole('button', { name: marketEn.confirm }))
  await waitFor(() => { expect(setDefault).toHaveBeenCalledTimes(2) })
  expect(setDefault).toHaveBeenLastCalledWith({ skillName: 'writer', expected: installation.release.id, target: null })
})

it.each([false, true])('installs an exact public release with an earlier default=%s', async (hasDefault) => {
  const old = brandString<typeof installation.release.id>('f'.repeat(64))
  const installPublication = vi.fn(async () => ({ publication: published, installation }))
  const page = mount({ installed: async () => [], installPublication,
    defaults: async () => ({ revision: 1, defaults: hasDefault ? [{ skillName: 'writer', releaseId: old }] : [] }) })
  await screen.findByRole('heading', { name: 'Writer' })
  fireEvent.click(screen.getByRole('button', { name: hasDefault ? marketEn.installUpdate : marketEn.install }))
  await waitFor(() => { expect(page.reportOutcome).toHaveBeenCalledWith('installedDone', false) })
  expect(installPublication).toHaveBeenCalledExactlyOnceWith(published.id, published.sha256)
  expect(screen.getByRole('button', { name: marketEn.useVersion })).toBeTruthy()
})

it('imports original file bytes, replaces an existing local row and removes it', async () => {
  const updated = { ...installation, release: { ...installation.release,
    manifest: { ...installation.release.manifest, title: 'Updated writer' } } }
  const importPackage = vi.fn(async () => updated), removePackage = vi.fn(async () => {})
  const page = mount({ importPackage, removePackage })
  await ready(); await tab('installed')
  const input = screen.getByLabelText(marketEn.import)
  fireEvent.change(input, { target: { files: [] } })
  expect(importPackage).not.toHaveBeenCalled()
  fireEvent.change(input, { target: { files: [new NodeFile([Uint8Array.of(0, 1, 2, 255)], 'writer.zip')] } })
  await screen.findByRole('heading', { name: 'Updated writer' })
  expect(importPackage).toHaveBeenCalledExactlyOnceWith('AAEC/w==')
  expect(screen.queryByRole('heading', { name: 'Writer' })).toBeNull()
  expect(page.reportOutcome).toHaveBeenCalledWith('installedDone', false)
  fireEvent.click(screen.getByRole('button', { name: marketEn.remove }))
  await waitFor(() => { expect(screen.queryByRole('heading', { name: 'Updated writer' })).toBeNull() })
  expect(removePackage).toHaveBeenCalledExactlyOnceWith(installation.release.id)
  expect(screen.getByText(marketEn.empty)).toBeTruthy()
})

it('exports local bytes and shows local details without cloud availability', async () => {
  vi.stubGlobal('URL', class extends URL { static override createObjectURL = () => 'blob:market-section'; static override revokeObjectURL = () => {} })
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
  const exportPackage = vi.fn(async () => ({ name: 'writer.zip', base64: 'emlw' }))
  const page = mount({ exportPackage, catalog: async () => { throw new Error('Cloud offline') } })
  await screen.findByRole('alert')
  await tab('installed')
  fireEvent.click(screen.getByRole('button', { name: marketEn.details }))
  const dialog = screen.getByRole('dialog', { name: 'Writer' })
  fireEvent.click(within(dialog).getByRole('button', { name: marketEn.close }))
  fireEvent.click(screen.getByRole('button', { name: marketEn.export }))
  await waitFor(() => { expect(page.reportOutcome).toHaveBeenCalledWith('done', false) })
  expect(exportPackage).toHaveBeenCalledExactlyOnceWith(installation.release.id)
})

it.each([false, true])('refreshes conflicting defaults when the readback fails=%s', async (failReadback) => {
  const defaults = vi.fn<MarketActions['defaults']>().mockResolvedValueOnce(emptyDefaults)
  if (failReadback) defaults.mockRejectedValue(new Error('Offline'))
  else defaults.mockResolvedValue({ revision: 2, defaults: [{ skillName: 'writer', releaseId: installation.release.id }] })
  const page = mount({ defaults, setDefault: async () => { throw { details: { code: 'default-conflict' } } } })
  await screen.findByRole('heading', { name: 'Writer' })
  fireEvent.click(screen.getByRole('button', { name: marketEn.useVersion }))
  fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: marketEn.confirm }))
  await waitFor(() => { expect(page.reportOutcome).toHaveBeenCalledWith('defaultConflict', true) })
  expect(defaults).toHaveBeenCalledTimes(2)
  expect(Boolean(screen.queryByRole('dialog'))).toBe(failReadback)
})

it('keeps the default confirmation open during a pending write', async () => {
  const pending = Promise.withResolvers<MarketDefaultSnapshot>()
  mount({ setDefault: () => pending.promise })
  await screen.findByRole('heading', { name: 'Writer' })
  fireEvent.click(screen.getByRole('button', { name: marketEn.useVersion }))
  const dialog = screen.getByRole('dialog')
  fireEvent.click(within(dialog).getByRole('button', { name: marketEn.confirm }))
  fireEvent.click(within(dialog).getByRole('button', { name: marketEn.close }))
  expect(screen.getByRole('dialog')).toBe(dialog)
  await act(async () => { pending.resolve(emptyDefaults); await pending.promise })
  expect(screen.queryByRole('dialog')).toBeNull()
})

it('recovers local reads through Retry after a storage error', async () => {
  const installed = vi.fn<MarketActions['installed']>().mockRejectedValueOnce(new Error('Storage offline')).mockResolvedValue([installation])
  mount({ installed })
  await screen.findByRole('alert')
  fireEvent.click(screen.getByRole('button', { name: marketEn.retry }))
  await screen.findByRole('heading', { name: 'Writer' })
  expect(screen.queryByRole('alert')).toBeNull()
})

it('keeps private rows and details out of a newer account generation', async () => {
  const catalog = vi.fn<MarketActions['catalog']>().mockResolvedValueOnce([publication])
    .mockResolvedValueOnce([publication]).mockResolvedValue([])
  const page = mount({ catalog })
  await ready(); await tab('publish')
  await screen.findByRole('button', { name: marketEn['review.submit'] })
  fireEvent.click(within(card()).getByRole('button', { name: marketEn.details }))
  expect(screen.getByRole('dialog', { name: 'Writer' })).toBeTruthy()
  act(() => { page.setAccess({ revision: 2 }) })
  expect(screen.queryByRole('dialog')).toBeNull()
  expect(screen.queryByRole('button', { name: marketEn['review.submit'] })).toBeNull()
  await ready()
})

it('refreshes creator publications after upload and replaces the reviewed row by id', async () => {
  const second = { ...published, id: parseMarketPublicationId('f'.repeat(32)), manifest: { ...published.manifest, title: 'Other writer' } }
  const catalog = vi.fn(async () => [publication, second]), publishDraft = vi.fn(async () => publication)
  const reviewed = { ...publication, status: 'pending', revision: 3, manifest: { ...publication.manifest, title: 'Reviewed writer' } } as const
  const review = vi.fn(async () => reviewed)
  mount({ catalog, publishDraft, review })
  await ready(); await tab('publish')
  await screen.findByRole('button', { name: marketEn['review.submit'] })
  fireEvent.change(screen.getByLabelText(marketEn.chooseLocal), { target: { value: installation.release.id } })
  fireEvent.change(screen.getByLabelText(marketEn.publisher), { target: { value: identity.publishers[0]!.id } })
  fireEvent.click(screen.getByRole('button', { name: marketEn.upload }))
  await waitFor(() => { expect(catalog).toHaveBeenCalledTimes(3) })
  await ready()
  fireEvent.click(screen.getByRole('button', { name: marketEn['review.submit'] }))
  fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: marketEn.confirm }))
  await screen.findByRole('heading', { name: 'Reviewed writer' })
  expect(screen.getByRole('heading', { name: 'Other writer' })).toBeTruthy()
})

it('installs a publication from the creator list', async () => {
  const installPublication = vi.fn(async () => ({ publication, installation }))
  const page = mount({ installPublication })
  await ready(); await tab('publish')
  const install = await screen.findByRole('button', { name: marketEn.install })
  fireEvent.click(install)
  await waitFor(() => { expect(page.reportOutcome).toHaveBeenCalledWith('installedDone', false) })
  expect(installPublication).toHaveBeenCalledExactlyOnceWith(published.id, published.sha256)
})

it('refuses to activate an installed release without an invoked skill', async () => {
  const invalid = { ...installation, release: { ...installation.release,
    manifest: { ...installation.release.manifest, skills: [] } } }
  const setDefault = vi.fn(), page = mount({ installed: async () => [invalid], setDefault })
  await ready(); await tab('installed')
  fireEvent.click(screen.getByRole('button', { name: marketEn.useVersion }))
  fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: marketEn.confirm }))
  await waitFor(() => { expect(page.reportOutcome).toHaveBeenCalledWith('invalidPackage', true) })
  expect(setDefault).not.toHaveBeenCalled()
})

it('reports a settled local failure without performing a defaults readback', async () => {
  const defaults = vi.fn(async () => emptyDefaults)
  const page = mount({ defaults, removePackage: async () => { throw new Error('Offline') } })
  await ready(); await tab('installed')
  fireEvent.click(screen.getByRole('button', { name: marketEn.remove }))
  await waitFor(() => { expect(page.reportOutcome).toHaveBeenCalledWith('cloudUnavailable', true) })
  expect(defaults).toHaveBeenCalledTimes(2)
  expect(screen.getByRole('heading', { name: 'Writer' })).toBeTruthy()
})

it.each([false, true])('ignores a superseded local read that rejects=%s', async (reject) => {
  const pending = Promise.withResolvers<typeof installation[]>(), installed = vi.fn<MarketActions['installed']>()
    .mockImplementationOnce(() => pending.promise).mockResolvedValue([])
  mount({ installed })
  await tab('installed')
  expect(screen.getByText(marketEn.empty)).toBeTruthy()
  await act(async () => {
    if (reject) pending.reject(new Error('Earlier failure'))
    else pending.resolve([installation])
    await pending.promise.catch(() => undefined)
  })
  expect(screen.queryByRole('heading', { name: 'Writer' })).toBeNull()
  expect(screen.queryByRole('alert')).toBeNull()
})

it('ignores cloud and source replies from an earlier refresh', async () => {
  const cloud = Promise.withResolvers<typeof published[]>(), source = Promise.withResolvers<typeof sources>()
  const catalog = vi.fn<MarketActions['catalog']>().mockImplementationOnce(() => cloud.promise).mockResolvedValue([])
  const sourceCalls = vi.fn<MarketActions['sources']>().mockImplementationOnce(() => source.promise).mockResolvedValue(sources)
  mount({ catalog, sources: sourceCalls })
  await waitFor(() => { expect(catalog).toHaveBeenCalledOnce() })
  fireEvent.click(screen.getByRole('button', { name: marketEn.refresh }))
  await waitFor(() => { expect(catalog).toHaveBeenCalledTimes(2) })
  await act(async () => {
    cloud.resolve([published]); source.resolve({ skills: [], complete: false })
    await Promise.all([cloud.promise, source.promise])
  })
  expect(screen.queryByRole('heading', { name: 'Writer' })).toBeNull()
  await tab('publish')
  expect(screen.queryByText(marketEn.sourcesIncomplete)).toBeNull()
})

it('continues discovery when the source list is unavailable', async () => {
  mount({ sources: async () => { throw new Error('Source unavailable') } })
  await screen.findByRole('heading', { name: 'Writer' })
  expect(screen.queryByRole('alert')).toBeNull()
})

it.each(['default', 'import', 'remove', 'discover-install', 'creator-install', 'review', 'failure'] as const)
('lets %s settle after the page closes without replacing its former view', async (operation) => {
  const local = Promise.withResolvers<typeof installation>(), done = Promise.withResolvers<undefined>()
  const active = Promise.withResolvers<MarketDefaultSnapshot>()
  const cloud = Promise.withResolvers<{ publication: typeof published; installation: typeof installation }>()
  const review = Promise.withResolvers<typeof publication>()
  const page = mount({ setDefault: () => active.promise, importPackage: () => local.promise,
    removePackage: () => done.promise, installPublication: () => cloud.promise, review: () => review.promise,
    catalog: async () => operation === 'review' ? [publication] : [published] })
  await screen.findByRole('heading', { name: 'Writer' })
  if (operation === 'creator-install' || operation === 'review') await tab('publish')
  if (operation === 'import' || operation === 'remove' || operation === 'failure') await tab('installed')
  if (operation === 'default') {
    fireEvent.click(screen.getByRole('button', { name: marketEn.useVersion }))
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: marketEn.confirm }))
  } else if (operation === 'import') {
    fireEvent.change(screen.getByLabelText(marketEn.import), { target: { files: [new NodeFile(['zip'], 'writer.zip')] } })
    await act(async () => { await Promise.resolve() })
  } else if (operation === 'remove' || operation === 'failure') fireEvent.click(screen.getByRole('button', { name: marketEn.remove }))
  else if (operation === 'review') {
    fireEvent.click(await screen.findByRole('button', { name: marketEn['review.submit'] }))
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: marketEn.confirm }))
  } else {
    if (operation === 'discover-install') {
      page.unmount()
      const other = mount({ installed: async () => [], installPublication: () => cloud.promise })
      await screen.findByRole('button', { name: marketEn.install })
      fireEvent.click(screen.getByRole('button', { name: marketEn.install }))
      other.unmount()
    } else fireEvent.click(await screen.findByRole('button', { name: marketEn.install }))
  }
  page.unmount()
  await act(async () => {
    if (operation === 'failure') { done.reject(new Error('Offline')); await done.promise.catch(() => undefined) }
    else {
      local.resolve(installation); done.resolve(undefined); active.resolve(emptyDefaults)
      cloud.resolve({ publication: published, installation }); review.resolve(publication)
      await Promise.all([local.promise, done.promise, active.promise, cloud.promise, review.promise])
    }
  })
  expect(screen.queryByRole('heading', { name: 'Writer' })).toBeNull()
})

it('ignores a file chooser completion while another local operation is pending', async () => {
  const pending = Promise.withResolvers<undefined>(), importPackage = vi.fn()
  mount({ removePackage: () => pending.promise, importPackage })
  await ready(); await tab('installed')
  const input = screen.getByLabelText(marketEn.import)
  fireEvent.click(screen.getByRole('button', { name: marketEn.remove }))
  fireEvent.change(input, { target: { files: [new NodeFile(['zip'], 'writer.zip')] } })
  expect(importPackage).not.toHaveBeenCalled()
  await act(async () => { pending.resolve(undefined); await pending.promise })
})
