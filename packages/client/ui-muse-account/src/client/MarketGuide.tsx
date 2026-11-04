/** First-visit lessons for market discovery and installation. */
import { useState, type ReactNode } from 'react'
import { Button, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type { MarketSectionProps } from './MarketSection.tsx'
import art from './MarketCharacter.module.css'
import css from './MarketGuide.module.css'

const storageKey = 'dsh.muse-market.guide.v1'
const lessons = [
  { titleKey: 'guideKinds', desktop: 'guideKindsBody', web: 'guideKindsBody' },
  { titleKey: 'guideFind', desktop: 'guideFindBody', web: 'guideFindBody' },
  { titleKey: 'guideUse', desktop: 'guideDesktopUseBody', web: 'guideWebUseBody' },
] as const

/** Check whether this client can show its first-visit market guide.
 * @returns False if the guide was dismissed or storage is unavailable.
 */
export function shouldShowMarketGuide(): boolean {
  try {
    return window.localStorage.getItem(storageKey) !== 'seen'
  } catch (_error) {
    // The manual guide remains available when the browser blocks storage.
    return false
  }
}

/** Remember that the user has closed, skipped or finished the guide. */
export function rememberMarketGuide(): void {
  try {
    window.localStorage.setItem(storageKey, 'seen')
  } catch (_error) {
    // Storage failure does not prevent the current guide from closing.
  }
}

/** Show the introduction with steps tailored to the desktop or website.
 * @param props Carrier, localized copy and dismissal action.
 * @returns Keyboard-accessible market guide.
 */
export function MarketGuide({ web, t, onClose }: { web: boolean; t: MarketSectionProps['t']; onClose: () => void }): ReactNode {
  const [step, setStep] = useState<0 | 1 | 2>(0)
  const lesson = lessons[step]
  const last = step === lessons.length - 1
  return <Modal open onClose={onClose} title={t('guideTitle')} closeLabel={t('guideClose')}
    className={css.guide ?? ''} contentClassName={css.content ?? ''} footer={<div className={css.actions}>
      <Button variant="ghost" size="sm" className={css.skip} onClick={onClose}>{t('guideSkip')}</Button>
      {step > 0 && <Button variant="outline" size="sm" onClick={() => { setStep(step === 2 ? 1 : 0) }}>{t('guidePrevious')}</Button>}
      <Button variant="primary" size="sm" data-modal-autofocus onClick={() => {
        if (last) onClose()
        else setStep(step === 0 ? 1 : 2)
      }}>{t(last ? 'guideStart' : 'guideNext')}</Button>
    </div>}>
    <div className={css.lesson} aria-live="polite" aria-atomic="true">
      <div className={css.progress}><span className={art.brandMark} aria-hidden="true" />
        <span>{t('guideProgress', { step: String(step + 1), total: String(lessons.length) })}</span></div>
      <h3>{t(lesson.titleKey)}</h3>
      <p>{t(web ? lesson.web : lesson.desktop)}</p>
    </div>
  </Modal>
}
