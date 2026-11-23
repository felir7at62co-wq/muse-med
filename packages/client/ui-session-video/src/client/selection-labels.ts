/** Human-readable labels retain the production scope of exact video references. */
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { SessionVideoSource } from '@deepseek-ai/dsh-session-video/types'
import type { VideoTarget } from './target-selection.ts'
import { authoredShots, videoClock, type LocatedShot } from './timeline.ts'
import { videoEditions } from './video-editions.ts'

function intervalTime(seconds: number): string {
  const rounded = Math.round(seconds * 100) / 100
  const fraction = rounded.toFixed(2).slice(-3)
  return videoClock(rounded) + (fraction === '.00' ? '' : fraction)
}

/** Summarize the visible shot independently of references added to the draft.
 * @param shot - Observed authored shot or detected segment in one source.
 * @param t - Video workspace dictionary.
 * @param edition - Comparison number when the shot has verified editions.
 * @returns Known episode, segment, original time range and comparison version.
 */
export function videoShotScopeLabel(shot: LocatedShot, t: PropsLocale<'sessionVideo'>['t'], edition?: number): string {
  const labels: string[] = []
  const episode = shot.source.production?.episodeNumber
  if (episode !== undefined) labels.push(t('episodeLabel', { episode }))
  labels.push(t(shot.authoredNumber === undefined ? 'shot' : 'authoredRange', {
    index: shot.index, start: intervalTime(shot.localStart), end: intervalTime(shot.localEnd),
  }))
  if (edition !== undefined) labels.push(t('revisionNumber', { number: edition }))
  return labels.join(' · ')
}

/** Describe a selected source without deriving production identities from filenames.
 * @param source - Recorded source matching the selected version.
 * @param target - Whole source or version-bound original interval.
 * @param t - Video workspace dictionary.
 * @param sources - Current inventory for numbering verified same-shot versions.
 * @returns Episode, authored shot or interval, and source label for the composer.
 */
export function videoSelectionLabel(source: SessionVideoSource, target: VideoTarget, t: PropsLocale<'sessionVideo'>['t'],
  sources: readonly SessionVideoSource[] = []): string {
  const labels: string[] = []
  let authoredNumber: number | undefined
  if (source.production?.episodeNumber !== undefined) labels.push(t('episodeLabel', { episode: source.production.episodeNumber }))
  if (target.kind === 'shot') {
    const authored = authoredShots(source).find(shot => shot.id === target.shotId
      && shot.localStart === target.startSeconds && shot.localEnd === target.endSeconds)
    if (authored !== undefined) {
      authoredNumber = authored.index
      labels.push(t('authoredShot', { index: authored.index }))
    }
    labels.push(t('selectedInterval', { start: target.startSeconds.toFixed(2), end: target.endSeconds.toFixed(2) }))
  } else if (source.production?.packageIndex !== undefined) labels.push(t('videoLabel', { index: source.production.packageIndex }))
  labels.push(source.label)
  const editions = videoEditions(sources, source, authoredNumber)
  if (editions !== null) labels.push(t('editionLabel', { number: editions.current.number }))
  return labels.join(' · ')
}
