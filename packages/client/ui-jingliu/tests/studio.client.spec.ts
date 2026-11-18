// @vitest-environment jsdom
/** Public workbench URLs and disposable right-sidebar access. */
import { Context } from '@deepseek-ai/cordis'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client'
import { SidebarRightTabRegistry } from '@deepseek-ai/dsh-client-ui-sidebar-right/src/client/tab-registry.ts'
import type { IndexInjection, WebServer } from '@deepseek-ai/dsh-host-webserver'
import { afterEach, expect, it, onTestFinished, vi } from 'vitest'
import { studioUrl } from '../src/config.ts'
import { STUDIO_URL_GLOBAL, WORKSHOP_URL_GLOBAL } from '../src/page.ts'
import * as host from '../src/index.ts'
import * as studio from '../src/client/index.ts'

afterEach(() => vi.unstubAllGlobals())

it.each([
  { config: {}, titles: [], urls: [] },
  { config: { studioOrigin: 'http://127.0.0.1:18796' }, titles: ['镜流'], urls: ['http://127.0.0.1:18796/sfp/'] },
  { config: { workshopOrigin: 'https://scripts.example' }, titles: ['剧本工坊'], urls: ['https://scripts.example/v2'] },
  { config: { studioOrigin: 'https://studio.example', workshopOrigin: 'https://scripts.example' },
    titles: ['镜流', '剧本工坊'], urls: ['https://studio.example/sfp/', 'https://scripts.example/v2'] },
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
  expect(studioUrl('https://studio.example')).toBe('https://studio.example/sfp/')
  expect(studioUrl('http://127.0.0.1:18796')).toBe('http://127.0.0.1:18796/sfp/')
  expect(studioUrl('http://[::1]:18796/')).toBe('http://[::1]:18796/sfp/')
  expect(studioUrl('http://[::1]:18796/', 'workshop')).toBe('http://[::1]:18796/v2')
  for (const origin of ['http://studio.example', 'http://localhost:18796', 'http://127.1:18796',
    'file:///tmp/test', 'https://name@studio.example',
    'https://studio.example/fwp/', 'https://studio.example/?key=test', 'https://studio.example/#login']) {
    expect(() => studioUrl(origin)).toThrow()
    expect(() => studioUrl(origin, 'workshop')).toThrow()
  }
})
