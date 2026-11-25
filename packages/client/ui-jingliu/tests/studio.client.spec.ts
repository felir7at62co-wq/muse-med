// @vitest-environment jsdom
/** Public workbench URLs and disposable right-sidebar access. */
import { act, fireEvent, waitFor, within } from '@testing-library/react'
import { Context } from '@deepseek-ai/cordis'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import * as resources from '@deepseek-ai/dsh-client-resources/client'
import { SlotTestRuntime } from '@deepseek-ai/dsh-client-test-runtime'
import { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client'
import { SidebarRightTabRegistry } from '@deepseek-ai/dsh-client-ui-sidebar-right/src/client/tab-registry.ts'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { resolveSlotLabel, type PropsRenderSlots } from '@deepseek-ai/dsh-client-ui-slots'
import type {
  SelectedProject, StudioCatalog, StudioImage, StudioNewProject, StudioPreferences, StudioProject, StudioVideoRequest,
} from '@deepseek-ai/dsh-jingliu-connection/types'
import type { MuseDataRush } from '@deepseek-ai/dsh-muse-account/types'
import type { IndexInjection, WebServer } from '@deepseek-ai/dsh-host-webserver'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import { RemoteError, type RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import type {
  ScriptDraft, ScriptDraftCreateRequest, ScriptDraftEpisode, ScriptDraftExport, ScriptDraftExportRequest,
  ScriptDraftFinalizeRequest, ScriptDraftHistoryRestore, ScriptDraftHistoryRestoreRequest, ScriptDraftStoryboard,
  ScriptDraftStoryboardSaveRequest, ScriptSummary,
} from '@deepseek-ai/dsh-workbench-connection/types'
import { Fragment, createElement } from 'react'
import { afterEach, expect, it, onTestFinished, vi } from 'vitest'
import { studioUrl } from '../src/config.ts'
import { STUDIO_URL_GLOBAL, WORKSHOP_URL_GLOBAL } from '../src/page.ts'
import type { DrawerDataProps } from '../src/client/DrawerData.tsx'
import type { DraftActions } from '../src/client/DrawerScriptDraft.tsx'
import type { DrawerScriptsProps } from '../src/client/DrawerScripts.tsx'
import * as host from '../src/index.ts'
import * as studio from '../src/client/index.ts'
import type { ProductionActions } from '../src/client/Production.tsx'
import { en, zh } from '../src/client/locales.ts'

vi.mock('@deepseek-ai/dsh-jingliu-connection/remote', () => ({ default: {} }))

afterEach(() => vi.unstubAllGlobals())

it.each([
  { config: {}, titles: [], descriptions: [], urls: [] },
  { config: { studioOrigin: 'http://127.0.0.1:18796' }, titles: ['镜流'], descriptions: ['短剧制作工作台'],
    urls: ['http://127.0.0.1:18796/fwp/v2/auth/muse/embed'] },
  { config: { workshopOrigin: 'https://scripts.example' }, titles: ['剧本工坊'], descriptions: ['剧本创作与编辑'],
    urls: ['https://scripts.example/v1/auth/muse/embed'] },
  { config: { studioOrigin: 'https://studio.example', workshopOrigin: 'https://scripts.example' },
    titles: ['镜流', '剧本工坊'], descriptions: ['短剧制作工作台', '剧本创作与编辑'], urls: ['https://studio.example/fwp/v2/auth/muse/embed', 'https://scripts.example/v1/auth/muse/embed'] },
])('opens each configured workbench independently ($titles)', async ({ config, titles, descriptions, urls }) => {
  const ctx = new Context()
  onTestFinished(async () => { await ctx.fiber.dispose() })
  await ctx.plugin(host, config).await()
  const table: IndexInjection[] = []
  const peer = { principal: { kind: 'owner' } } as Parameters<WebServer['renderIndex']>[1]
  ctx.emit('webserver/index-inject', table, peer)
  const assigned = table.flatMap((item) => {
    if (item.kind !== 'global') return []
    vi.stubGlobal(item.name, item.value)
    return [item.value]
  })
  expect(assigned).toEqual(urls)
  expect(table.map(item => item.kind === 'global' && item.name)).toEqual([
    ...(config.studioOrigin ? [STUDIO_URL_GLOBAL] : []), ...(config.workshopOrigin ? [WORKSHOP_URL_GLOBAL] : []),
  ])
  await ctx.plugin(SlotRegistry).await()
  ctx.provide('locale', new LocaleRuntime(ctx))
  ctx.provide('sidebarRightTabs', new SidebarRightTabRegistry(ctx))
  ctx.locale.setLocale('zh')
  const active = ctx.plugin(studio)
  await active.await()
  const entries = ctx.sidebarRightTabs.guide()
  expect(entries.map(entry => entry.title())).toEqual(titles)
  expect(entries.map(entry => entry.description?.())).toEqual(descriptions)
  for (const entry of entries) {
    const tab = ctx.sidebarRightTabs.get(entry.kind)
    expect(tab?.title('')).toBe(entry.title())
    expect(tab?.keepMounted).toBe(true)
  }
  await active.dispose()
  expect(ctx.sidebarRightTabs.guide()).toHaveLength(0)
})

it('rejects an embedded Workshop on the renderer origin', async () => {
  vi.stubGlobal(WORKSHOP_URL_GLOBAL, new URL('/v1/auth/muse/embed', location.origin).href)
  const ctx = new Context()
  onTestFinished(async () => { await ctx.fiber.dispose() })
  await ctx.plugin(SlotRegistry).await()
  ctx.provide('locale', new LocaleRuntime(ctx))
  ctx.provide('sidebarRightTabs', new SidebarRightTabRegistry(ctx))
  await expect(ctx.plugin(studio).await()).rejects.toThrow('script-workshop requires a separate workbench origin.')
  expect(ctx.sidebarRightTabs.guide()).toHaveLength(0)
})

it('resolves studio and workshop pages only on dedicated origins', () => {
  expect(studioUrl(undefined)).toBeUndefined()
  expect(studioUrl(undefined, 'workshop')).toBeUndefined()
  expect(studioUrl('https://studio.example')).toBe('https://studio.example/fwp/v2/auth/muse/embed')
  expect(studioUrl('https://studio.example/jingliu')).toBe('https://studio.example/jingliu/')
  expect(studioUrl('https://studio.example/jingliu/')).toBe('https://studio.example/jingliu/')
  expect(() => studioUrl('https://studio.example/jingliu', 'workshop')).toThrow()
  expect(studioUrl('http://127.0.0.1:18796')).toBe('http://127.0.0.1:18796/fwp/v2/auth/muse/embed')
  expect(studioUrl('http://[::1]:18796/')).toBe('http://[::1]:18796/fwp/v2/auth/muse/embed')
  expect(studioUrl('http://[::1]:18796/', 'workshop')).toBe('http://[::1]:18796/v1/auth/muse/embed')
  for (const origin of ['http://studio.example', 'http://localhost:18796', 'http://127.1:18796',
    'file:///tmp/test', 'https://name@studio.example',
    'https://studio.example/fwp/', 'https://studio.example/?key=test', 'https://studio.example/#login']) {
    expect(() => studioUrl(origin)).toThrow()
    expect(() => studioUrl(origin, 'workshop')).toThrow()
  }
})

it('opens and removes the workspace tab independently of the studio connection', async () => {
  vi.stubGlobal(STUDIO_URL_GLOBAL, 'https://muse.test/jingliu/')
  const ctx = new Context()
  onTestFinished(async () => { await ctx.fiber.dispose() })
  await ctx.plugin(SlotRegistry).await()
  ctx.provide('locale', new LocaleRuntime(ctx))
  ctx.locale.setLocale('zh')
  ctx.provide('sidebarRightTabs', new SidebarRightTabRegistry(ctx))
  const slots = ctx.get('slots') as SlotRegistry
  slots.register({ name: 'root', children: { 'sidebar.right.pane.tab': { kind: 'keyed', scope: 'session' } } } as never, () => null)

  const active = ctx.plugin(studio)
  await active.await()

  const list = createSnapshotStore({ items: [] })
  const create = vi.fn().mockResolvedValue({ workspaceId: 'new-workspace' })
  const openWorkspace = vi.fn().mockResolvedValue(undefined)
  ctx.provide('workspaces', { list, create })
  ctx.provide('uiWorkspace', { openWorkspace })
  await vi.waitFor(() => {
    expect(ctx.sidebarRightTabs.guide().map(entry => [entry.kind, entry.title()])).toEqual([['muse-workspace', '工作间']])
  })
  const entry = slots.entries('sidebar.right.pane.tab')[0]
  expect(entry?.options).toMatchObject({ key: ctx.sidebarRightTabs.get('muse-workspace')?.id })
  const injected = entry?.inject?.() as { addWorkspace(path: string): Promise<void> }
  await injected.addWorkspace('/workspace/story')
  expect(create).toHaveBeenCalledExactlyOnceWith({ path: '/workspace/story' })
  expect(openWorkspace).toHaveBeenCalledExactlyOnceWith('new-workspace')
  expect(ctx.sidebarRightTabs.guide()[0]?.description?.()).toBe(zh.workspaceTabDescription)

  const { hooks: { directoryFlow } } = entry?.inject?.() as {
    hooks: { directoryFlow: { getSnapshot(): boolean; subscribe(listener: () => void): () => void } }
  }
  const changed = vi.fn(() => directoryFlow.getSnapshot())
  onTestFinished(directoryFlow.subscribe(changed))
  expect(directoryFlow.getSnapshot()).toBe(false)
  const removePicker = slots.register({ name: 'workspace.environment.directoryFlow' }, () => null)
  await vi.waitFor(() => { expect(changed).toHaveLastReturnedWith(true) })
  removePicker()
  await vi.waitFor(() => { expect(changed).toHaveLastReturnedWith(false) })

  await active.dispose()
  expect(ctx.sidebarRightTabs.guide()).toHaveLength(0)
  expect(slots.entries('sidebar.right.pane.tab')).toHaveLength(0)
})

it('binds each iframe to its configured audience and replaces all open documents on account or connection changes', async () => {
  vi.stubGlobal(STUDIO_URL_GLOBAL, 'https://studio.test/fwp/v2/auth/muse/embed')
  vi.stubGlobal(WORKSHOP_URL_GLOBAL, 'https://workshop.test/v1/auth/muse/embed')
  const ctx = new Context()
  onTestFinished(async () => { await ctx.fiber.dispose() })
  await ctx.plugin(SlotRegistry).await()
  ctx.provide('locale', new LocaleRuntime(ctx))
  ctx.provide('sidebarRightTabs', new SidebarRightTabRegistry(ctx))
  const issueWorkbenchCode = vi.fn().mockResolvedValue({ ok: true, value: { code: 'temporary', accountId: 'private' } })
  const off = vi.fn()
  let accountChanged: () => void = () => { throw Error('not subscribed') }
  ctx.provide('remote', {
    $on: (key: string, callback: () => void) => {
      expect(key).toBe('muse-account/session-changed')
      accountChanged = callback
      return off
    },
    museAccount: { issueWorkbenchCode },
  })
  ctx.provide('remote.museAccount', { issueWorkbenchCode })
  const slots = ctx.get('slots') as SlotRegistry
  slots.register({ name: 'root', children: { 'sidebar.right.pane.tab': { kind: 'keyed', scope: 'session' } } } as never, () => null)
  const active = ctx.plugin(studio)
  await active.await()
  const panes = slots.entries('sidebar.right.pane.tab').map(entry => entry.inject?.() as {
    issueLogin(challenge: string): Promise<object>
    hooks: { loginGeneration: { getSnapshot(): number } }
  })
  expect(panes).toHaveLength(2)
  const initial = panes[0]!.hooks.loginGeneration.getSnapshot()
  await Promise.all(panes.map(async (pane) => { expect(await pane.issueLogin('challenge')).toEqual({ code: 'temporary' }) }))
  expect(issueWorkbenchCode.mock.calls).toEqual([[{ audience: 'jingliu', challenge: 'challenge' }], [{ audience: 'script-workshop', challenge: 'challenge' }]])
  issueWorkbenchCode
    .mockResolvedValueOnce({ ok: false, error: { code: 'muse-workbench/sign-in-required' } })
    .mockResolvedValueOnce({ ok: false, error: { code: 'gateway/internal' } })
  await expect(panes[0]!.issueLogin('challenge')).resolves.toEqual({ error: 'sign-in-required' })
  await expect(panes[1]!.issueLogin('challenge')).resolves.toEqual({ error: 'unavailable' })
  accountChanged()
  ctx.emit('connection/reset')
  expect(panes.map(pane => pane.hooks.loginGeneration.getSnapshot())).toEqual([initial + 2, initial + 2])
  await active.dispose()
  expect(off).toHaveBeenCalled()
  await expect(panes[0]!.issueLogin('challenge')).resolves.toEqual({ error: 'unavailable' })
  expect(issueWorkbenchCode).toHaveBeenCalledTimes(4)
})

type Provider = Parameters<Context['resources']['register']>[0]
type DrawerSlot = 'bot.drawer.data' | 'bot.drawer.scripts' | 'bot.drawer.jingliu'
type RemoteCall<Args extends unknown[], Value> = (...args: Args) => Promise<RemoteResult<Value>>

function NativeDrawer({ renderSlot }: PropsRenderSlots<DrawerSlot>) {
  const owner = { sessionId: SessionId('native-drawer'), quote: () => {}, compose: () => {} }
  return createElement(Fragment, null,
    renderSlot('bot.drawer.data', { ...owner, platform: null, openPlatform: () => {} }),
    renderSlot('bot.drawer.scripts', { ...owner, script: null, openScript: () => {} }),
    renderSlot('bot.drawer.jingliu', { ...owner, project: null, openProject: () => {} }),
  )
}

function hasProjectActions(face: unknown): face is Pick<ProductionActions, 'createProject' | 'chooseProject'> {
  return typeof face === 'object' && face !== null
    && 'createProject' in face && typeof face.createProject === 'function'
    && 'chooseProject' in face && typeof face.chooseProject === 'function'
}

async function setup() {
  vi.stubGlobal(STUDIO_URL_GLOBAL, 'https://muse.test/jingliu/')
  const ctx = new Context()
  onTestFinished(async () => { await ctx.fiber.dispose() })
  await ctx.plugin(SlotRegistry).await()
  ctx.provide('locale', new LocaleRuntime(ctx))
  ctx.provide('sidebarRightTabs', new SidebarRightTabRegistry(ctx))
  const slots = ctx.get('slots') as SlotRegistry
  slots.register({ name: 'root', children: {
    'bot.drawer.data': { kind: 'single', scope: 'root' },
    'bot.drawer.scripts': { kind: 'single', scope: 'root' },
    'bot.drawer.jingliu': { kind: 'single', scope: 'root' },
    'bot.drawer.assets': { kind: 'single', scope: 'root' },
    'character-library.shared': { kind: 'single', scope: 'root' },
    'settings.section': { kind: 'list', scope: 'root' },
    'sidebar.footer.action': { kind: 'list', scope: 'root' },
  } }, NativeDrawer)

  const providers = new Map<Provider['protocol'], Provider>()
  const listeners = new Set<() => void>()
  const remote = {
    $mount: async () => () => {},
    $on: (_event: string, listener: () => void) => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
  }
  ctx.provide('remote', remote)
  ctx.provide('resources', { register: (provider: Provider) => {
    const protocol = provider.protocol
    providers.set(protocol, provider)
    return () => { providers.delete(protocol) }
  } })
  ctx.provide('layout', {})
  ctx.provide('sessions', {})
  ctx.provide('conversation', {})
  const plugin = ctx.plugin(studio)
  await plugin.await()

  const bind = (namespace: 'museAccount' | 'workshopConnection' | 'jingliuConnection', api: object) => {
    Object.assign(remote, { [namespace]: api })
    ctx.provide('remote.' + namespace, api)
  }
  const accountChanged = () => { for (const notify of listeners) notify() }
  const read = async (protocol: Provider['protocol'], query = '', signal = new AbortController().signal) => {
    const provider = providers.get(protocol)
    if (!provider) throw new Error('Resource is not registered: ' + protocol)
    const frames = []
    for await (const frame of provider.open('dsh-resource://' + protocol + '/current?' + query, { signal })) frames.push(frame)
    return frames
  }
  return { slots, providers, bind, accountChanged, read, dispose: async () => { await plugin.dispose() } }
}

const failure = { ok: false, error: new RemoteError('gateway/internal', 'Host unavailable', {}) } as const

function unavailable() {
  return vi.fn<(...args: unknown[]) => Promise<typeof failure>>().mockResolvedValue(failure)
}

it('shares the signed-in studio library across both asset views and removes its entries on disposal', async () => {
  const m = await setup()
  m.bind('museAccount', {})
  m.bind('jingliuConnection', {})
  const assetSlots = ['character-library.shared', 'bot.drawer.assets'] as const
  const studioSlots = ['settings.section', 'sidebar.footer.action'] as const
  const occupied = [...assetSlots, ...studioSlots]
  await vi.waitFor(() => {
    for (const slot of occupied) expect(m.slots.entries(slot)).toHaveLength(1)
  })
  const epochs = assetSlots.map((slot) => {
    const face = m.slots.entries(slot)[0]?.inject?.() as { hooks: { accountEpoch: { getSnapshot(): number } } }
    return face.hooks.accountEpoch
  })
  expect(epochs[0]).toBe(epochs[1])
  const initial = epochs[0]?.getSnapshot()
  m.accountChanged()
  expect(epochs[0]?.getSnapshot()).toBeGreaterThan(initial!)
  const settings = m.slots.entries('settings.section')[0]?.options
  expect(settings?.id).toBe('jingliu')
  expect(resolveSlotLabel(settings?.label)).toBe(en.studioSettings)
  expect(m.slots.entries('sidebar.footer.action')[0]?.options.id).toBe('jingliu-credit')
  await m.dispose()
  for (const slot of occupied) expect(m.slots.entries(slot)).toHaveLength(0)
})

it('registers Data Station only when the account arrives and decodes work and board addresses', async () => {
  const m = await setup()
  expect(m.providers.has('muse-data-boards')).toBe(false)
  expect(m.slots.entries('bot.drawer.data')).toHaveLength(0)
  const boards = { ok: true, value: { boards: ['New releases'], defaultBoard: 'New releases' } } as const
  const dataBoards = vi.fn<(platform: string) => Promise<typeof boards>>().mockResolvedValue(boards)
  const dataWork = unavailable()
  m.bind('museAccount', { dataBoards, dataWork })
  await vi.waitFor(() => { expect(m.slots.entries('bot.drawer.data')).toHaveLength(1) })
  for (const platform of ['hongguo', 'lvpaopao', 'douyin', 'fanqie', 'qimao']) {
    await expect(m.read('muse-data-boards', 'platform=' + platform)).resolves.toEqual([boards])
    expect(dataBoards).toHaveBeenLastCalledWith(platform)
  }
  await expect(m.read('muse-data-boards', 'platform=outside')).rejects.toThrow('Unknown data platform')
  const aborted = new AbortController()
  aborted.abort()
  await expect(m.read('muse-data-boards', 'platform=outside', aborted.signal)).resolves.toEqual([])
  expect(dataBoards).toHaveBeenCalledTimes(5)
  await expect(m.read('muse-data-work', 'id=fanqie%3Awith+space')).resolves.toEqual([failure])
  expect(dataWork).toHaveBeenCalledExactlyOnceWith('fanqie:with space')
  await m.dispose()
  expect(m.providers.size).toBe(0)
  expect(m.slots.entries('bot.drawer.data')).toHaveLength(0)
})

it('normalizes Data Station ranking, stock and collection filters and forwards Rush failures', async () => {
  const m = await setup()
  const dataPeriod = unavailable()
  const dataStock = unavailable()
  const dataWorks = unavailable()
  const dataCollector = unavailable()
  const dataRush = vi.fn<RemoteCall<[workId: string], MuseDataRush>>()
    .mockResolvedValueOnce({ ok: true, value: { workId: 'work-1', state: 'queued', lane: 'manual' } })
    .mockResolvedValueOnce(failure)
  m.bind('museAccount', { dataPeriod, dataStock, dataWorks, dataCollector, dataRush })
  await vi.waitFor(() => { expect(m.slots.entries('bot.drawer.data')).toHaveLength(1) })

  for (const [value, period] of [['day', 'day'], ['month', 'month'], ['', 'week']] as const) {
    await expect(m.read('muse-data-period', 'period=' + value + '&platform=douyin&board=New+Releases')).resolves.toEqual([failure])
    expect(dataPeriod).toHaveBeenLastCalledWith({ platform: 'douyin', board: 'New Releases', period })
  }
  for (const [supplied, filter] of [['script', 'script'], ['active', 'active'], ['queued', 'queued'],
    ['failed', 'failed'], ['rejected', 'rejected'], ['other', 'all']] as const) {
    await expect(m.read('muse-data-stock', 'filter=' + supplied + '&q=night+market&page=-2&limit=150')).resolves.toEqual([failure])
    expect(dataStock).toHaveBeenLastCalledWith({ filter, q: 'night market', page: 1, limit: 100 })
  }
  await m.read('muse-data-stock')
  expect(dataStock).toHaveBeenLastCalledWith({ filter: 'all', q: '', page: 1, limit: 50 })
  await expect(m.read('muse-data-works', 'platform=qimao&page=3&limit=-8')).resolves.toEqual([failure])
  expect(dataWorks).toHaveBeenLastCalledWith({ platform: 'qimao', q: '', page: 3, limit: 1 })
  await m.read('muse-data-works', 'platform=qimao&q=archive')
  expect(dataWorks).toHaveBeenLastCalledWith({ platform: 'qimao', q: 'archive', page: 1, limit: 20 })
  await expect(m.read('muse-data-collector')).resolves.toEqual([failure])
  expect(dataCollector).toHaveBeenCalledExactlyOnceWith()

  const data = m.slots.entries('bot.drawer.data')[0]?.inject?.() as Pick<DrawerDataProps, 'rush'>
  await expect(data.rush('work-1')).resolves.toBeUndefined()
  await expect(data.rush('work-2')).rejects.toBe(failure.error)
  expect(dataRush.mock.calls).toEqual([['work-1'], ['work-2']])
})

it('passes Workshop list, version and draft history addresses through to the selected account', async () => {
  const m = await setup()
  const scripts = unavailable()
  const script = unavailable()
  const scriptDrafts = unavailable()
  const scriptDraft = unavailable()
  const scriptDraftEpisode = unavailable()
  const scriptDraftStoryboard = unavailable()
  const scriptDraftHistory = unavailable()
  const scriptDraftHistoryEntry = unavailable()
  m.bind('workshopConnection', {
    scripts, script, scriptDrafts, scriptDraft, scriptDraftEpisode, scriptDraftStoryboard, scriptDraftHistory, scriptDraftHistoryEntry,
  })
  await vi.waitFor(() => { expect(m.slots.entries('bot.drawer.scripts')).toHaveLength(1) })

  for (const status of ['waiting', 'picked', 'in_production']) {
    await expect(m.read('workshop-scripts', 'status=' + status + '&q=first+draft&mine=1&page=2&limit=500')).resolves.toEqual([failure])
    expect(scripts).toHaveBeenLastCalledWith({ status, q: 'first draft', mine: true, page: 2, limit: 100 })
  }
  await m.read('workshop-scripts', 'status=other')
  expect(scripts).toHaveBeenLastCalledWith({ q: '', mine: false, page: 1, limit: 50 })
  await m.read('workshop-script', 'id=42&version=3')
  expect(script).toHaveBeenLastCalledWith({ id: 42, version: 3 })
  await m.read('workshop-script', 'id=42&version=1.5')
  expect(script).toHaveBeenLastCalledWith({ id: 42 })
  await expect(m.read('workshop-drafts', 'query=Night+market&offset=15&limit=30')).resolves.toEqual([failure])
  expect(scriptDrafts).toHaveBeenCalledExactlyOnceWith({ query: 'Night market', offset: 15, limit: 30 })
  await expect(m.read('workshop-draft', 'id=45')).resolves.toEqual([failure])
  expect(scriptDraft).toHaveBeenCalledExactlyOnceWith({ draftId: 45 })
  const episodeReads = [['workshop-draft-episode', scriptDraftEpisode], ['workshop-draft-storyboard', scriptDraftStoryboard]] as const
  for (const [protocol, call] of episodeReads) {
    await expect(m.read(protocol, 'id=45&episode=2')).resolves.toEqual([failure])
    expect(call).toHaveBeenCalledExactlyOnceWith({ draftId: 45, episode: 2 })
  }
  await m.read('workshop-draft-history', 'id=45&episode=2&layer=storyboard')
  expect(scriptDraftHistory).toHaveBeenCalledExactlyOnceWith({ draftId: 45, episode: 2, layer: 'storyboard' })
  await m.read('workshop-draft-history-entry', 'id=45&episode=2&row=8')
  expect(scriptDraftHistoryEntry).toHaveBeenCalledExactlyOnceWith({ draftId: 45, episode: 2, layer: 'chapter', historyId: 8 })
})

it('forwards a new Workshop draft only while its author remains signed in', async () => {
  const m = await setup()
  const created = { ok: true, value: {
    id: 45, title: 'Night market', status: 'created', episodeCount: 1, updatedAt: null, revision: 'draft-1',
    canFinalize: false, episodes: [{ episode: 1, title: 'Opening' }], context: { outline: null, storyBible: null },
  } } as const
  const pending = Promise.withResolvers<typeof created>()
  const createScriptDraft = vi.fn<RemoteCall<[request: ScriptDraftCreateRequest], ScriptDraft>>()
    .mockResolvedValueOnce(created)
    .mockReturnValueOnce(pending.promise)
  m.bind('museAccount', {})
  m.bind('workshopConnection', { createScriptDraft })
  await vi.waitFor(() => { expect(m.slots.entries('bot.drawer.scripts')).toHaveLength(1) })
  const { draftActions } = m.slots.entries('bot.drawer.scripts')[0]?.inject?.() as { draftActions: DraftActions }
  const request = { title: 'Night market', episodeCount: 1 }
  await expect(draftActions.createDraft(request)).resolves.toEqual(created.value)
  const oldAccount = draftActions.createDraft(request)
  m.accountChanged()
  pending.resolve(created)
  await expect(oldAccount).rejects.toThrow('Workshop account changed')
  expect(createScriptDraft.mock.calls).toEqual([[request], [request]])
})

it('routes Workshop episode decisions, finalization and project links through the registered account actions', async () => {
  const m = await setup()
  const save = { draftId: 45, episode: 2, baseRevision: 'episode-1', content: 'An empty market.' }
  const review = { draftId: 45, episode: 2, candidateId: 'night-market-candidate' }
  const publish: ScriptDraftFinalizeRequest = { draftId: 45, baseRevision: 'draft-3', rights: 'original', kind: 'drama', style: 'realistic' }
  const episode: ScriptDraftEpisode = {
    draftId: save.draftId, episode: save.episode, title: 'Night market', revision: 'episode-2', version: 2, content: save.content, candidate: null,
  }
  const script: ScriptSummary = {
    id: 65, title: 'Night market', owner: { id: 17, name: 'Writer' }, rights: publish.rights,
    originWorkId: null, originTitle: null, kind: publish.kind, style: publish.style, episodes: 2, words: 1000,
    status: 'waiting', latestVersion: 1, picked: null, project: null, createdAt: null, updatedAt: null,
  }
  const written = { ok: true, value: episode } as const
  const pending = Promise.withResolvers<typeof written>()
  const api = {
    saveScriptDraftEpisode: vi.fn().mockResolvedValue(written),
    applyScriptDraftCandidate: unavailable(),
    discardScriptDraftCandidate: vi.fn().mockReturnValue(pending.promise),
    finalizeScriptDraft: vi.fn().mockResolvedValue({ ok: true, value: script }),
    pickScript: unavailable(),
    scriptProduction: vi.fn().mockResolvedValue({ ok: true, value: script }),
  }
  m.bind('museAccount', {})
  m.bind('workshopConnection', api)
  await vi.waitFor(() => { expect(m.slots.entries('bot.drawer.scripts')).toHaveLength(1) })
  const actions = m.slots.entries('bot.drawer.scripts')[0]?.inject?.() as Pick<DrawerScriptsProps, 'draftActions' | 'pick' | 'link'>

  await expect(actions.draftActions.saveEpisode(save)).resolves.toBe(episode)
  await expect(actions.draftActions.applyCandidate(review)).rejects.toBe(failure.error)
  await expect(actions.draftActions.finalizeDraft(publish)).resolves.toBe(script)
  const pick = { id: script.id, version: script.latestVersion }
  const link = { id: script.id, projectId: 'night-production', projectTitle: 'Night market production' }
  await expect(actions.pick(pick)).rejects.toBe(failure.error)
  await expect(actions.link(link)).resolves.toBeUndefined()

  const oldAccount = actions.draftActions.discardCandidate(review)
  expect(api.discardScriptDraftCandidate).toHaveBeenCalledExactlyOnceWith(review)
  m.accountChanged()
  pending.resolve(written)
  await expect(oldAccount).rejects.toThrow('Workshop account changed')
  expect(api.saveScriptDraftEpisode).toHaveBeenCalledExactlyOnceWith(save)
  expect(api.applyScriptDraftCandidate).toHaveBeenCalledExactlyOnceWith(review)
  expect(api.finalizeScriptDraft).toHaveBeenCalledExactlyOnceWith(publish)
  expect(api.pickScript).toHaveBeenCalledExactlyOnceWith(pick)
  expect(api.scriptProduction).toHaveBeenCalledExactlyOnceWith(link)
})

it('keeps embedded thumbnails and serves local image paths from the current Host', async () => {
  const m = await setup()
  const inline = 'data:image/png;base64,AA=='
  const path = '/work/scene+1/夜 #1.png'
  const thumbnail = vi.fn<RemoteCall<[path: string, signal: AbortSignal], StudioImage>>()
    .mockResolvedValueOnce({ ok: true, value: { kind: 'inline', url: inline } })
    .mockResolvedValueOnce({ ok: true, value: { kind: 'file', path } })
    .mockResolvedValueOnce(failure)
  m.bind('jingliuConnection', { thumbnail })
  await vi.waitFor(() => { expect(m.slots.entries('bot.drawer.jingliu')).toHaveLength(1) })

  const signal = new AbortController().signal
  await expect(m.read('jingliu-image', 'path=%2Ffw%2Fcover.png', signal)).resolves.toEqual([{ ok: true, value: inline }])
  expect(thumbnail).toHaveBeenLastCalledWith('/fw/cover.png', signal)
  const local = new URL('api/file', document.baseURI)
  local.searchParams.set('path', path)
  await expect(m.read('jingliu-image', 'path=%2Ffw%2Flocal.png', signal)).resolves.toEqual([{ ok: true, value: local.href }])
  await expect(m.read('jingliu-image', '', signal)).resolves.toEqual([failure])
  expect(thumbnail).toHaveBeenLastCalledWith('', signal)
})

it('forwards Jingliu resource addresses and the registry signal to the corresponding Host reads', async () => {
  const m = await setup()
  const api = {
    listProjects: unavailable(),
    balance: unavailable(),
    projectOptions: unavailable(),
    preferences: unavailable(),
    projectConfig: unavailable(),
    episodeList: unavailable(),
    episodeShots: unavailable(),
    shotMedia: unavailable(),
    catalog: unavailable(),
    projectAssets: unavailable(),
    sharedAssets: unavailable(),
  }
  m.bind('jingliuConnection', api)
  await vi.waitFor(() => { expect(m.slots.entries('bot.drawer.jingliu')).toHaveLength(1) })
  const signal = new AbortController().signal
  const reads = [
    ['jingliu-projects', '', api.listProjects, []],
    ['jingliu-credit', '', api.balance, []],
    ['jingliu-options', '', api.projectOptions, ['']],
    ['jingliu-prefs', 'id=night+market', api.preferences, ['night market']],
    ['jingliu-config', 'id=p1', api.projectConfig, ['p1']],
    ['jingliu-episodes', 'id=p1', api.episodeList, ['p1']],
    ['jingliu-shots', 'id=p1&episode=12', api.episodeShots, ['p1', 12]],
    ['jingliu-shot-media', 'id=p1&shot=s%2F3', api.shotMedia, ['p1', 's/3']],
    ['jingliu-catalog', '', api.catalog, []],
    ['jingliu-project-assets', 'id=p1', api.projectAssets, ['p1']],
  ] as const
  for (const [protocol, query, call, request] of reads) {
    await expect(m.read(protocol, query, signal)).resolves.toEqual([failure])
    expect(call).toHaveBeenCalledExactlyOnceWith(...request, signal)
  }
  await expect(m.read('jingliu-prefs', '', signal)).resolves.toEqual([failure])
  expect(api.preferences).toHaveBeenLastCalledWith('', signal)
  for (const kind of ['character', 'location', 'prop']) {
    await m.read('jingliu-library', 'kind=' + kind + '&query=night+market&offset=24', signal)
    expect(api.sharedAssets).toHaveBeenLastCalledWith({ kind, query: 'night market', offset: 24 }, signal)
  }
  await expect(m.read('jingliu-library', 'kind=video', signal)).resolves.toEqual([failure])
  expect(api.sharedAssets).toHaveBeenLastCalledWith({ kind: 'all', query: '', offset: 0 }, signal)
})

it('publishes Jingliu selection changes and surfaces watcher failures only while the resource is owned', async () => {
  const m = await setup()
  const selected = { id: 'p1', title: 'Night market' }
  const disconnected = new Error('Host unavailable')
  const refused = new RemoteError('gateway/bad-request', 'Selection cannot be read', {})
  const watchProject = vi.fn<(id: SessionId, signal: AbortSignal) => AsyncIterable<SelectedProject | null>>()
    .mockImplementationOnce(async function* () { yield null; yield selected })
    .mockImplementationOnce(async function* () { throw refused })
    .mockImplementationOnce(async function* () { yield null })
    .mockImplementation(async function* () { throw disconnected })
  m.bind('jingliuConnection', { watchProject })
  await vi.waitFor(() => { expect(m.slots.entries('bot.drawer.jingliu')).toHaveLength(1) })

  const signal = new AbortController().signal
  await expect(m.read('jingliu-selected', 'id=scene+work', signal)).resolves.toEqual([
    { ok: true, value: null }, { ok: true, value: selected },
  ])
  expect(watchProject).toHaveBeenCalledExactlyOnceWith('scene work', signal)
  await expect(m.read('jingliu-selected', 'id=scene+work', signal)).resolves.toEqual([{ ok: false, error: refused }])
  await expect(m.read('jingliu-selected', '', signal)).resolves.toEqual([{ ok: true, value: null }])
  expect(watchProject).toHaveBeenLastCalledWith('', signal)
  await expect(m.read('jingliu-selected', 'id=scene+work', signal)).resolves.toMatchObject([
    { ok: false, error: { code: 'gateway/internal', cause: disconnected } },
  ])
  await expect(m.read('jingliu-selected', 'id=scene+work', AbortSignal.abort())).resolves.toEqual([])
})

const firstSession = SessionId('first bot')
const secondSession = SessionId('second bot')
const bridge = { id: 'p1', title: 'Paper Bridge' }
const harbor = { id: 'p2', title: 'Old Harbor' }
const projects: StudioProject[] = [bridge, harbor].map(item => ({
  ...item, episodes: 1, shots: 0, completed: 0, role: 'owner', thumbnail: '',
  mode: 'drama', aspect: '9:16', createdAt: '', profile: { videoModel: '', generationMode: '', resolution: '' },
}))
const catalog: StudioCatalog = { modes: [], aspects: [], resolutions: [], imageModels: [], videoModels: [], generationModes: [] }

function SelectionRefreshFrame({ renderSlot }: PropsRenderSlots<'bot.drawer.jingliu'>) {
  const owner = { project: null, openProject: () => {}, quote: () => {}, compose: () => {} }
  return createElement(Fragment, null,
    createElement('section', { 'aria-label': 'First conversation' },
      renderSlot('bot.drawer.jingliu', { ...owner, sessionId: firstSession })),
    createElement('section', { 'aria-label': 'Second conversation' },
      renderSlot('bot.drawer.jingliu', { ...owner, sessionId: secondSession })))
}

function released(signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) resolve()
    else signal.addEventListener('abort', () => { resolve() }, { once: true })
  })
}

