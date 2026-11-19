// @vitest-environment jsdom
/** Plugin teardown removes its navigation, panel and resource providers together. */
import { Context, Service } from '@deepseek-ai/cordis'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { apply as resources } from '@deepseek-ai/dsh-client-resources/client'
import { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client'
import { RemoteError, SlotTestRuntime, stubConfigForm, TestRoot } from '@deepseek-ai/dsh-client-test-runtime'
import type { CharacterLibraryBrowseResult, CharacterLibraryEntry } from '@deepseek-ai/dsh-api-character-library/types'
import type {} from '@deepseek-ai/dsh-api-character-library/remote'
import type { TypertRemoteContribution, TypertRemoteNamespaceMap } from '@deepseek-ai/dsh-typert-protocol'
import { afterEach, expect, it, onTestFinished, vi } from 'vitest'
import { apply, Config } from '../src/client/index.ts'

type CharacterLibraryRemote = TypertRemoteNamespaceMap['characterLibraryBrowser']
type CatalogFrame = Awaited<ReturnType<CharacterLibraryRemote['browse']>>

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks() })

function entry(id: string): CharacterLibraryEntry {
  return {
    catalogAssetId: `character:muse-character-reference-qa:${id}` as CharacterLibraryEntry['catalogAssetId'],
    originalAssetId: id as CharacterLibraryEntry['originalAssetId'], collection: 'ancient', format: 'legacy_v1',
    metadataStatus: 'pending_review', metadataKey: `${id}/metadata.json`, imageKey: `${id}/portrait.png`,
    category: 'character', setting: 'ancient', artStyle: '3D', era: ['ancient'], gender: 'female',
    appearance: [], tags: [], safety: { canPublish: false, canReuse: false, canBind: false, applyAllowed: false },
  }
}

function catalog(...ids: string[]): CharacterLibraryBrowseResult {
  return { entries: ids.map(entry), nextCursor: null, scanned: ids.length }
}

declare module '@deepseek-ai/cordis' {
  interface Context { 'remote.characterLibraryBrowser': CharacterLibraryRemote }
}

class BrowserRemote extends Service {
  readonly characterLibraryBrowser: CharacterLibraryRemote = {
    status: async () => ({ ok: true, value: { configured: false, sourceId: 'muse-character-reference-qa', readOnly: true, uploadPending: 'unavailable' } }),
    browse: async () => ({ ok: true, value: { entries: [], nextCursor: null, scanned: 0 } }),
    preview: async () => { throw new Error('No image in the disconnected catalog') },
  }
  constructor(ctx: Context) { super(ctx, 'remote') }
  async $mount(_contribution: TypertRemoteContribution): Promise<() => Promise<void>> {
    const namespace = this.ctx.plugin((scope) => { scope.provide('remote.characterLibraryBrowser', this.characterLibraryBrowser) })
    await namespace.await()
    return async () => { await namespace.dispose() }
  }
}

class BrowserConfigForms extends Service {
  readonly form = stubConfigForm<Config>()
  readonly mirror = { ensure: vi.fn(async () => {}) }
  constructor(ctx: Context, syncIntervalMs = 1000) {
    super(ctx, 'configForms')
    this.form.publish({ status: 'ready', value: { syncIntervalMs } })
  }
  get() { return this.form.scope }
  describe() { return this.mirror }
}

async function fixture(configure?: (configForms: BrowserConfigForms) => void) {
  const ctx = new Context()
  onTestFinished(async () => { await ctx.fiber.dispose() })
  await ctx.plugin(SlotRegistry).await()
  ctx.provide('locale', new LocaleRuntime(ctx))
  const remote = new BrowserRemote(ctx)
  const configForms = new BrowserConfigForms(ctx)
  configure?.(configForms)
  await ctx.plugin({ apply: resources, inject: ['slots'] }).await()
  const root = new TestRoot(ctx.slots, async (action) => { await action() })
  onTestFinished(() => { root.release() })
  await root.declare({ main: { kind: 'keyed', scope: 'root' }, 'sidebar.panellist': { kind: 'list', scope: 'root' } }, () => null)
  const dispose = await apply(ctx)
  onTestFinished(dispose)
  return { ctx, remote: remote.characterLibraryBrowser, configForms, dispose }
}

