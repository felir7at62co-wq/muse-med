/** Independently disposable Skill market panel, navigation and operation feedback. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type { MainPanelId } from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { SettingsSectionOwnerProps } from '@deepseek-ai/dsh-client-ui-settings/client'
import { Button, IconGlobeOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import type { HostObservable } from '@deepseek-ai/dsh-client-ui-slots'
import type { MarketAccess } from './market-controller.ts'
import type { ReactNode } from 'react'
import { MarketPage } from './MarketSection.tsx'
import type { MarketActions } from './market-actions.ts'
import { createMarketFeedback, MarketFeedbackOverlay } from './market-feedback.tsx'
import { createMarketViewStore } from './market-view-store.ts'
import { marketZh, marketEn, marketJa, marketEs, marketFr, marketDe, marketRu, marketPt, type MarketLocaleKey } from './market-locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap { 'settings.museMarket': MarketLocaleKey }
}

function MarketPanelIcon({ size }: PropsRuntime<'sidebar.panellist'>): ReactNode {
  return <IconGlobeOutlineRegular size={size} />
}

function MarketSettingsLink({ t, onOpen, close }: PropsLocale<'settings.museMarket'> & SettingsSectionOwnerProps
  & { readonly onOpen: () => void }): ReactNode {
  return <div><p>{t('mainAreaDescription')}</p><Button variant="outline" onClick={() => { onOpen(); close() }}>{t('openMarket')}</Button></div>
}

/** Register one ordinary global panel and one Settings link, with disposal of all contributions. */
export async function registerMuseMarket(ctx: Context, operations: MarketActions, access: HostObservable<MarketAccess>,
  isCurrentAccess: (revision: number) => boolean): Promise<() => Promise<void>> {
  const section = ctx.inject(['slots', 'locale', 'layout'], (scope) => {
    scope.effect(() => scope.locale.register('settings.museMarket', { zh: marketZh, en: marketEn, ja: marketJa, es: marketEs, fr: marketFr, de: marketDe, ru: marketRu, pt: marketPt }))
    const t = scope.locale.bind('settings.museMarket'), panelId = 'muse-market' as MainPanelId
    const feedback = createMarketFeedback()
    scope.effect(() => () => { feedback.dispose() })
    const store = createMarketViewStore()
    scope.slots.inject('shell.overlay', () => scope.slots.register({ name: 'shell.overlay', id: 'muse-market.feedback',
      locale: 'settings.museMarket', inject: () => ({ hooks: feedback.hooks, dismiss: feedback.dismiss }) }, MarketFeedbackOverlay))
    scope.slots.inject('main', () => scope.slots.register({ name: 'main', key: panelId, store, locale: 'settings.museMarket',
      inject: () => ({ operations, isCurrentAccess, hooks: { access }, reportOutcome: feedback.report }) }, MarketPage))
    scope.slots.inject('sidebar.panellist', () => scope.slots.register({ name: 'sidebar.panellist', id: panelId,
      order: 20, locale: 'settings.museMarket', label: () => t('nav') }, MarketPanelIcon))
    scope.slots.inject('settings.section', () => scope.slots.register({ name: 'settings.section', id: panelId,
      order: 13, locale: 'settings.museMarket', label: () => t('nav'),
      inject: () => ({ onOpen: () => { scope.layout.selectPanel(panelId) } }) }, MarketSettingsLink))
  })
  try { await section }
  catch (error) { await section.dispose(); throw error }
  return async () => { await section.dispose() }
}