it('reopens the failed conversation watch and discards an old account frame after a reset', async () => {
  const runtime = await SlotTestRuntime.create()
  onTestFinished(async () => { await runtime.dispose() })
  vi.stubGlobal(STUDIO_URL_GLOBAL, 'https://muse.test/jingliu/')
  const locale = new LocaleRuntime(runtime.ctx)
  locale.setLocale('en')
  runtime.ctx.provide('locale', locale)
  runtime.slots.installLocale(locale)
  runtime.ctx.provide('sidebarRightTabs', new SidebarRightTabRegistry(runtime.ctx))
  runtime.ctx.provide('layout', {})
  runtime.ctx.provide('conversation', {})
  await runtime.mount(resources)
  vi.spyOn(runtime.remote, '$mount').mockResolvedValue(async () => {})

  const opens = new Map<SessionId, AbortSignal[]>()
  const lateFrame = vi.fn()
  const watchProject = async function* (id: SessionId, signal: AbortSignal): AsyncGenerator<SelectedProject | null> {
    const history = opens.get(id) ?? []
    opens.set(id, history)
    const attempt = history.push(signal)
    if (id === firstSession && attempt === 1) throw new RemoteError('gateway/internal', 'Watch unavailable', {})
    yield id === firstSession && attempt === 2 ? bridge : id === secondSession && attempt === 1 ? harbor : null
    await released(signal)
    if (id === firstSession && attempt === 2) {
      lateFrame()
      yield harbor
    }
  }
  const selectProject = vi.fn()
  runtime.remote.provideNamespaces({ jingliuConnection: {
    watchProject, selectProject, listProjects: async () => ({ ok: true, value: projects }),
    catalog: async () => ({ ok: true, value: catalog }),
  } })
  await runtime.root.declare({ 'bot.drawer.jingliu': { kind: 'single', scope: 'root' } }, SelectionRefreshFrame)
  await runtime.mount(studio)
  await waitFor(() => { expect(runtime.slots.entries('bot.drawer.jingliu')).toHaveLength(1) })

  const app = runtime.renderRoot()
  const first = within(app.getByRole('region', { name: 'First conversation' }))
  const second = within(app.getByRole('region', { name: 'Second conversation' }))
  const failure = within(await first.findByRole('alert'))
  expect(failure.getByText(en.failed)).toBeTruthy()
  expect((await second.findByRole('button', { name: /Old Harbor.*Current/u })).textContent).toContain(en.tiedProject)
  const firstOpen = opens.get(firstSession)?.[0]
  const secondOpen = opens.get(secondSession)?.[0]
  expect(firstOpen?.aborted).toBe(false)
  expect(secondOpen?.aborted).toBe(false)

  fireEvent.click(failure.getByRole('button', { name: en.refresh }))
  expect(await first.findByRole('button', { name: /Paper Bridge.*Current/u })).toBeTruthy()
  expect(first.queryByRole('alert')).toBeNull()
  expect(opens.get(firstSession)).toHaveLength(2)
  expect(firstOpen?.aborted).toBe(true)
  expect(opens.get(secondSession)).toEqual([secondOpen])
  expect(secondOpen?.aborted).toBe(false)
  expect(second.getByRole('button', { name: /Old Harbor.*Current/u })).toBeTruthy()

  const restarted = opens.get(firstSession)?.[1]
  await act(async () => { runtime.remote.emit('muse-account/session-changed', []) })
  expect(await first.findByRole('button', { name: /Paper Bridge/u })).toBeTruthy()
  expect(await second.findByRole('button', { name: /Old Harbor/u })).toBeTruthy()
  expect(restarted?.aborted).toBe(true)
  expect(secondOpen?.aborted).toBe(true)
  expect(opens.get(firstSession)).toHaveLength(3)
  expect(opens.get(secondSession)).toHaveLength(2)
  expect(lateFrame).toHaveBeenCalledTimes(1)
  expect(first.queryByRole('button', { name: /Current/u })).toBeNull()
  expect(second.queryByRole('button', { name: /Current/u })).toBeNull()
  expect(selectProject).not.toHaveBeenCalled()
})

