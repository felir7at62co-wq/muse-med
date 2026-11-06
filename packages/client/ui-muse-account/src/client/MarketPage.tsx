/** Main-area market panel and the Settings shortcut to it. */
import { useSyncExternalStore, type ReactNode } from 'react'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type { SettingsSectionOwnerProps } from '@deepseek-ai/dsh-client-ui-settings/client'
import { Button, IconGlobeOutlineRegular, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import type { MuseBotMarketNavigation } from './market-mount.ts'
import { MarketSection, type MarketSectionProps } from './MarketSection.tsx'
import { MarketCreatorPage, type MarketCreatorKind, type MarketCreatorPageProps } from './MarketCreatorPage.tsx'
import css from './MarketPage.module.css'

/** Render the market in the shell's scrollable central panel.
 * @param props Main-slot hooks, locale and authenticated market actions.
 * @returns Main-area market content.
 */
export function MarketPage(props: MarketSectionProps): ReactNode {
  return <div className={css.page}><div className={css.content}><MarketSection {...props} /></div></div>
}

/** Render creation and upload in a separate scrollable market page.
 * @param props Creator operations, navigation and localized copy.
 * @returns Dedicated creator page.
 */
export function MarketCreatorPanel(
  { getInitialKind, ...props }: MarketCreatorPageProps & { getInitialKind: () => MarketCreatorKind },
): ReactNode {
  const initialKind = getInitialKind()
  return <div className={css.page}><div className={css.content}><MarketCreatorPage {...props} initialKind={initialKind} /></div></div>
}

/** Render the market's existing-library glyph; the sidebar supplies the label.
 * @param props Sidebar-requested icon size.
 * @returns Decorative navigation icon.
 */
export function MarketPanelIcon({ size }: PropsRuntime<'sidebar.panellist'>): ReactNode {
  return <IconGlobeOutlineRegular size={size} />
}

/**
 * Open the market from the Bot mode sidebar, which owns its panel list.
 * @param props - sidebar width, locale, mode observer and market navigation.
 * @returns Market shortcut while Bot mode is active.
 */
export function MarketBotModeLink({ t, wide, navigation, onOpen }: Pick<PropsRuntime<'sidebar.footer.action'>, 'wide'>
  & PropsLocale<'settings.museMarket'> & { navigation: MuseBotMarketNavigation; onOpen: () => void }): ReactNode {
  const active = useSyncExternalStore(navigation.subscribe, navigation.getSnapshot)
  if (!active) return null
  const label = t('nav')
  return <Tooltip label={label} disabled={wide} portal>
    <Button variant="ghost" aria-label={label} onClick={onOpen} icon={<IconGlobeOutlineRegular size={18} />}>
      {wide ? label : null}
    </Button>
  </Tooltip>
}

/** Open the main market panel from the retained Settings entry.
 * @param props Localized shortcut and shell navigation action.
 * @returns Settings shortcut without mounting another market query.
 */
export function MarketSettingsLink({ t, onOpen, close }: PropsLocale<'settings.museMarket'>
  & SettingsSectionOwnerProps & { onOpen: () => void }): ReactNode {
  return <div className={css.shortcut}><p>{t('mainAreaDescription')}</p>
    <Button variant="outline" onClick={() => { onOpen(); close() }}>{t('openMarket')}</Button></div>
}