it('validates the synchronization interval and supplies the ordinary default', () => {
  expect(Config().syncIntervalMs).toBe(30_000)
  for (const syncIntervalMs of [0, 999, 300_001, 1000.5]) {
    expect(() => Config({ syncIntervalMs })).toThrow()
  }
})

it('registers character library copy for every supported locale', async () => {
  const { ctx } = await fixture()
  const titles = {
    zh: '人物库', en: 'Character library', ja: '人物ライブラリ',
    es: 'Biblioteca de personajes', fr: 'Bibliothèque de personnages',
    de: 'Figurenbibliothek', ru: 'Библиотека персонажей', pt: 'Biblioteca de personagens',
  }
  const t = ctx.locale.bind('characterLibrary')
  for (const [locale, title] of Object.entries(titles)) {
    if (locale !== 'zh' && locale !== 'en') {
      onTestFinished(ctx.locale.addLanguage({ id: locale, label: title, fallback: 'en' }))
    }
    ctx.locale.setLocale(locale)
    expect(t('title')).toBe(title)
    expect(t('count', { count: 2 })).toContain('2')
    expect(t('count', { count: 2 })).not.toContain('{count}')
  }
})

it('uses the projected Host interval and reads a later live configuration value', async () => {
  const { ctx, remote, configForms } = await fixture()
  vi.useFakeTimers()
  const browse = vi.spyOn(remote, 'browse').mockResolvedValue({ ok: true, value: catalog('first') })
  const source = ctx.resources.source('dsh-resource://character-library-catalog/current')
  const release = source.subscribe(() => {})
  onTestFinished(release)
  await vi.advanceTimersByTimeAsync(0)
  expect(configForms.mirror.ensure).toHaveBeenCalledTimes(1)
  expect(browse).toHaveBeenCalledTimes(1)
  await vi.advanceTimersByTimeAsync(999)
  expect(browse).toHaveBeenCalledTimes(1)
  configForms.form.publish({ value: { syncIntervalMs: 2000 } })
  await vi.advanceTimersByTimeAsync(1)
  expect(browse).toHaveBeenCalledTimes(2)
  await vi.advanceTimersByTimeAsync(1999)
  expect(browse).toHaveBeenCalledTimes(2)
  await vi.advanceTimersByTimeAsync(1)
  expect(browse).toHaveBeenCalledTimes(3)
  release()
  await vi.advanceTimersByTimeAsync(0)
  expect(vi.getTimerCount()).toBe(0)
})

it('registers while settings are pending and starts polling only after the Host interval arrives', async () => {
  const pending = Promise.withResolvers<undefined>()
  const reading = Promise.withResolvers<undefined>()
  onTestFinished(() => { pending.resolve(undefined) })
  const { ctx, remote, configForms } = await fixture((forms) => {
    forms.form.publish({ status: 'loading', value: undefined })
    forms.mirror.ensure.mockImplementation(() => { reading.resolve(undefined); return pending.promise })
  })
  vi.useFakeTimers()
  const browse = vi.spyOn(remote, 'browse').mockResolvedValue({ ok: true, value: catalog('first') })
  expect(ctx.slots.entries('main')).toHaveLength(1)
  expect(ctx.slots.entries('sidebar.panellist')).toHaveLength(1)
  const source = ctx.resources.source('dsh-resource://character-library-catalog/current')
  const release = source.subscribe(() => {})
  onTestFinished(release)
  await reading.promise
  expect(browse).not.toHaveBeenCalled()
  expect(source.getSnapshot().status).toBe('loading')
  expect(vi.getTimerCount()).toBe(0)
  configForms.form.publish({ status: 'ready', value: { syncIntervalMs: 2000 } })
  pending.resolve(undefined)
  await vi.advanceTimersByTimeAsync(0)
  expect(browse).toHaveBeenCalledTimes(1)
  expect(source.getSnapshot()).toMatchObject({ status: 'live', value: catalog('first') })
  await vi.advanceTimersByTimeAsync(1999)
  expect(browse).toHaveBeenCalledTimes(1)
  await vi.advanceTimersByTimeAsync(1)
  expect(browse).toHaveBeenCalledTimes(2)
  release()
  await vi.advanceTimersByTimeAsync(0)
  expect(vi.getTimerCount()).toBe(0)
})

