// @vitest-environment jsdom
/** Registration ownership only; real data and RPC workflows are accepted by the separate browser fixture. */
import { Context } from '@deepseek-ai/cordis'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client'
import { resolveSlotLabel, type GlobalStandardProps, type PropsLocale, type PropsRenderSlots, type PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { SettingsSectionOwnerProps } from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type { ComponentType } from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, onTestFinished, vi } from 'vitest'
import { MarketController } from '../src/client/market-controller.ts'
import type { MarketActions, MarketInjected } from '../src/client/market-actions.ts'
import type { MarketFeedback } from '../src/client/market-feedback.tsx'
import { registerMuseMarket } from '../src/client/market-registration.tsx'

afterEach(cleanup)

const unavailable = async (): Promise<never> => { throw new Error('Data operations are outside this registration test') }
const operations: MarketActions = {
  sources: unavailable, prepare: unavailable, installed: unavailable, importPackage: unavailable,
  exportPackage: unavailable, removePackage: unavailable, defaults: unavailable, setDefault: unavailable,
  binding: unavailable, catalog: unavailable, identity: unavailable, getPublication: unavailable,
  installPublication: unavailable, publishDraft: unavailable, review: unavailable,
}

function MarketRoot({ renderSlot }: PropsRenderSlots<'main' | 'sidebar.panellist' | 'settings.section' | 'shell.overlay'>) {
  return <>
    {renderSlot('main', {})}
    {renderSlot('sidebar.panellist', { size: 20, active: false })}
    {renderSlot('settings.section', { close: () => {} })}
    {renderSlot('shell.overlay', {})}
  </>
}

it('unloads and remounts market entries while preserving the original account section', async () => {
  const ctx = new Context(), controller = new MarketController(operations)
  onTestFinished(async () => { controller.dispose(); await ctx.fiber.dispose() })
  await ctx.plugin(SlotRegistry).await()
  const locale = new LocaleRuntime(ctx); ctx.provide('locale', locale)
  ctx.effect(() => locale.addLanguage({ id: 'ja', label: '日本語', fallback: 'en' }))
  const selectPanel = vi.fn()
  ctx.provide('layout', { selectPanel })
  ctx.slots.register({ name: 'root', children: {
    main: { kind: 'keyed', scope: 'root' },
    'sidebar.panellist': { kind: 'list', scope: 'root' },
    'settings.section': { kind: 'list', scope: 'root' },
    'shell.overlay': { kind: 'list', scope: 'root' },
  } }, MarketRoot)
  ctx.slots.register({ name: 'settings.section', id: 'muse-account', label: 'MUSE' }, () => null)
  const original = ctx.slots.entries('settings.section')[0]
  const mount = () => registerMuseMarket(ctx, controller.operations, controller.access, revision => controller.isCurrentAccess(revision))
  for (let round = 0; round < 2; ++round) {
    const dispose = await mount()
    expect(ctx.slots.entries('main')).toHaveLength(1)
    expect(ctx.slots.entries('sidebar.panellist')).toHaveLength(1)
    expect(ctx.slots.entries('shell.overlay')).toHaveLength(1)
    expect(ctx.slots.entries('settings.section')).toHaveLength(2)
    const entry = ctx.slots.entries('sidebar.panellist')[0]
    if (entry === undefined) throw new Error('Market navigation was not registered')
    locale.setLocale('ja')
    expect(resolveSlotLabel(entry.options.label)).toBe('Skill マーケット')
    const Icon = entry.component as ComponentType<PropsRuntime<'sidebar.panellist'>>
    const icon = render(<Icon {...({} as GlobalStandardProps)} size={20} active={false} />)
    expect(icon.container.querySelector('svg')).not.toBeNull()
    icon.unmount()
    const settings = ctx.slots.entries('settings.section').find(value => value.options.id === 'muse-market')
    if (settings === undefined) throw new Error('Market settings link was not registered')
    expect(resolveSlotLabel(settings.options.label)).toBe('Skill マーケット')
    const injected = settings.inject?.() as { onOpen: () => void }
    const Settings = settings.component as ComponentType<PropsLocale<'settings.museMarket'> & SettingsSectionOwnerProps & typeof injected>
    const close = vi.fn(), t = locale.bind('settings.museMarket')
    const page = render(<Settings {...({} as GlobalStandardProps)} {...injected} t={t} close={close} />)
    fireEvent.click(screen.getByRole('button', { name: t('openMarket') }))
    expect(selectPanel).toHaveBeenLastCalledWith('muse-market')
    expect(close).toHaveBeenCalledOnce()
    page.unmount()
    const panel = ctx.slots.entries('main')[0]?.inject?.() as MarketInjected | undefined
    if (panel === undefined) throw new Error('Market panel has no operations')
    const overlay = ctx.slots.entries('shell.overlay')[0]?.inject?.() as Pick<MarketFeedback, 'hooks' | 'dismiss'>
    panel.reportOutcome('installedDone', false)
    expect(overlay.hooks.outcome.getSnapshot()).toMatchObject({ key: 'installedDone', failed: false })
    overlay.dismiss()
    expect(overlay.hooks.outcome.getSnapshot()).toBeNull()
    await dispose()
    expect(ctx.slots.entries('main')).toEqual([])
    expect(ctx.slots.entries('sidebar.panellist')).toEqual([])
    expect(ctx.slots.entries('shell.overlay')).toEqual([])
    expect(ctx.slots.entries('settings.section')).toEqual([original])
  }
})
