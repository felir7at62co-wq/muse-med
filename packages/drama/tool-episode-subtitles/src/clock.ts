/**
 * Place shot-local cues on the episode clock.
 *
 * A cue measured in source-file seconds maps to `clipStart + (t − clipIn) / speed`, intersected with the played
 * window. Local whole-file shots play from 0 at speed 1 for their measured picture duration; Jingliu shots carry
 * their trim window and speed. The clock is computed again on every build, so a trim never leaves old offsets.
 */
import type { ShotCue, ShotWindow } from './types.ts'

/**
 * Map a source-file span into the played window of one shot.
 * @param window - Played source range and speed.
 * @param start - Span start in source seconds.
 * @param end - Span end in source seconds.
 * @returns `[offset from the shot's output start, output duration]` in seconds, or undefined outside the window.
 */
export function sourceSpan(window: ShotWindow, start: number, end: number): readonly [number, number] | undefined {
  const inSeconds = window.clipInUs / 1_000_000, outSeconds = inSeconds + window.durationUs / 1_000_000
  const from = Math.max(start, inSeconds), to = Math.min(end, outSeconds)
  if (to <= from) return undefined
  return [(from - inSeconds) / window.speed, (to - from) / window.speed]
}

/** One cue on the episode clock. */
export interface PlacedShotCue {
  readonly startSeconds: number
  readonly endSeconds: number
  readonly text: string
  /** Index of the cue in the shot's cue list. */
  readonly cue: number
}

/** A cue the window clipped or removed. */
export interface CutCue {
  readonly cue: number
  readonly text: string
  /** Shot-local source span of the original cue. */
  readonly start: number
  readonly end: number
  readonly dropped: boolean
}

function milliseconds(seconds: number): number {
  return Math.round(seconds * 1000) / 1000
}

/**
 * Place one shot's cues.
 * @param cues - Cues in shot-local source seconds.
 * @param window - Played source range and speed.
 * @param clipStartSeconds - Where the shot starts on the episode clock.
 * @returns Placed cues rounded to milliseconds, and every cue the window clipped or removed.
 */
export function placeShotCues(cues: readonly ShotCue[], window: ShotWindow, clipStartSeconds: number):
{ placed: PlacedShotCue[]; cut: CutCue[] } {
  const placed: PlacedShotCue[] = [], cut: CutCue[] = []
  const inSeconds = window.clipInUs / 1_000_000, outSeconds = inSeconds + window.durationUs / 1_000_000
  for (const [index, cue] of cues.entries()) {
    const span = sourceSpan(window, cue.start, cue.end)
    const startSeconds = span === undefined ? 0 : milliseconds(clipStartSeconds + span[0])
    const endSeconds = span === undefined ? 0 : milliseconds(clipStartSeconds + span[0] + span[1])
    const kept = span !== undefined && endSeconds > startSeconds
    if (kept) placed.push({ startSeconds, endSeconds, text: cue.text, cue: index })
    if (!kept || cue.start < inSeconds || cue.end > outSeconds) {
      cut.push({ cue: index, text: cue.text, start: cue.start, end: cue.end, dropped: !kept })
    }
  }
  return { placed, cut }
}
