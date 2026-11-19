/** Shared navigation and request-failure feedback for account usage pages. */

import type { ReactNode } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type { MuseAccountSectionProps } from './MuseAccountSection.tsx'
import css from './MuseAccountDetails.module.css'

interface UsageFooterProps extends Pick<MuseAccountSectionProps, 't'> {
  readonly busy: boolean
  readonly failed: boolean
  readonly start: number
  readonly end: number
  readonly total: number
  readonly onPrevious?: (() => void) | undefined
  readonly onNext?: (() => void) | undefined
}

/**
 * Display available usage navigation and retain request failures beside the current page.
 * @param props - Localized page bounds, loading state and available navigation actions.
 * @returns Page controls and an optional in-place failure notice.
 */
export function MuseAccountUsageFooter(props: UsageFooterProps): ReactNode {
  const { t, busy, failed, start, end, total, onPrevious, onNext } = props
  return <>
    <div className={css.toolbar}>
      <Button disabled={busy || onPrevious === undefined} onClick={onPrevious}>{t('previousPage')}</Button>
      <p className={css.note}>{t('usagePage', { start, end, total })}</p>
      <Button disabled={busy || onNext === undefined} onClick={onNext}>{t('nextPage')}</Button>
    </div>
    {failed ? <p className={css.note} role="status">{t('detailsUnavailable')}</p> : null}
  </>
}