it('binds a created project to its conversation and drops the result when the Studio account changes', async () => {
  const m = await setup()
  const selected = { id: 'p1', title: 'Night market' }
  const created = { ok: true, value: selected } as const
  const oldAccount = Promise.withResolvers<typeof created>()
  const createProject = vi.fn<RemoteCall<[input: StudioNewProject, signal: AbortSignal], SelectedProject>>()
    .mockResolvedValueOnce(created)
    .mockReturnValueOnce(oldAccount.promise)
    .mockResolvedValueOnce(failure)
  const selectProject = vi.fn<RemoteCall<[id: SessionId, project: string, signal: AbortSignal], SelectedProject>>()
    .mockResolvedValueOnce(created)
    .mockResolvedValueOnce(failure)
  m.bind('jingliuConnection', { createProject, selectProject })
  await vi.waitFor(() => { expect(m.slots.entries('bot.drawer.jingliu')).toHaveLength(1) })
  const actions = m.slots.entries('bot.drawer.jingliu')[0]?.inject?.()
  if (!hasProjectActions(actions)) throw new Error('Jingliu project actions are not registered')
  const session = SessionId('scene-work')
  const input = {
    title: selected.title, mode: 'drama', artStyle: '3d', aspect: '16:9', resolution: '720p',
    videoModel: '', imageModel: '', generationMode: '',
  }
  await expect(actions.createProject(session, input)).resolves.toEqual(selected)
  expect(createProject).toHaveBeenCalledExactlyOnceWith(input, expect.any(AbortSignal))
  expect(selectProject).toHaveBeenCalledExactlyOnceWith(session, selected.id, expect.any(AbortSignal))

  const creating = actions.createProject(session, input)
  m.accountChanged()
  oldAccount.resolve(created)
  await expect(creating).rejects.toThrow('Studio account changed')
  await expect(actions.createProject(session, input)).rejects.toBe(failure.error)
  expect(selectProject).toHaveBeenCalledOnce()
  await expect(actions.chooseProject(session, selected)).rejects.toBe(failure.error)
  expect(selectProject).toHaveBeenCalledTimes(2)
})

