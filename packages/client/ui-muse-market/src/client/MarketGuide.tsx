/** First-visit lessons shared by the automatic prompt and manual market guide. */
import { useState, type ReactNode } from 'react'
import { Button, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type { MarketTranslate } from './market-actions.ts'
import css from './MarketGuide.module.css'

const storageKey = 'dsh.muse-market.guide.v1'
const lessons = [
  { titleKey: 'guideFind', bodyKey: 'guideFindBody' },
  { titleKey: 'guideInstall', bodyKey: 'guideInstallBody' },
  { titleKey: 'guideUse', bodyKey: 'guideUseBody' },
] as const

/** Check whether this browser has already dismissed the market guide.
 * @returns Whether the first-visit prompt is available and has not been seen.
 */
export function shouldShowMarketGuide(): boolean {
  try { return window.localStorage.getItem(storageKey) !== 'seen' }
  catch (_error) {
    // The manual guide remains available when local storage is blocked.
    return false
  }
}

/** Record only dismissal of the guide; market and account data stay with their owners. */
export function rememberMarketGuide(): void {
  try { window.localStorage.setItem(storageKey, 'seen') }
  catch (_error) {
    // A storage refusal does not prevent closing the current guide.
  }
}

/** Present the three Skill-market lessons in the shared keyboard-accessible dialog. */
export function MarketGuide({ t, onClose, web = false }: {
  readonly t: MarketTranslate
  readonly onClose: () => void
  readonly web?: boolean
}): ReactNode {
  const [step, setStep] = useState<0 | 1 | 2>(0)
  const lesson = lessons[step]
  const last = step === 2
  return <Modal open onClose={onClose} title={t('guideTitle')} closeLabel={t('guideClose')}
    className={css.guide} contentClassName={css.content} footer={<div className={css.actions}>
      <Button variant="ghost" size="sm" className={css.skip} onClick={onClose}>{t('guideSkip')}</Button>
      {step > 0 && <Button variant="outline" size="sm" onClick={() => { setStep(step === 2 ? 1 : 0) }}>{t('guidePrevious')}</Button>}
      <Button variant="primary" size="sm" data-modal-autofocus onClick={() => {
        if (last) onClose()
        else setStep(step === 0 ? 1 : 2)
      }}>{t(last ? 'guideStart' : 'guideNext')}</Button>
    </div>}>
    <div className={css.lesson} aria-live="polite" aria-atomic="true">
      <div className={css.progress}>{t('guideProgress', { step: String(step + 1), total: String(lessons.length) })}</div>
      <h3>{t(web && step === 1 ? 'guideWebInstall' : web && step === 2 ? 'guideWebUse' : lesson.titleKey)}</h3>
      <p>{t(web && step === 1 ? 'guideWebInstallBody' : web && step === 2 ? 'guideWebUseBody' : lesson.bodyKey)}</p>
    </div>
  </Modal>
}
