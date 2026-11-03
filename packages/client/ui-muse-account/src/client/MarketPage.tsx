/** Main-area market panel and the Settings shortcut to it. */
import type { ReactNode } from 'react'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type { SettingsSectionOwnerProps } from '@deepseek-ai/dsh-client-ui-settings/client'
import { Button, IconGlobeOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import { MarketSection, type MarketSectionProps } from './MarketSection.tsx'
import css from './MarketPage.module.css'

/** Render the market in the shell's scrollable central panel.
 * @param props Main-slot hooks, locale and authenticated market actions.
 * @returns Main-area market content.
 */
export function MarketPage(props: MarketSectionProps): ReactNode {
  return <div className={css.page}><div className={css.content}><MarketSection {...props} /></div></div>
}

/** Render the market's existing-library glyph; the sidebar supplies the label.
 * @param props Sidebar-requested icon size.
 * @returns Decorative navigation icon.
 */
export function MarketPanelIcon({ size }: PropsRuntime<'sidebar.panellist'>): ReactNode {
  return <IconGlobeOutlineRegular size={size} />
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
