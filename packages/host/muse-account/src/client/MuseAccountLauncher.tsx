/** Muse account entry in the desktop sidebar. */

import type { ReactNode } from 'react'
import { IconUserOutlineMedium } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import css from './MuseAccountLauncher.module.css'

/**
 * Open the Muse account page through the Settings owner.
 * @param props - sidebar geometry and Settings navigation.
 * @returns the primary account button.
 */
export function MuseAccountLauncher({ wide, openSection, openSettings, t }: PropsRuntime<'settings.launcher'> & PropsLocale<'settings.museAccount'>): ReactNode {
  return <button type="button" className={css.trigger} data-collapsed={!wide} aria-label={t('nav')}
    onClick={() => { if (openSection) openSection('muse-account'); else openSettings() }}>
    <IconUserOutlineMedium size={16} />
    {wide ? <span className={css.label}>{t('nav')}</span> : null}
  </button>
}
