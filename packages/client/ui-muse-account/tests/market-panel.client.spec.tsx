// @vitest-environment jsdom
/** Main panel registration, Settings navigation, and plugin-owned feedback lifetime. */
import { Context } from '@deepseek-ai/cordis'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client'
import { resolveSlotLabel } from '@deepseek-ai/dsh-client-ui-slots'
import { afterEach, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { mountMuseMarket } from '../src/client/market-mount.ts'
import { createMarketFeedback } from '../src/client/market-feedback.tsx'
import { MarketPage, MarketSettingsLink } from '../src/client/MarketPage.tsx'

vi.mock('@deepseek-ai/dsh-muse-market/remote', () => ({
  default: { package: '@deepseek-ai/dsh-muse-market', descriptors: [] },
}))

const contexts = new Set<Context>()
afterEach(async () => { for (const ctx of contexts) await ctx.fiber.dispose(); contexts.clear(); cleanup() })

it('registers the same market ID in the sidebar and main panel and releases every contribution', async () => {
  const ctx = new Context(); contexts.add(ctx)
  await ctx.plugin(SlotRegistry).await()
  const locale = new LocaleRuntime(ctx); locale.setLocale('zh')
  ctx.provide('locale', locale)
  const selectPanel = vi.fn(), disposeRemote = vi.fn(async () => {})
  ctx.provide('layout', { selectPanel })
  ctx.provide('remote', { $mount: vi.fn(async () => disposeRemote), museMarket: {} })
  ctx.provide('remote.museMarket', {})
  const slots = ctx.get('slots') as SlotRegistry
  slots.register({ name: 'root', children: {
    main: { kind: 'keyed', scope: 'root' }, 'sidebar.panellist': { kind: 'list', scope: 'root' },
    'settings.section': { kind: 'list', scope: 'root' }, 'shell.overlay': { kind: 'list', scope: 'root' },
  } } as never, () => null)
  const dispose = await mountMuseMarket(ctx)
  expect(slots.entries('main')[0]?.options.key).toBe('muse-market')
  expect(slots.entries('main')[0]?.component).toBe(MarketPage)
  expect(slots.entries('sidebar.panellist')[0]?.options.id).toBe('muse-market')
  expect(resolveSlotLabel(slots.entries('sidebar.panellist')[0]?.options.label)).toBe('Bot 与 Skills 市场')
  const shortcut = slots.entries('settings.section')[0]!
  expect(shortcut.component).toBe(MarketSettingsLink)
  const props = shortcut.inject?.() as { onOpen: () => void }
  props.onOpen(); expect(selectPanel).toHaveBeenCalledWith('muse-market')
  expect(slots.entries('shell.overlay')).toHaveLength(1)
  await dispose()
  for (const name of ['main', 'sidebar.panellist', 'settings.section', 'shell.overlay'] as const) {
    expect(slots.entries(name)).toHaveLength(0)
  }
  expect(disposeRemote).toHaveBeenCalledOnce()
  const remount = await mountMuseMarket(ctx)
  expect(slots.entries('main')).toHaveLength(1)
  expect(slots.entries('sidebar.panellist')).toHaveLength(1)
  await remount()
})

it('retains operation feedback until dismissed and ignores completions after plugin disposal', () => {
  const feedback = createMarketFeedback(), listener = vi.fn()
  const unsubscribe = feedback.hooks.outcome.subscribe(listener)
  feedback.report('done', false)
  expect(feedback.hooks.outcome.getSnapshot()).toMatchObject({ key: 'done', failed: false })
  feedback.report('error.generic', true)
  expect(feedback.hooks.outcome.getSnapshot()).toMatchObject({ key: 'error.generic', failed: true, sequence: 2 })
  feedback.dismiss(); expect(feedback.hooks.outcome.getSnapshot()).toBeNull()
  unsubscribe(); feedback.dispose()
  feedback.report('done', false)
  expect(listener).toHaveBeenCalledTimes(3)
  expect(feedback.hooks.outcome.getSnapshot()).toBeNull()
})

it('closes Settings after selecting the market panel', () => {
  const calls: string[] = []
  render(<MarketSettingsLink t={key => key} onOpen={() => calls.push('select-market')} close={() => calls.push('close-settings')} />)
  fireEvent.click(screen.getByRole('button', { name: 'openMarket' }))
  expect(calls).toEqual(['select-market', 'close-settings'])
})

it('reserves macOS titlebar and leading-control clearance within the market page', () => {
  const sheet = readFileSync(resolve(import.meta.dirname, '../src/client/MarketPage.module.css'), 'utf8')
  expect(sheet).toContain(":global([data-platform='darwin']) .content")
  expect(sheet).toContain('padding-top: calc(28px + var(--dsh-frame-top-clearance, 0px))')
  expect(sheet).toContain('var(--dsh-frame-leading-clearance, 0px)')
})
