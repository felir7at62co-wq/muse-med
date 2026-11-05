/** Generated Remote mounting and main-area registration for the Muse market. */
import type { Context } from '@deepseek-ai/cordis'
import type { PresetSessionOpener } from '@deepseek-ai/dsh-client-ui-workspace/client'
import marketRemote from '@deepseek-ai/dsh-muse-market/remote'
import type MuseMarket from '@deepseek-ai/dsh-muse-market'
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import type { MainPanelId } from '@deepseek-ai/dsh-client-ui-layout/client'
import { MarketBotModeLink, MarketCreatorPanel, MarketPage, MarketPanelIcon, MarketSettingsLink } from './MarketPage.tsx'
import type { MarketCreatorKind } from './MarketCreatorPage.tsx'
import { createMarketFeedback, MarketFeedbackOverlay } from './market-feedback.tsx'
import { marketZh, marketEn, type MarketLocaleKey } from './market-locales.ts'

/** Market actions available to the page through the authenticated Host. */
export type MarketActions = Pick<MuseMarket, 'catalog' | 'legacyCatalog' | 'installed' | 'identity' | 'sources' | 'install' | 'installLegacy' | 'enable' | 'remove' | 'exportPackage' | 'importPackage' | 'prepare' | 'publishDraft' | 'review'>

/** Optional navigation supplied by the qualified Muse Bot client. */
export interface MuseBotMarketNavigation {
  readonly getSnapshot: () => boolean
  readonly subscribe: (listener: () => void) => () => void
  readonly openSession: PresetSessionOpener
}

declare module '@deepseek-ai/cordis' {
  interface Context { museBotMarketNavigation: MuseBotMarketNavigation }
}

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap { 'settings.museMarket': MarketLocaleKey }
}

async function value<T>(call: Promise<RemoteResult<T>>): Promise<T> {
  const result = await call
  if (result.ok) return result.value
  const details: unknown = result.error.details
  throw new Error(details && typeof details === 'object' && 'code' in details && typeof details.code === 'string' ? details.code : 'generic')
}

/** Mount market Remote descriptors, main panel, sidebar entry and Settings shortcut.
 * @param ctx Browser context with account Settings dependencies.
 * @returns Disposer for the section and its Remote contribution.
 */
export async function mountMuseMarket(ctx: Context): Promise<() => Promise<void>> {
  const remote = await ctx.remote.$mount(marketRemote)
  const section = ctx.inject(['slots', 'locale', 'layout', 'remote.museMarket'], (context) => {
    context.effect(() => context.locale.register('settings.museMarket', { zh: marketZh, en: marketEn }))
    const t = context.locale.bind('settings.museMarket')
    const calls = context.remote.museMarket
    const feedback = createMarketFeedback()
    context.effect(() => () => { feedback.dispose() })
    context.slots.inject('shell.overlay', () => context.slots.register({ name: 'shell.overlay', id: 'muse-market.feedback',
      locale: 'settings.museMarket', inject: () => ({ hooks: feedback.hooks, dismiss: feedback.dismiss }) }, MarketFeedbackOverlay))
    const actions: MarketActions = {
      catalog: (...args) => value(calls.catalog(...args)),
      legacyCatalog: (...args) => value(calls.legacyCatalog(...args)),
      installed: () => value(calls.installed()), identity: () => value(calls.identity()),
      sources: () => value(calls.sources()),
      install: (...args) => value(calls.installPackage(...args)), enable: (...args) => value(calls.enable(...args)),
      installLegacy: (...args) => value(calls.installLegacy(...args)),
      remove: (...args) => value(calls.removePackage(...args)), exportPackage: (...args) => value(calls.exportPackage(...args)),
      importPackage: (...args) => value(calls.importPackage(...args)), prepare: (...args) => value(calls.prepare(...args)),
      publishDraft: (...args) => value(calls.publishDraft(...args)),
      review: (...args) => value(calls.review(...args)),
    }
    const panelId = 'muse-market' as MainPanelId
    const creatorId = 'muse-market-creator' as MainPanelId
    let initialKind: MarketCreatorKind = 'skill'
    const onOpen = (): void => { context.layout.selectPanel(panelId) }
    const onOpenCreator = (kind: MarketCreatorKind): void => {
      initialKind = kind
      context.layout.selectPanel(creatorId)
    }
    context.slots.inject('main', () => context.slots.register({ name: 'main', key: panelId, locale: 'settings.museMarket',
      inject: () => ({ actions, reportOutcome: feedback.report, onOpenCreator }) }, MarketPage))
    context.slots.inject('main', () => context.slots.register({ name: 'main', key: creatorId, locale: 'settings.museMarket',
      inject: () => ({ actions, reportOutcome: feedback.report, getInitialKind: () => initialKind, onBack: onOpen }) }, MarketCreatorPanel))
    context.slots.inject('sidebar.panellist', () => context.slots.register({ name: 'sidebar.panellist', id: panelId,
      order: 20, locale: 'settings.museMarket', label: () => t('nav') }, MarketPanelIcon))
    context.inject(['museBotMarketNavigation'], (scope) => {
      scope.slots.inject('sidebar.footer.action', () => scope.slots.register({ name: 'sidebar.footer.action', id: panelId,
        order: 20, locale: 'settings.museMarket', inject: () => ({ navigation: scope.museBotMarketNavigation, onOpen }) }, MarketBotModeLink))
    })
    context.slots.inject('settings.section', () => context.slots.register({ name: 'settings.section', id: 'muse-market', order: 13,
      label: () => t('nav'), locale: 'settings.museMarket', inject: () => ({ onOpen }) }, MarketSettingsLink))
  })
  try { await section } catch (error) { await section.dispose(); await remote(); throw error }
  return async () => { await section.dispose(); await remote() }
}
