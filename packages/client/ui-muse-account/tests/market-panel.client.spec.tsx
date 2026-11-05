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
import { RemoteError, type RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import { marketFixture } from './market-fixture.client.ts'
import { mountMuseMarket, type MarketActions } from '../src/client/market-mount.ts'
import { createMarketFeedback } from '../src/client/market-feedback.tsx'
import { MarketBotModeLink, MarketCreatorPanel, MarketPage, MarketSettingsLink } from '../src/client/MarketPage.tsx'
import type { MarketCreatorKind } from '../src/client/MarketCreatorPage.tsx'
import type { MarketRelease } from '@deepseek-ai/dsh-muse-market/types'

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
  const startPresetSession = vi.fn(async () => {})
  ctx.provide('layout', { selectPanel })
  ctx.provide('uiWorkspace', { startPresetSession })
  const navigation = { getSnapshot: () => true, subscribe: () => () => {}, openSession: vi.fn(async () => true) }
  ctx.provide('museBotMarketNavigation', navigation)
  ctx.provide('remote', { $mount: vi.fn(async () => disposeRemote), museMarket: {} })
  ctx.provide('remote.museMarket', {})
  const slots = ctx.get('slots') as SlotRegistry
  slots.register({ name: 'root', children: {
    main: { kind: 'keyed', scope: 'root' }, 'sidebar.panellist': { kind: 'list', scope: 'root' },
    'settings.section': { kind: 'list', scope: 'root' }, 'shell.overlay': { kind: 'list', scope: 'root' },
    'sidebar.footer.action': { kind: 'list', scope: 'root' },
  } } as never, () => null)
  const dispose = await mountMuseMarket(ctx)
  expect(slots.entries('main')[0]?.options.key).toBe('muse-market')
  expect(slots.entries('main')[0]?.component).toBe(MarketPage)
  const main = slots.entries('main')[0]?.inject?.() as {
    onRunBot: (id: MarketRelease['id'], title: string) => Promise<void>
    onOpenCreator: (kind: MarketCreatorKind) => void
  }
  const installId = 'a'.repeat(64) as MarketRelease['id']
  await main.onRunBot(installId, '16:9 分镜导演')
  expect(startPresetSession).toHaveBeenCalledExactlyOnceWith(`market-${installId}`, navigation.openSession, '16:9 分镜导演')
  const creator = slots.entries('main').find(entry => entry.options.key === 'muse-market-creator')
  expect(creator?.component).toBe(MarketCreatorPanel)
  const creatorProps = creator?.inject?.() as { getInitialKind: () => MarketCreatorKind; onBack: () => void }
  main.onOpenCreator('upload')
  expect(selectPanel).toHaveBeenLastCalledWith('muse-market-creator')
  expect(creatorProps.getInitialKind()).toBe('upload')
  creatorProps.onBack()
  expect(selectPanel).toHaveBeenLastCalledWith('muse-market')
  main.onOpenCreator('skill')
  expect(selectPanel).toHaveBeenLastCalledWith('muse-market-creator')
  expect(creatorProps.getInitialKind()).toBe('skill')
  expect(slots.entries('sidebar.footer.action')[0]?.component).toBe(MarketBotModeLink)
  expect(slots.entries('sidebar.footer.action')[0]?.inject?.()).toMatchObject({ navigation })
  expect(slots.entries('sidebar.panellist')[0]?.options.id).toBe('muse-market')
  expect(resolveSlotLabel(slots.entries('sidebar.panellist')[0]?.options.label)).toBe('Bot 与 Skills 市场')
  const shortcut = slots.entries('settings.section')[0]!
  expect(shortcut.component).toBe(MarketSettingsLink)
  const props = shortcut.inject?.() as { onOpen: () => void }
  props.onOpen(); expect(selectPanel).toHaveBeenCalledWith('muse-market')
  expect(slots.entries('shell.overlay')).toHaveLength(1)
  await dispose()
  for (const name of ['main', 'sidebar.panellist', 'sidebar.footer.action', 'settings.section', 'shell.overlay'] as const) {
    expect(slots.entries(name)).toHaveLength(0)
  }
  expect(disposeRemote).toHaveBeenCalledOnce()
  const remount = await mountMuseMarket(ctx)
  expect(slots.entries('main')).toHaveLength(2)
  expect(slots.entries('sidebar.panellist')).toHaveLength(1)
  await remount()
})