async function installProductionActions(api: object) {
  const m = await setup()
  m.bind('jingliuConnection', api)
  await vi.waitFor(() => { expect(m.slots.entries('bot.drawer.jingliu')).toHaveLength(1) })
  const actions = m.slots.entries('bot.drawer.jingliu')[0]?.inject?.() as ProductionActions | undefined
  if (actions === undefined) throw new Error('Jingliu project actions are not registered')
  return { m, actions }
}

it('keeps a live catalog transport fault observable and releases the canceled owner without a late error', async () => {
  const socketError = new Error('Catalog transport lost')
  const started = Promise.withResolvers<AbortSignal>()
  const read = vi.fn<RemoteCall<[AbortSignal], StudioProject[]>>()
    .mockRejectedValueOnce(socketError)
    .mockImplementationOnce(async (signal) => {
      started.resolve(signal)
      await released(signal)
      throw new DOMException('Catalog read canceled', 'AbortError')
    })
  const { m, actions } = await installProductionActions({ listProjects: read })
  await expect(m.read('jingliu-projects')).rejects.toBe(socketError)
  const controller = new AbortController()
  const pending = m.read('jingliu-projects', '', controller.signal)
  try {
    expect(await started.promise).toBe(controller.signal)
  } finally { controller.abort() }
  await expect(pending).resolves.toEqual([])

  const epoch = actions.hooks.accountEpoch
  const before = epoch.getSnapshot()
  m.accountChanged()
  expect(epoch.getSnapshot()).toBeGreaterThan(before)
  const after = epoch.getSnapshot()
  await m.dispose()
  expect(m.slots.entries('bot.drawer.jingliu')).toHaveLength(0)
  expect(m.providers.has('jingliu-projects')).toBe(false)
  m.accountChanged()
  expect(epoch.getSnapshot()).toBe(after)
})

