// @vitest-environment jsdom
/** Public workbench URLs and disposable right-sidebar access. */
import { Context } from '@deepseek-ai/cordis'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client'
import { SidebarRightTabRegistry } from '@deepseek-ai/dsh-client-ui-sidebar-right/src/client/tab-registry.ts'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { PropsRenderSlots } from '@deepseek-ai/dsh-client-ui-slots'
import type { SelectedProject, StudioImage, StudioNewProject } from '@deepseek-ai/dsh-jingliu-connection/types'
import type { MuseDataRush } from '@deepseek-ai/dsh-muse-account/types'
import type { IndexInjection, WebServer } from '@deepseek-ai/dsh-host-webserver'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import { RemoteError, type RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import type { ScriptDraft, ScriptDraftCreateRequest } from '@deepseek-ai/dsh-workbench-connection/types'
import { Fragment, createElement } from 'react'
import { afterEach, expect, it, onTestFinished, vi } from 'vitest'
import { studioUrl } from '../src/config.ts'
import { STUDIO_URL_GLOBAL, WORKSHOP_URL_GLOBAL } from '../src/page.ts'
import type { DrawerDataProps } from '../src/client/DrawerData.tsx'
import type { DraftActions } from '../src/client/DrawerScriptDraft.tsx'
import * as host from '../src/index.ts'
import * as studio from '../src/client/index.ts'
import type { ProductionActions } from '../src/client/Production.tsx'

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
  const scriptDraftHistory = unavailable()
  const scriptDraftHistoryEntry = unavailable()
  m.bind('workshopConnection', { scripts, script, scriptDraftHistory, scriptDraftHistoryEntry })
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
  const watchProject = vi.fn<(id: SessionId, signal: AbortSignal) => AsyncIterable<SelectedProject | null>>()
    .mockImplementationOnce(async function* () { yield null; yield selected })
    .mockImplementation(async function* () { throw disconnected })
  m.bind('jingliuConnection', { watchProject })
  await vi.waitFor(() => { expect(m.slots.entries('bot.drawer.jingliu')).toHaveLength(1) })

  const signal = new AbortController().signal
  await expect(m.read('jingliu-selected', 'id=scene+work', signal)).resolves.toEqual([
    { ok: true, value: null }, { ok: true, value: selected },
  ])
  expect(watchProject).toHaveBeenCalledExactlyOnceWith('scene work', signal)
  await expect(m.read('jingliu-selected', 'id=scene+work', signal)).rejects.toBe(disconnected)
  await expect(m.read('jingliu-selected', 'id=scene+work', AbortSignal.abort())).resolves.toEqual([])
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