it('shows the market footer only while Bot mode is active', () => {
  const onOpen = vi.fn()
  const navigation = { getSnapshot: () => true, subscribe: () => () => {}, openSession: vi.fn(async () => true) }
  const { rerender } = render(<MarketBotModeLink t={key => key} wide={false} navigation={navigation} onOpen={onOpen} />)
  fireEvent.click(screen.getByRole('button', { name: 'nav' }))
  expect(onOpen).toHaveBeenCalledOnce()
  rerender(<MarketBotModeLink t={key => key} wide={false} navigation={{ ...navigation, getSnapshot: () => false }} onOpen={onOpen} />)
  expect(screen.queryByRole('button', { name: 'nav' })).toBeNull()
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

it('forwards panel operations through the mounted Remote and surfaces only bounded errors', async () => {
  const ctx = new Context()
  contexts.add(ctx)
  await ctx.plugin(SlotRegistry).await()
  const locale = new LocaleRuntime(ctx)
  locale.setLocale('zh')
  ctx.provide('locale', locale)
  ctx.provide('layout', { selectPanel: vi.fn() })
  const release = marketFixture[0]!
  const item = { release, enabled: false }
  const ok = <T,>(value: T) => ({ ok: true as const, value })
  const catalog = vi.fn(async (): Promise<RemoteResult<MarketRelease[]>> => ok([release]))
  const legacyCatalog = vi.fn(async () => ok([]))
  const installed = vi.fn(async () => ok([item]))
  const identity = vi.fn(async () => ok({ publishers: [], admin: false }))
  const sources = vi.fn(async () => ok({ website: 'https://muse.test/market', skills: [], bots: [] }))
  const installPackage = vi.fn(async () => ok(item))
  const enable = vi.fn(async () => ok({ ...item, enabled: true }))
  const installLegacy = vi.fn(async () => ok(item))
  const removePackage = vi.fn(async () => ok(undefined))
  const exportPackage = vi.fn(async () => ok({ name: 'bot.zip', base64: 'WklQ' }))
  const importPackage = vi.fn(async () => ok(item))
  const prepare = vi.fn(async () => ok(item))
  const publishDraft = vi.fn(async () => ok(release))
  const review = vi.fn(async () => ok(release))
  const calls = { catalog, legacyCatalog, installed, identity, sources, installPackage, enable, installLegacy, removePackage,
    exportPackage, importPackage, prepare, publishDraft, review }
  const disposeRemote = vi.fn(async () => {})
  ctx.provide('remote', { $mount: vi.fn(async () => disposeRemote), museMarket: calls })
  ctx.provide('remote.museMarket', calls)
  const slots = ctx.get('slots') as SlotRegistry
  slots.register({ name: 'root', children: { main: { kind: 'keyed', scope: 'root' },
    'sidebar.panellist': { kind: 'list', scope: 'root' }, 'sidebar.footer.action': { kind: 'list', scope: 'root' },
    'settings.section': { kind: 'list', scope: 'root' }, 'shell.overlay': { kind: 'list', scope: 'root' } } } as never, () => null)
  const dispose = await mountMuseMarket(ctx)
  const props = slots.entries('main')[0]?.inject?.() as { actions: MarketActions; onRunBot?: unknown }
  const actions = props.actions
  expect(props.onRunBot).toBeUndefined()

  await expect(actions.catalog('director', 'bot', false)).resolves.toEqual([release])
  await expect(actions.legacyCatalog('wide', 'bot')).resolves.toEqual([])
  await expect(actions.installed()).resolves.toEqual([item])
  await expect(actions.identity()).resolves.toMatchObject({ admin: false })
  await expect(actions.sources()).resolves.toMatchObject({ website: 'https://muse.test/market' })
  await expect(actions.install(release.id)).resolves.toBe(item)
  await expect(actions.enable(release.id, true)).resolves.toMatchObject({ enabled: true })
  await expect(actions.installLegacy('muse/bots/director', release.sha256)).resolves.toBe(item)
  await expect(actions.remove(release.id)).resolves.toBeUndefined()
  await expect(actions.exportPackage(release.id)).resolves.toEqual({ name: 'bot.zip', base64: 'WklQ' })
  await expect(actions.importPackage('WklQ')).resolves.toBe(item)
  await expect(actions.prepare(release.manifest, ['review'], 'director')).resolves.toBe(item)
  await expect(actions.publishDraft(release.id, release.publisherId, 'request')).resolves.toBe(release)
  await expect(actions.review(release.id, 1, 'submit', 'ready')).resolves.toBe(release)

  expect(catalog).toHaveBeenCalledExactlyOnceWith('director', 'bot', false)
  expect(legacyCatalog).toHaveBeenCalledExactlyOnceWith('wide', 'bot')
  expect(installPackage).toHaveBeenCalledExactlyOnceWith(release.id)
  expect(enable).toHaveBeenCalledExactlyOnceWith(release.id, true)
  expect(installLegacy).toHaveBeenCalledExactlyOnceWith('muse/bots/director', release.sha256)
  expect(removePackage).toHaveBeenCalledExactlyOnceWith(release.id)
  expect(exportPackage).toHaveBeenCalledExactlyOnceWith(release.id)
  expect(importPackage).toHaveBeenCalledExactlyOnceWith('WklQ')
  expect(prepare).toHaveBeenCalledExactlyOnceWith(release.manifest, ['review'], 'director')
  expect(publishDraft).toHaveBeenCalledExactlyOnceWith(release.id, release.publisherId, 'request')
  expect(review).toHaveBeenCalledExactlyOnceWith(release.id, 1, 'submit', 'ready')
  expect(slots.entries('shell.overlay')[0]?.inject?.()).toHaveProperty('dismiss', expect.any(Function))
  expect(resolveSlotLabel(slots.entries('settings.section')[0]?.options.label)).toBe('Bot 与 Skills 市场')

  catalog.mockResolvedValueOnce({ ok: false, error: new RemoteError('muse-market/operation-failed', 'private diagnostic', { code: 'login-required' }) })
  await expect(actions.catalog('', '', false)).rejects.toThrow(/^login-required$/)
  catalog.mockResolvedValueOnce({ ok: false, error: new RemoteError('gateway/internal', 'private diagnostic', {}) })
  await expect(actions.catalog('', '', false)).rejects.toThrow(/^generic$/)
  await dispose()
  expect(disposeRemote).toHaveBeenCalledOnce()
})

it('releases the market Remote if a sidebar registration fails', async () => {
  const ctx = new Context()
  contexts.add(ctx)
  await ctx.plugin(SlotRegistry).await()
  const locale = new LocaleRuntime(ctx)
  vi.spyOn(locale, 'register').mockImplementation(() => { throw Error('duplicate locale owner') })
  ctx.provide('locale', locale)
  ctx.provide('layout', { selectPanel: vi.fn() })
  const disposeRemote = vi.fn(async () => {})
  ctx.provide('remote', { $mount: vi.fn(async () => disposeRemote), museMarket: {} })
  ctx.provide('remote.museMarket', {})

  await expect(mountMuseMarket(ctx)).rejects.toThrow('duplicate locale owner')
  expect(disposeRemote).toHaveBeenCalledOnce()
})
