/** Muse account and feedback entries in the desktop sidebar. */

import type { ReactNode } from 'react'
import { IconPaperPlaneOutlineMedium, IconUserOutlineMedium, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import css from './MuseAccountLauncher.module.css'

/**
 * Open Muse account settings or the product feedback page.
 * @param props - sidebar geometry, Settings navigation, and public feedback URL.
 * @returns the account entry and trailing feedback icon.
 */
export function MuseAccountLauncher({ wide, openSection, openSettings, t, feedbackUrl }: PropsRuntime<'settings.launcher'> & PropsLocale<'settings.museAccount'> & { feedbackUrl: string }): ReactNode {
  return <div className={css.root} data-settings-launcher-layout={wide ? 'inline' : undefined}>
    <Tooltip label={t('nav')} disabled={wide} side="right" portal>
      <button type="button" className={css.trigger} data-collapsed={!wide} aria-label={t('nav')}
        onClick={() => { if (openSection) openSection('muse-account'); else openSettings() }}>
        <IconUserOutlineMedium size={16} />
        {wide ? <span className={css.label}>{t('nav')}</span> : null}
      </button>
    </Tooltip>
    <Tooltip label={t('feedback')} side={wide ? 'top' : 'right'} portal>
      <button type="button" className={`${css.trigger} ${css.feedback}`} data-collapsed={!wide} aria-label={t('feedback')}
        onClick={() => { window.open(feedbackUrl, '_blank', 'noopener,noreferrer') }}>
        <IconPaperPlaneOutlineMedium size={16} />
      </button>
    </Tooltip>
  </div>
}
