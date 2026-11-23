// @vitest-environment jsdom
/** Public workbench URLs and disposable right-sidebar access. */
import { Context } from '@deepseek-ai/cordis'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client'
import { SidebarRightTabRegistry } from '@deepseek-ai/dsh-client-ui-sidebar-right/src/client/tab-registry.ts'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { IndexInjection, WebServer } from '@deepseek-ai/dsh-host-webserver'
import { afterEach, expect, it, onTestFinished, vi } from 'vitest'
import { studioUrl } from '../src/config.ts'
import { STUDIO_URL_GLOBAL, WORKSHOP_URL_GLOBAL } from '../src/page.ts'
import * as host from '../src/index.ts'
import * as studio from '../src/client/index.ts'

vi.mock('@deepseek-ai/dsh-jingliu-connection/remote', () => ({ default: {} }))

afterEach(() => vi.unstubAllGlobals())

it.each([
  { config: {}, titles: [], urls: [] },
  { config: { studioOrigin: 'http://127.0.0.1:18796' }, titles: ['镜流'], urls: ['http://127.0.0.1:18796/fwp/v2/auth/muse/embed'] },
  { config: { workshopOrigin: 'https://scripts.example' }, titles: ['剧本工坊'], urls: ['https://scripts.example/v1/auth/muse/embed'] },
  { config: { studioOrigin: 'https://studio.example', workshopOrigin: 'https://scripts.example' },
    titles: ['镜流', '剧本工坊'], urls: ['https://studio.example/fwp/v2/auth/muse/embed', 'https://scripts.example/v1/auth/muse/embed'] },
])('opens each configured workbench independently ($titles)', async ({ config, titles, urls }) => {
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
  for (const entry of entries) expect(ctx.sidebarRightTabs.get(entry.kind)?.keepMounted).toBe(true)
  await active.dispose()
  expect(ctx.sidebarRightTabs.guide()).toHaveLength(0)
})

it('resolves studio and workshop pages only on dedicated origins', () => {
  expect(studioUrl(undefined)).toBeUndefined()
  expect(studioUrl(undefined, 'workshop')).toBeUndefined()
  expect(studioUrl('https://studio.example')).toBe('https://studio.example/fwp/v2/auth/muse/embed')
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
  await Promise.all(panes.map(async pane => expect(await pane.issueLogin('challenge')).toEqual({ code: 'temporary' })))
  expect(issueWorkbenchCode.mock.calls).toEqual([[{ audience: 'jingliu', challenge: 'challenge' }], [{ audience: 'script-workshop', challenge: 'challenge' }]])
  accountChanged()
  ctx.emit('connection/reset')
  expect(panes.map(pane => pane.hooks.loginGeneration.getSnapshot())).toEqual([initial + 2, initial + 2])
  await active.dispose()
  expect(off).toHaveBeenCalled()
})

it('fills the Bot drawer\'s data slot once the account Remote and the resource registry arrive', async () => {
  vi.stubGlobal(STUDIO_URL_GLOBAL, 'https://muse.test/jingliu/')
  const ctx = new Context()
  onTestFinished(async () => { await ctx.fiber.dispose() })
  await ctx.plugin(SlotRegistry).await()
  ctx.provide('locale', new LocaleRuntime(ctx))
  ctx.provide('sidebarRightTabs', new SidebarRightTabRegistry(ctx))
  const slots = ctx.get('slots') as SlotRegistry
  slots.register({ name: 'root', children: { 'bot.drawer.data': { kind: 'single', scope: 'root' } } } as never, () => null)
  await ctx.plugin(studio).await()
  expect(slots.entries('bot.drawer.data')).toHaveLength(0)
  const register = vi.fn(() => () => {})
  ctx.provide('resources', { register })
  ctx.provide('remote', { $on: () => () => {}, museAccount: {} })
  ctx.provide('remote.museAccount', {})
  await vi.waitFor(() => { expect(slots.entries('bot.drawer.data')).toHaveLength(1) })
  expect(register.mock.calls.map(call => (call as unknown[])[0])).toEqual(expect.arrayContaining([
    expect.objectContaining({ protocol: 'muse-data-boards' }), expect.objectContaining({ protocol: 'muse-data-stock' }),
  ]))
})