it.each(['resolve', 'reject'] as const)('does not read the catalog after leaving while settings later %s', async (settlement) => {
  const pending = Promise.withResolvers<undefined>()
  const reading = Promise.withResolvers<undefined>()
  onTestFinished(() => { pending.resolve(undefined) })
  const { ctx, remote } = await fixture((forms) => {
    forms.mirror.ensure.mockImplementation(() => { reading.resolve(undefined); return pending.promise })
  })
  vi.useFakeTimers()
  const browse = vi.spyOn(remote, 'browse')
  const source = ctx.resources.source('dsh-resource://character-library-catalog/current')
  const release = source.subscribe(() => {})
  onTestFinished(release)
  await reading.promise
  release()
  if (settlement === 'resolve') pending.resolve(undefined)
  else pending.reject(new Error('Settings are offline'))
  await vi.advanceTimersByTimeAsync(10_000)
  expect(browse).not.toHaveBeenCalled()
  expect(source.getSnapshot()).toMatchObject({ status: 'loading', value: undefined, failure: undefined })
  expect(vi.getTimerCount()).toBe(0)
})

it('reports unavailable Host synchronization settings as a catalog failure', async () => {
  const { ctx, remote } = await fixture((forms) => {
    forms.form.publish({ status: 'unavailable', value: undefined })
  })
  vi.useFakeTimers()
  const browse = vi.spyOn(remote, 'browse')
  const source = ctx.resources.source('dsh-resource://character-library-catalog/current')
  const release = source.subscribe(() => {})
  onTestFinished(release)
  await vi.advanceTimersByTimeAsync(0)
  expect(source.getSnapshot()).toMatchObject({
    status: 'failed', value: undefined,
    failure: { name: 'RemoteError', code: 'gateway/internal', cause: { message: 'character-library: synchronization settings are unavailable' } },
  })
  expect(browse).not.toHaveBeenCalled()
  expect(ctx.slots.entries('sidebar.panellist')).toHaveLength(1)
  expect(vi.getTimerCount()).toBe(0)
})

it('reports a settings read failure without preventing registration', async () => {
  const failure = new Error('Settings are offline')
  const { ctx, remote } = await fixture((forms) => { forms.mirror.ensure.mockRejectedValueOnce(failure) })
  vi.useFakeTimers()
  const browse = vi.spyOn(remote, 'browse')
  const source = ctx.resources.source('dsh-resource://character-library-catalog/current')
  const release = source.subscribe(() => {})
  onTestFinished(release)
  await vi.advanceTimersByTimeAsync(0)
  expect(source.getSnapshot()).toMatchObject({ status: 'failed', value: undefined, failure: { name: 'RemoteError', code: 'gateway/internal', cause: failure } })
  expect(browse).not.toHaveBeenCalled()
  expect(ctx.slots.entries('main')).toHaveLength(1)
  expect(vi.getTimerCount()).toBe(0)
})

