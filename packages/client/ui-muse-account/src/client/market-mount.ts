/** Generated Remote mounting and main-area registration for the Muse market. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-session-controller/client'
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client'
import marketRemote from '@deepseek-ai/dsh-muse-market/remote'
import type MuseMarket from '@deepseek-ai/dsh-muse-market'
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import type { MainPanelId } from '@deepseek-ai/dsh-client-ui-layout/client'
import { MarketPage, MarketPanelIcon, MarketSettingsLink } from './MarketPage.tsx'
import type { MarketSectionProps } from './MarketSection.tsx'
import { createMarketFeedback, MarketFeedbackOverlay } from './market-feedback.tsx'
import { marketZh, marketEn, type MarketLocaleKey } from './market-locales.ts'

/** Market actions available to the page through the authenticated Host. */
export type MarketActions = Pick<MuseMarket, 'catalog' | 'installed' | 'identity' | 'sources' | 'install' | 'enable' | 'remove' | 'exportPackage' | 'importPackage' | 'prepare' | 'publishDraft' | 'review'>

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
      installed: () => value(calls.installed()), identity: () => value(calls.identity()),
      sources: () => value(calls.sources()),
      install: (...args) => value(calls.installPackage(...args)), enable: (...args) => value(calls.enable(...args)),
      remove: (...args) => value(calls.removePackage(...args)), exportPackage: (...args) => value(calls.exportPackage(...args)),
      importPackage: (...args) => value(calls.importPackage(...args)), prepare: (...args) => value(calls.prepare(...args)),
      publishDraft: (...args) => value(calls.publishDraft(...args)),
      review: (...args) => value(calls.review(...args)),
    }
    const panelId = 'muse-market' as MainPanelId
    const onOpen = (): void => { context.layout.selectPanel(panelId) }
    context.slots.inject('main', () => context.slots.register({ name: 'main', key: panelId, locale: 'settings.museMarket',
      inject: () => {
        const sessions = context.get('sessions')
        const workspace = context.get('uiWorkspace')
        const onRunBot: MarketSectionProps['onRunBot'] = sessions && workspace ? async (id) => {
          const navigation = context.layout.beginNavigation()
          const sessionId = await sessions.create({ agentPreset: `market-${id}` })
          if (!navigation.aborted) workspace.openSession(sessionId)
        } : undefined
        return { actions, reportOutcome: feedback.report, ...(onRunBot ? { onRunBot } : {}) }
      } }, MarketPage))
    context.slots.inject('sidebar.panellist', () => context.slots.register({ name: 'sidebar.panellist', id: panelId,
      order: 20, locale: 'settings.museMarket', label: () => t('nav') }, MarketPanelIcon))
    context.slots.inject('settings.section', () => context.slots.register({ name: 'settings.section', id: 'muse-market', order: 13,
      label: () => t('nav'), locale: 'settings.museMarket', inject: () => ({ onOpen }) }, MarketSettingsLink))
  })
  try { await section } catch (error) { await section.dispose(); await remote(); throw error }
  return async () => { await section.dispose(); await remote() }
}
