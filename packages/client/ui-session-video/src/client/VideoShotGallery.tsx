/** Authored shots rendered below the selected recording using its actual footage. */
import { IconPlayTriangleOutlineRegular, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { authoredShots } from './timeline.ts'
import { useVideoFrames } from './video-frames.ts'
import css from './VideoWorkspace.module.css'

type LocatedShot = ReturnType<typeof authoredShots>[number]

interface VideoShotGalleryProps extends PropsLocale<'sessionVideo'> {
  readonly active: boolean
  readonly playbackUrl: string | null
  readonly numbers: readonly number[]
  readonly shots: readonly LocatedShot[]
  readonly selectedId: string | undefined
  readonly onSelect: (shot: LocatedShot) => void
}

/** Show thumbnail cards only for shot ranges observed in the current version.
 * @param props - Visible recording, authored numbers and matching source-local intervals.
 * @returns The shot gallery with unlocated numbers visibly unavailable.
 */
export function VideoShotGallery({ active, playbackUrl, numbers, shots, selectedId, onSelect, t }: VideoShotGalleryProps) {
  const frames = useVideoFrames(active, playbackUrl, shots, true)
  return <div className={css.shots}>
    <div className={css.shotGallery} role="group" aria-label={t('authoredShots')}>
      {numbers.map((number) => {
        const shot = shots.find(item => item.authoredNumber === number)
        const label = t('authoredShot', { index: number })
        const frame = shot === undefined ? undefined : frames[shot.id]
        return <Tooltip key={number} portal label={shot === undefined ? t('shotUnlocated')
          : t('authoredRange', { index: number, start: shot.localStart.toFixed(2), end: shot.localEnd.toFixed(2) })}>
          <span className={css.shotCell}>
            <button type="button" className={css.shotCard} disabled={shot === undefined || playbackUrl === null}
              aria-pressed={shot !== undefined && shot.id === selectedId}
              onClick={shot === undefined ? undefined : () => { onSelect(shot) }}>
              <span className={css.shotThumbnail}>
                {frame === undefined ? <IconPlayTriangleOutlineRegular aria-hidden="true" /> : <img src={frame} alt="" />}
              </span>
              <span className={css.shotLabel}>{label}</span>
            </button>
          </span>
        </Tooltip>
      })}
    </div>
    {shots.length < numbers.length && <small className={css.actionHint}>{t('shotUnlocated')}</small>}
  </div>
}
