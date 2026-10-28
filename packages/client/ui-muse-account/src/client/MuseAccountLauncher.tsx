/** Muse account entry in the desktop sidebar. */

import type { ReactNode } from 'react'
import { IconUserOutlineMedium, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import css from './MuseAccountLauncher.module.css'

/**
 * Open Muse account settings from the desktop sidebar; the data marker supports locale-independent UI navigation.
 * @param props - sidebar geometry, Settings navigation, and the accepted compatibility feedback URL.
 * @returns the account button with its localized tooltip.
 */
export function MuseAccountLauncher({ wide, openSection, openSettings, t }: PropsRuntime<'settings.launcher'> & PropsLocale<'settings.museAccount'> & { feedbackUrl: string }): ReactNode {
  return <div className={css.root} data-settings-launcher-layout={wide ? 'inline' : undefined}>
    <Tooltip label={t('nav')} disabled={wide} side="right" portal>
      <button type="button" className={css.trigger} data-muse-account-launcher="" data-collapsed={!wide} aria-label={t('nav')}
        onClick={() => { if (openSection) openSection('muse-account'); else openSettings() }}>
        <IconUserOutlineMedium size={16} />
        {wide ? <span className={css.label}>{t('nav')}</span> : null}
      </button>
    </Tooltip>
  </div>
}