it('retains the catalog when the Host interval becomes invalid and retries after settings are corrected', async () => {
  const { ctx, remote, configForms } = await fixture()
  vi.useFakeTimers()
  const previous = catalog('first')
  const browse = vi.spyOn(remote, 'browse').mockResolvedValue({ ok: true, value: previous })
  const source = ctx.resources.source('dsh-resource://character-library-catalog/current')
  const release = source.subscribe(() => {})
  onTestFinished(release)
  await vi.advanceTimersByTimeAsync(0)
  configForms.form.publish({ value: { syncIntervalMs: 0 } })
  await vi.advanceTimersByTimeAsync(1000)
  expect(source.getSnapshot()).toMatchObject({ status: 'failed', value: previous, failure: { name: 'RemoteError', code: 'gateway/internal' } })
  expect(source.getSnapshot().failure?.cause).toBeInstanceOf(Error)
  expect(browse).toHaveBeenCalledTimes(1)
  expect(vi.getTimerCount()).toBe(0)
  release()
  configForms.form.publish({ value: { syncIntervalMs: 2000 } })
  const retried = ctx.resources.source('dsh-resource://character-library-catalog/current?revision=1')
  const stopRetry = retried.subscribe(() => {})
  onTestFinished(stopRetry)
  await vi.advanceTimersByTimeAsync(0)
  expect(retried.getSnapshot()).toMatchObject({ status: 'live', value: previous, failure: undefined })
  expect(browse).toHaveBeenCalledTimes(2)
  await vi.advanceTimersByTimeAsync(2000)
  expect(browse).toHaveBeenCalledTimes(3)
  stopRetry()
  await vi.advanceTimersByTimeAsync(0)
  expect(vi.getTimerCount()).toBe(0)
})

it('shares one polling stream and discovers added and removed people without a manual refresh', async () => {
  const { ctx, remote } = await fixture()
  vi.useFakeTimers()
  const browse = vi.spyOn(remote, 'browse').mockResolvedValue({ ok: true, value: catalog('first') })
  const source = ctx.resources.source('dsh-resource://character-library-catalog/current?collection=ancient')
  const first = source.subscribe(() => {})
  const second = source.subscribe(() => {})
  onTestFinished(first); onTestFinished(second)
  await vi.advanceTimersByTimeAsync(0)
  expect(browse).toHaveBeenCalledTimes(1)
  expect(source.getSnapshot()).toMatchObject({ status: 'live', value: catalog('first') })
  browse.mockResolvedValue({ ok: true, value: catalog('first', 'new-person') })
  await vi.advanceTimersByTimeAsync(1000)
  expect(browse).toHaveBeenCalledTimes(2)
  expect(source.getSnapshot().value).toEqual(catalog('first', 'new-person'))
  browse.mockResolvedValue({ ok: true, value: catalog('new-person') })
  await vi.advanceTimersByTimeAsync(1000)
  expect(source.getSnapshot().value).toEqual(catalog('new-person'))
  first(); second()
  await vi.advanceTimersByTimeAsync(0)
  expect(vi.getTimerCount()).toBe(0)
})

it('keeps the previous catalog after a failed refresh and recovers at the next interval', async () => {
  const { ctx, remote } = await fixture()
  vi.useFakeTimers()
  const previous = catalog('first')
  vi.spyOn(remote, 'browse')
    .mockResolvedValueOnce({ ok: true, value: previous })
    .mockResolvedValueOnce({ ok: false, error: new RemoteError('character-library/read-failed', 'Read failed', { code: 'LIST_FAILED' }) })
    .mockResolvedValue({ ok: true, value: catalog('first', 'new-person') })
  const source = ctx.resources.source('dsh-resource://character-library-catalog/current')
  const release = source.subscribe(() => {})
  onTestFinished(release)
  await vi.advanceTimersByTimeAsync(0)
  await vi.advanceTimersByTimeAsync(1000)
  expect(source.getSnapshot()).toMatchObject({ status: 'failed', value: previous, failure: { code: 'character-library/read-failed' } })
  await vi.advanceTimersByTimeAsync(1000)
  expect(source.getSnapshot()).toMatchObject({ status: 'live', value: catalog('first', 'new-person'), failure: undefined })
  release()
  await vi.advanceTimersByTimeAsync(0)
  expect(vi.getTimerCount()).toBe(0)
})