it('uses the authenticated workspace video route or streams the exact browser video bytes', async () => {
  const file = 'E:\\Productions\\Paper Bridge\\rough + final.mp4'
  const request: StudioVideoRequest = { sessionId: SessionId('Bridge + ending'), projectId: 'p2', path: '/fw/media/ending.mp4' }
  const localVideo = vi.fn<RemoteCall<[StudioVideoRequest, AbortSignal], string | null>>()
    .mockResolvedValueOnce(failure).mockResolvedValueOnce({ ok: true, value: file }).mockResolvedValue({ ok: true, value: null })
  const video = vi.fn<(path: string, signal: AbortSignal) => AsyncIterable<string>>()
    .mockImplementationOnce(async function* () { yield* ['video/mp4', 'AQID', '/4A='] })
    .mockImplementationOnce(async function* () { yield* [] })
  const { actions } = await installProductionActions({ localVideo, video })
  const signal = new AbortController().signal
  await expect(actions.loadVideo(request, signal)).rejects.toBe(failure.error)
  const local = new URL(await actions.loadVideo(request, signal))
  expect(local.pathname).toBe('/api/video')
  expect(local.searchParams.get('sessionId')).toBe(request.sessionId)
  expect(local.searchParams.get('path')).toBe(file)
  expect(video).not.toHaveBeenCalled()

  const createObjectURL = vi.fn<(blob: Blob) => string>().mockReturnValue('blob:muse-episode')
  vi.stubGlobal('URL', Object.assign(class extends URL {}, { createObjectURL }))
  await expect(actions.loadVideo(request, signal)).resolves.toBe('blob:muse-episode')
  expect(video).toHaveBeenCalledExactlyOnceWith(request.path, signal)
  const blob = createObjectURL.mock.calls[0]?.[0]
  if (!blob) throw new Error('Browser playback did not create a video blob')
  const original = await new Promise<string | ArrayBuffer | null>((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => { resolve(reader.result) }
    reader.onerror = () => { reject(reader.error ?? new Error('Browser video blob could not be read')) }
    reader.readAsDataURL(blob)
  })
  expect(original).toBe('data:video/mp4;base64,AQID/4A=')
  await expect(actions.loadVideo(request, signal)).rejects.toThrow('Studio video was empty')
  expect(localVideo.mock.calls.every(([payload, passed]) => payload === request && passed === signal)).toBe(true)
  expect(createObjectURL).toHaveBeenCalledTimes(1)
})

