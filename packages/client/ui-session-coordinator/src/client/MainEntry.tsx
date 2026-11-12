/** Dedicated profile-wide routing conversation in the workspace region. */
import { useRef, useState } from 'react'
import { Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { NS } from './locales.ts'
import css from './MainEntry.module.css'

/** Host-owned creation and native navigation action. */
export interface MainEntryActions {
  readonly openMain: () => Promise<void>
}

type Props = Pick<PropsRuntime<'sidebar.workspaces.entry'>, 'wide' | 'useRemoteAccess'> & PropsLocale<typeof NS> & MainEntryActions

/**
 * Show the Muse spider entry in the full sidebar or compact rail.
 * @param props - Sidebar geometry, localized label and owner-only open action.
 * @returns accessible routing entry with duplicate-click suppression.
 */
export function MainEntry({ wide, openMain, t, useRemoteAccess }: Props) {
  const allowed = useRemoteAccess('sessionCoordinator/openMain')
  const pendingRef = useRef(false)
  const [pending, setPending] = useState(false)
  if (!allowed) return null
  const open = async (): Promise<void> => {
    if (pendingRef.current) return
    pendingRef.current = true
    setPending(true)
    try { await openMain() }
    finally { pendingRef.current = false; setPending(false) }
  }
  return <Tooltip label={t('mainEntry')} disabled={wide} side="right">
    <button type="button" className={`${css.entry} ${wide ? css.wide : css.rail}`} disabled={pending}
      aria-label={t('mainEntry')} data-muse-main-entry onClick={() => { void open() }}>
      <span className={css.spider} aria-hidden="true" />
      {wide && <span>{t('mainEntry')}</span>}
    </button>
  </Tooltip>
}
