/** Source-preserving coordinates for a conversation filmstrip. */
import type { SessionVideoSource, SessionVideoAnalysis, SessionVideoShot } from '@deepseek-ai/dsh-session-video/types'
import type { SessionVideoShotId } from '@deepseek-ai/dsh-session-video/types'
import { brandString } from '@deepseek-ai/dsh-brand'

/** Concatenated timeline coordinates retain the original source-local range. */
interface LocatedShot extends SessionVideoShot {
  readonly authoredNumber?: number
  readonly source: SessionVideoSource
  readonly localStart: number
  readonly localEnd: number
}

/** Locate authored shots only from observed, version-bound production intervals.
 * @param source - Current video with verified production metadata.
 * @returns Source-local ranges independent of automatically detected cuts.
 */
export function authoredShots(source: SessionVideoSource): LocatedShot[] {
  return (source.production?.shotRanges ?? []).map(range => ({
    id: brandString<SessionVideoShotId>(`authored:${source.id}:${source.version}:${range.shotNumber}:${range.startSeconds}:${range.endSeconds}`),
    index: range.shotNumber, authoredNumber: range.shotNumber, source, thumbnail: null,
    startSeconds: range.startSeconds, endSeconds: range.endSeconds, localStart: range.startSeconds, localEnd: range.endSeconds,
  }))
}

/** Assemble complete analyses without claiming unknown sources contain one shot.
 * @param sources - Chronological Session sources.
 * @param analyses - Version-bound completed observations.
 * @returns Concatenated shots and source offsets.
 */
export function assembleTimeline(sources: readonly SessionVideoSource[], analyses: readonly SessionVideoAnalysis[]): {
  shots: LocatedShot[]
  offsets: Record<string, number>
  duration: number
} {
  const shots: LocatedShot[] = []
  const offsets: Record<string, number> = {}
  let duration = 0
  for (const source of sources) {
    const analysis = analyses.find(value => value.sourceId === source.id && value.sourceVersion === source.version && value.state === 'ready')
    offsets[source.id] = duration
    if (analysis === undefined || source.status !== 'local' || source.playbackUrl === null) continue
    for (const shot of analysis.shots) shots.push({ ...shot, index: shots.length + 1, source,
      localStart: shot.startSeconds, localEnd: shot.endSeconds,
      startSeconds: duration + shot.startSeconds, endSeconds: duration + shot.endSeconds })
    duration += analysis.durationSeconds ?? 0
  }
  return { shots, offsets, duration }
}