it('keeps the project and shot identifiers on Host writes and requires acknowledgement of the requested preference', async () => {
  const wrote = { ok: true, value: null } as const
  const preference: StudioPreferences = { projectId: 'p4', hidePromptChips: true }
  const renameProject = vi.fn().mockResolvedValueOnce(failure).mockResolvedValueOnce(wrote)
  const deleteShot = vi.fn().mockResolvedValueOnce(failure).mockResolvedValueOnce(wrote)
  const saveOption = vi.fn().mockResolvedValueOnce(failure).mockResolvedValueOnce(wrote)
  const savePreferences = vi.fn<RemoteCall<[StudioPreferences], StudioPreferences>>()
    .mockResolvedValueOnce(failure)
    .mockResolvedValueOnce({ ok: true, value: { ...preference, hidePromptChips: false } })
    .mockResolvedValueOnce({ ok: true, value: preference })
  const { actions } = await installProductionActions({ renameProject, deleteShot, saveOption, savePreferences })
  await expect(actions.renameProject('p4', 'Lantern Bridge')).rejects.toBe(failure.error)
  await expect(actions.renameProject('p4', 'Lantern Bridge')).resolves.toBeUndefined()
  expect(renameProject).toHaveBeenLastCalledWith('p4', 'Lantern Bridge', expect.any(AbortSignal))
  await expect(actions.deleteShot('p4', 'shot-17')).rejects.toBe(failure.error)
  await expect(actions.deleteShot('p4', 'shot-17')).resolves.toBeUndefined()
  expect(deleteShot).toHaveBeenLastCalledWith('p4', 'shot-17', expect.any(AbortSignal))
  await expect(actions.saveOption('p4', 'resolution', '720p')).rejects.toBe(failure.error)
  await expect(actions.saveOption('p4', 'resolution', '720p')).resolves.toBeUndefined()
  expect(saveOption).toHaveBeenLastCalledWith('p4', 'resolution', '720p')
  await expect(actions.savePreferences(preference)).rejects.toBe(failure.error)
  await expect(actions.savePreferences(preference)).rejects.toThrow('Studio preference was not saved')
  await expect(actions.savePreferences(preference)).resolves.toBeUndefined()
  expect(savePreferences.mock.calls).toEqual([[preference], [preference], [preference]])
})

