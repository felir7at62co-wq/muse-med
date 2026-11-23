/** Compare recorded versions of one authored shot without changing conversation references. */
import { useState } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { adoptVideoEdition, getAdoptedVideoEdition, type VideoEdition, type VideoEditionSet } from './video-editions.ts'
import css from './VideoWorkspace.module.css'

/** Comparison state belongs to one verified shot group. */
interface VideoEditionControlsProps extends PropsLocale<'sessionVideo'> {
  readonly editions: VideoEditionSet
  readonly onChoose: (edition: VideoEdition) => void
}

/** Put same-shot recordings above the media as a segmented control.
 * @param props - Current recorded shot, comparison candidates and preview action.
 * @returns Aligned preview choices without changing files or the composer.
 */
export function VideoEditionControls({ editions, onChoose, t }: VideoEditionControlsProps) {
  const current = editions.current.source
  return <section className={css.editionControls} aria-label={t('compareVersions')}>
    <div className={css.editionChoices}>
      {editions.items.map(edition => <Button key={edition.source.id} size="sm" variant="ghost"
        aria-pressed={edition.source.id === current.id && edition.source.version === current.version}
        onClick={() => { onChoose(edition) }}>
        {t(edition.number === 1 ? 'originalEdition' : 'revisedEdition', { number: edition.number })}
      </Button>)}
    </div>
    <span className={css.editionScope}>{t('compareVersions')}</span>
  </section>
}

interface VideoEditionAdoptProps extends PropsLocale<'sessionVideo'> {
  readonly sessionId: SessionId
  readonly editions: VideoEditionSet
}

/** Adopt the displayed recording as this browser's preferred version of the shot.
 * @param props - Current comparison group and its owning conversation.
 * @returns Adoption action and any write failure message.
 */
export function VideoEditionAdopt({ sessionId, editions, t }: VideoEditionAdoptProps) {
  const current = editions.current.source
  const [adopted, setAdopted] = useState(() => {
    const edition = getAdoptedVideoEdition(sessionId, editions)
    return edition === null ? null : { id: edition.source.id, version: edition.source.version }
  })
  const [failed, setFailed] = useState(false)
  const isAdopted = adopted?.id === current.id && adopted.version === current.version
  return <div className={css.editionAdopt}>
    <Button size="md" variant="primary" className={css.adoptButton} disabled={isAdopted} title={t('adoptionHint')}
      onClick={() => {
        const saved = adoptVideoEdition(sessionId, editions, editions.current)
        setFailed(!saved)
        if (saved) setAdopted({ id: current.id, version: current.version })
      }}>{t(isAdopted ? 'versionAdopted' : editions.current.number > 1 ? 'adoptRevised' : 'adoptVersion')}</Button>
    {failed && <span role="status" className={css.actionHint}>{t('adoptFailed')}</span>}
  </div>
}
