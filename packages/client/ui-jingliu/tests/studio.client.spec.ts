// @vitest-environment jsdom
/** Public studio URL and disposable right-sidebar access. */
import { Context } from '@deepseek-ai/cordis'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client'
import { SidebarRightTabRegistry } from '@deepseek-ai/dsh-client-ui-sidebar-right/src/client/tab-registry.ts'
import { afterEach, expect, it, onTestFinished, vi } from 'vitest'
import { studioUrl } from '../src/config.ts'
import { STUDIO_URL_GLOBAL } from '../src/page.ts'
import * as studio from '../src/client/index.ts'

afterEach(() => vi.unstubAllGlobals())

it('mounts and releases the localized guide only for a configured workspace', async () => {
  const ctx = new Context()
  onTestFinished(async () => { await ctx.fiber.dispose() })
  await ctx.plugin(SlotRegistry).await()
  ctx.provide('locale', new LocaleRuntime(ctx))
  ctx.provide('sidebarRightTabs', new SidebarRightTabRegistry(ctx))
  ctx.locale.setLocale('zh')
  const disabled = ctx.plugin(studio)
  await disabled.await()
  expect(ctx.sidebarRightTabs.guide()).toHaveLength(0)
  await disabled.dispose()
  vi.stubGlobal(STUDIO_URL_GLOBAL, studioUrl('http://127.0.0.1:18796'))
  const active = ctx.plugin(studio)
  await active.await()
  const entry = ctx.sidebarRightTabs.guide().find(guide => guide.kind === 'jingliu')
  expect(entry?.title()).toBe('镜流')
  expect(ctx.sidebarRightTabs.get('jingliu')?.keepMounted).toBe(true)
  await active.dispose()
  expect(ctx.sidebarRightTabs.guide()).toHaveLength(0)
})

it('builds only dedicated production URLs and rejects credential-bearing origins', () => {
  expect(studioUrl(undefined)).toBeUndefined()
  expect(studioUrl('https://studio.example')).toBe('https://studio.example/sfp/')
  expect(studioUrl('http://127.0.0.1:18796')).toBe('http://127.0.0.1:18796/sfp/')
  expect(studioUrl('http://[::1]:18796/')).toBe('http://[::1]:18796/sfp/')
  for (const origin of ['http://studio.example', 'http://localhost:18796', 'http://127.1:18796',
    'file:///tmp/test', 'https://name@studio.example',
    'https://studio.example/fwp/', 'https://studio.example/?key=test', 'https://studio.example/#login']) {
    expect(() => studioUrl(origin)).toThrow()
  }
})