it('cancels the waiting interval after the last subscriber or plugin leaves', async () => {
  const { ctx, remote, dispose } = await fixture()
  vi.useFakeTimers()
  const browse = vi.spyOn(remote, 'browse').mockResolvedValue({ ok: true, value: catalog('first') })
  const source = ctx.resources.source('dsh-resource://character-library-catalog/current')
  const release = source.subscribe(() => {})
  onTestFinished(release)
  await vi.advanceTimersByTimeAsync(0)
  expect(vi.getTimerCount()).toBe(1)
  release()
  await vi.advanceTimersByTimeAsync(10_000)
  expect(browse).toHaveBeenCalledTimes(1)
  expect(vi.getTimerCount()).toBe(0)
  const reopened = source.subscribe(() => {})
  onTestFinished(reopened)
  await vi.advanceTimersByTimeAsync(0)
  expect(browse).toHaveBeenCalledTimes(2)
  await dispose()
  await vi.advanceTimersByTimeAsync(10_000)
  expect(source.getSnapshot().status).toBe('none')
  expect(browse).toHaveBeenCalledTimes(2)
  expect(vi.getTimerCount()).toBe(0)
})

it('waits for a slow read before scheduling another and discards an aborted late result', async () => {
  const { ctx, remote } = await fixture()
  vi.useFakeTimers()
  const pending = Promise.withResolvers<CatalogFrame>()
  const browse = vi.spyOn(remote, 'browse').mockReturnValue(pending.promise)
  const source = ctx.resources.source('dsh-resource://character-library-catalog/current')
  const release = source.subscribe(() => {})
  onTestFinished(release)
  onTestFinished(() => { pending.resolve({ ok: true, value: catalog('first') }) })
  await vi.advanceTimersByTimeAsync(10_000)
  expect(browse).toHaveBeenCalledTimes(1)
  expect(vi.getTimerCount()).toBe(0)
  release()
  expect(browse.mock.calls[0]?.[1]?.aborted).toBe(true)
  pending.resolve({ ok: true, value: catalog('first') })
  await vi.advanceTimersByTimeAsync(10_000)
  expect(browse).toHaveBeenCalledTimes(1)
  expect(source.getSnapshot()).toMatchObject({ status: 'loading', value: undefined })
  expect(vi.getTimerCount()).toBe(0)
})

it('releases the stream during a delivered frame without leaving a waiting interval', async () => {
  const { ctx, remote } = await fixture()
  vi.useFakeTimers()
  vi.spyOn(remote, 'browse').mockResolvedValue({ ok: true, value: catalog('first') })
  const source = ctx.resources.source('dsh-resource://character-library-catalog/current')
  const release = source.subscribe(() => { if (source.getSnapshot().status === 'live') release() })
  onTestFinished(release)
  await vi.advanceTimersByTimeAsync(0)
  expect(source.getSnapshot().status).toBe('loading')
  expect(vi.getTimerCount()).toBe(0)
})

it('passes collection, query, pagination and image identities to the read-only Remote methods', async () => {
  const { ctx, remote } = await fixture()
  vi.useFakeTimers()
  const browse = vi.spyOn(remote, 'browse').mockResolvedValue({ ok: true, value: catalog() })
  const id = entry('first').catalogAssetId
  const preview = vi.spyOn(remote, 'preview').mockResolvedValue({ ok: true, value: {
    catalogAssetId: id, dataUrl: 'data:image/png;base64,cGljdHVyZQ==', sha256: '0'.repeat(64),
  } })
  const addresses = [
    'dsh-resource://character-library-status/current',
    'dsh-resource://character-library-catalog/current?collection=urban&query=costume&cursor=page-2',
    'dsh-resource://character-library-catalog/current?query=',
    `dsh-resource://character-library-image/${encodeURIComponent(id)}`,
  ]
  const releases = addresses.map(address => ctx.resources.source(address).subscribe(() => {}))
  onTestFinished(() => { for (const release of releases) release() })
  await vi.advanceTimersByTimeAsync(0)
  expect(browse).toHaveBeenCalledWith({ collection: 'urban', query: 'costume', cursor: 'page-2', limit: 12 }, expect.any(AbortSignal))
  expect(browse).toHaveBeenCalledWith({ collection: 'all', limit: 12 }, expect.any(AbortSignal))
  expect(preview).toHaveBeenCalledWith({ catalogAssetId: id }, expect.any(AbortSignal))
  expect(ctx.resources.source(addresses[0]!).getSnapshot()).toMatchObject({ status: 'live', value: { configured: false, readOnly: true } })
  for (const release of releases) release()
  await vi.advanceTimersByTimeAsync(0)
  expect(vi.getTimerCount()).toBe(0)
})

