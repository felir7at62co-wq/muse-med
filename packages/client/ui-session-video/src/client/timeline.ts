/** Source-preserving coordinates for a conversation filmstrip. */
import type { SessionVideoSource, SessionVideoAnalysis, SessionVideoShot } from '@deepseek-ai/dsh-session-video'

/** Concatenated timeline coordinates retain the original source-local range. */
interface LocatedShot extends SessionVideoShot {
  readonly source: SessionVideoSource
  readonly localStart: number
  readonly localEnd: number
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
    if (analysis === undefined) continue
    for (const shot of analysis.shots) shots.push({ ...shot, index: shots.length + 1, source,
      localStart: shot.startSeconds, localEnd: shot.endSeconds,
      startSeconds: duration + shot.startSeconds, endSeconds: duration + shot.endSeconds })
    duration += analysis.durationSeconds ?? 0
  }
  return { shots, offsets, duration }
}
