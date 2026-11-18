/** The original workbench document, isolated from the Muse renderer. */
import type { ReactNode } from 'react'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import type {} from './locales.ts'
import css from './Studio.module.css'

type StudioProps = PropsRuntime<'sidebar.right.pane.tab'> & PropsLocale<'jingliuStudio'> &
  InjectFace<{ readonly studioUrl: string; readonly titleKey: 'title' | 'workshopTitle' }>

/**
 * Mount the configured studio with its own storage, uploads, downloads and login popup.
 * @param props - Workspace document address and localized slot data.
 * @returns Isolated studio iframe filling the active sidebar pane.
 */
export function Studio({ studioUrl, titleKey, t }: StudioProps): ReactNode {
  return <div className={css.viewport} role="region" aria-label={t(titleKey)} tabIndex={0}>
    <iframe className={css.frame} title={t(titleKey)} src={studioUrl} referrerPolicy="no-referrer"
      sandbox="allow-scripts allow-same-origin allow-forms allow-downloads allow-modals allow-popups allow-popups-to-escape-sandbox"
      allowFullScreen />
  </div>
}
