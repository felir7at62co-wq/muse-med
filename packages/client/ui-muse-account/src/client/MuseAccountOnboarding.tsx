/** Muse first-run account step using the same credential form as Settings. */

import { useEffect, type ReactNode } from 'react'
import { Button, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { MuseAccountSection, type MuseAccountInjected } from './MuseAccountSection.tsx'
import css from './MuseAccountOnboarding.module.css'

/**
 * Ask for the Muse KB account before the model readiness step.
 * @param props - account operations and onboarding completion.
 * @returns the first-run dialog.
 */
export function MuseAccountOnboarding(props: PropsRuntime<'settings.onboarding'> & PropsLocale<'settings.museAccount'> & InjectFace<MuseAccountInjected>): ReactNode {
  const { complete, t } = props
  useEffect(() => {
    const root = document.getElementById('root')
    if (root === null) return
    const previous = root.inert
    root.inert = true
    return () => { root.inert = previous }
  }, [])
  return <Modal open title={t('onboardingTitle')} onClose={() => {}} headless className={css.dialog as string}>
    <div className={css.content}>
      <h2 className={css.title}>{t('onboardingTitle')}</h2>
      <p className={css.description}>{t('onboardingDescription')}</p>
      <MuseAccountSection {...props} close={() => {}} onSignedIn={complete} />
      <div className={css.actions}>
        <Button onClick={complete}>{t('onboardingLater')}</Button>
      </div>
    </div>
  </Modal>
}
