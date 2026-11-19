/** The original workbench document, isolated from the Muse renderer. */
import { useEffect, useRef, type ReactNode } from 'react'
import type { HostObservable, InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import type {} from './locales.ts'
import { bindWorkbenchLogin, type WorkbenchLoginResult } from './workbench-login.ts'
import css from './Studio.module.css'

type StudioProps = PropsRuntime<'sidebar.right.pane.tab'> & PropsLocale<'jingliuStudio'> &
  InjectFace<{
    readonly studioUrl: string
    readonly titleKey: 'title' | 'workshopTitle'
    readonly issueLogin: (challenge: string) => Promise<WorkbenchLoginResult>
    readonly hooks: { readonly loginGeneration: HostObservable<number> }
  }>

/**
 * Mount the configured studio with its own storage, uploads, downloads and login popup.
 * @param props - Workspace document address and localized slot data.
 * @returns Isolated studio iframe filling the active sidebar pane.
 */
export function Studio({ studioUrl, titleKey, issueLogin, useLoginGeneration, t }: StudioProps): ReactNode {
  const generation = useLoginGeneration(value => value)
  const frame = useRef<HTMLIFrameElement>(null)
  useEffect(() => {
    if (frame.current) return bindWorkbenchLogin(frame.current, new URL(studioUrl).origin, issueLogin)
  }, [studioUrl, issueLogin, generation])
  return <div className={css.viewport} role="region" aria-label={t(titleKey)} tabIndex={0}>
    <iframe key={generation} ref={frame} className={css.frame} title={t(titleKey)} src={studioUrl} referrerPolicy="no-referrer"
      sandbox="allow-scripts allow-same-origin allow-forms allow-downloads allow-modals allow-popups allow-popups-to-escape-sandbox"
      allowFullScreen />
  </div>
}