it('assembles the navigation icon and read-only main panel through the slot renderer', async () => {
  const runtime = await SlotTestRuntime.create()
  onTestFinished(() => runtime.dispose())
  const locale = new LocaleRuntime(runtime.ctx)
  locale.setLocale('en')
  runtime.ctx.provide('locale', locale)
  runtime.slots.installLocale(locale)
  new BrowserConfigForms(runtime.ctx)
  const api: CharacterLibraryRemote = {
    status: async () => ({ ok: true, value: { configured: false, sourceId: 'muse-character-reference-qa', readOnly: true, uploadPending: 'unavailable' } }),
    browse: async () => ({ ok: true, value: catalog() }),
    preview: async () => { throw new Error('No catalog image') },
  }
  runtime.remote.provideNamespaces({ characterLibraryBrowser: api })
  vi.spyOn(runtime.remote, '$mount').mockResolvedValue(() => Promise.resolve())
  await runtime.mount({ apply: resources, inject: ['slots'] })
  await runtime.root.declare({ main: { kind: 'keyed', scope: 'root' }, 'sidebar.panellist': { kind: 'list', scope: 'root' } },
    ({ renderSlot }) => <>{renderSlot('main', {}, { entryKey: 'character-library' })}{renderSlot('sidebar.panellist', { size: 16, active: false })}</>)
  const dispose = await apply(runtime.ctx)
  onTestFinished(dispose)
  const view = runtime.renderRoot()
  expect(await view.findByText('The character library is not connected. Ask your administrator to enable access.')).toBeTruthy()
  expect(view.getByRole('heading', { name: 'Shared assets' })).toBeTruthy()
  expect(view.container.querySelectorAll('svg')).toHaveLength(2)
  const label = runtime.slots.entries('sidebar.panellist')[0]?.options.label
  expect(typeof label === 'function' ? label() : label).toBe('Asset library')
})

it('removes its Remote namespace if a registration fails during loading', async () => {
  const { ctx, dispose } = await fixture()
  await dispose()
  vi.spyOn(ctx.locale, 'register').mockImplementationOnce(() => { throw new Error('Registration failed') })
  await expect(apply(ctx)).rejects.toThrow('Registration failed')
  expect(ctx.get('remote.characterLibraryBrowser')).toBeUndefined()
  expect(ctx.slots.entries('main')).toHaveLength(0)
  expect(ctx.slots.entries('sidebar.panellist')).toHaveLength(0)
})

it('supports repeated load and disposal without leaving duplicate entries', async () => {
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  await ctx.plugin(SlotRegistry).await()
  const locale = new LocaleRuntime(ctx)
  ctx.provide('locale', locale)
  new BrowserRemote(ctx)
  new BrowserConfigForms(ctx)
  await ctx.plugin({ apply: resources, inject: ['slots'] }).await()
  const root = new TestRoot(ctx.slots, async (action) => { await action() })
  onTestFinished(() => { root.release() })
  await root.declare({ main: { kind: 'keyed', scope: 'root' }, 'sidebar.panellist': { kind: 'list', scope: 'root' } }, () => null)
  for (let round = 0; round < 2; ++round) {
    const dispose = await apply(ctx)
    expect(ctx.slots.entries('main')).toHaveLength(1)
    expect(ctx.slots.entries('sidebar.panellist')).toHaveLength(1)
    expect(ctx.slots.entries('sidebar.panellist')[0]?.options.id).toBe('character-library')
    expect(ctx.resources.source('dsh-resource://character-library-status/current').getSnapshot().status).toBe('loading')
    await dispose()
    expect(ctx.slots.entries('main')).toHaveLength(0)
    expect(ctx.slots.entries('sidebar.panellist')).toHaveLength(0)
    expect(ctx.resources.source('dsh-resource://character-library-status/current').getSnapshot().status).toBe('none')
  }
})
