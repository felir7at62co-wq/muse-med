/** First-run check for a usable model after the Muse account step. */

import { useEffect, type ReactNode } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import { onboardingReadiness } from './store.ts'
import type { DeepSeekOnboardingDialogProps } from './DeepSeekOnboardingDialog.tsx'
import { OnboardingModal } from './OnboardingModal.tsx'
import css from './MuseModelCheck.module.css'

/**
 * Route a Muse user to model settings when no provider can serve requests.
 * @param props - shared Models state and Settings navigation.
 * @returns a model setup prompt while a usable provider is missing.
 */
export function MuseModelCheck({ controller, useModels, complete, openSection, t }: DeepSeekOnboardingDialogProps): ReactNode {
  const state = useModels(snapshot => snapshot)
  const readiness = onboardingReadiness(state)

  useEffect(() => {
    if (state.status === 'idle') void controller.load()
  }, [controller, state.status])
  useEffect(() => {
    if (readiness.kind === 'provider-ready') complete()
  }, [complete, readiness.kind])

  if (readiness.kind === 'loading' || readiness.kind === 'provider-ready') return null
  return <OnboardingModal title={t('museModelTitle')} focusTitle>
    <p className={css.description}>{t(readiness.kind === 'unavailable' ? 'museModelCheckUnavailable' : 'museModelDescription')}</p>
    <div className={css.actions}>
      <Button variant="primary" onClick={() => { complete(); openSection('models') }}>{t('museModelOpenSettings')}</Button>
      {readiness.kind === 'unavailable' ? <Button onClick={() => { void controller.load() }}>{t('museModelRetry')}</Button> : null}
      <Button onClick={complete}>{t('onboardingLater')}</Button>
    </div>
  </OnboardingModal>
}