it('rejects an unlinked creation and ignores a project selection reply from an earlier sign-in', async () => {
  const newProject = { id: 'p8', title: 'Lantern Bridge' }
  const expected = { ok: true, value: newProject } as const
  const previousAccount = Promise.withResolvers<typeof expected>()
  const createProject = vi.fn<RemoteCall<[StudioNewProject, AbortSignal], SelectedProject>>().mockResolvedValue(expected)
  const selectProject = vi.fn<RemoteCall<[SessionId, string, AbortSignal], SelectedProject>>()
    .mockResolvedValueOnce(failure).mockReturnValueOnce(previousAccount.promise).mockResolvedValueOnce(expected)
  const { m, actions } = await installProductionActions({ createProject, selectProject })
  const sessionId = SessionId('creation-recovery')
  const input: StudioNewProject = { title: newProject.title, mode: 'drama', artStyle: 'city', aspect: '9:16', resolution: '720p',
    videoModel: '', imageModel: '', generationMode: '' }
  await expect(actions.createProject(sessionId, input)).rejects.toBe(failure.error)
  expect(selectProject).toHaveBeenCalledExactlyOnceWith(sessionId, newProject.id, expect.any(AbortSignal))

  const stale = actions.chooseProject(sessionId, newProject)
  m.accountChanged()
  previousAccount.resolve(expected)
  await expect(stale).rejects.toThrow('Studio account changed')
  await expect(actions.chooseProject(sessionId, newProject)).resolves.toBeUndefined()
  expect(selectProject).toHaveBeenCalledTimes(3)
})

it('keeps the Workshop episode revision on storyboard edits and withholds an old account download', async () => {
  const m = await setup()
  const storyboard: ScriptDraftStoryboard = { draftId: 45, episode: 2, title: 'Bridge', revision: 'board-2', version: 2,
    shotsJson: '[{"scene_no":1}]', exists: true, stale: false }
  const history = { ...storyboard, shotsJson: '[{"scene_no":3}]', revision: 'board-3', version: 3 }
  const file = { ok: true, value: { filename: 'bridge.md', mime: 'text/markdown', base64: 'QnJpZGdl' } } as const
  const pending = Promise.withResolvers<typeof file>()
  const saveScriptDraftStoryboard = vi.fn<RemoteCall<[ScriptDraftStoryboardSaveRequest], ScriptDraftStoryboard>>()
    .mockResolvedValueOnce(failure).mockResolvedValueOnce({ ok: true, value: storyboard })
  const restoreScriptDraftHistory = vi.fn<RemoteCall<[ScriptDraftHistoryRestoreRequest], ScriptDraftHistoryRestore>>()
    .mockResolvedValueOnce({ ok: true, value: { episode: null, storyboard: history } })
  const exportScriptDraft = vi.fn<RemoteCall<[ScriptDraftExportRequest], ScriptDraftExport>>()
    .mockReturnValueOnce(pending.promise).mockResolvedValueOnce(failure)
  m.bind('museAccount', {})
  m.bind('workshopConnection', { saveScriptDraftStoryboard, restoreScriptDraftHistory, exportScriptDraft })
  await vi.waitFor(() => { expect(m.slots.entries('bot.drawer.scripts')).toHaveLength(1) })
  const { draftActions } = m.slots.entries('bot.drawer.scripts')[0]?.inject?.() as { draftActions: DraftActions }
  const episode = { draftId: 45, episode: 2 } as const
  const write = { ...episode, baseRevision: 'board-1', shotsJson: storyboard.shotsJson }
  await expect(draftActions.saveStoryboard(write)).rejects.toBe(failure.error)
  await expect(draftActions.saveStoryboard(write)).resolves.toEqual(storyboard)
  expect(saveScriptDraftStoryboard.mock.calls).toEqual([[write], [write]])
  const restore = { ...episode, layer: 'storyboard', baseRevision: storyboard.revision, historyId: 8 } as const
  await expect(draftActions.restoreHistory(restore)).resolves.toEqual({ episode: null, storyboard: history })
  expect(restoreScriptDraftHistory).toHaveBeenCalledExactlyOnceWith(restore)

  const download = { ...episode, kind: 'storyboards', format: 'md' } as const
  const staleFile = draftActions.exportDraft(download)
  m.accountChanged()
  pending.resolve(file)
  await expect(staleFile).rejects.toThrow('Workshop account changed')
  await expect(draftActions.exportDraft(download)).rejects.toBe(failure.error)
  expect(exportScriptDraft.mock.calls).toEqual([[download], [download]])
})
