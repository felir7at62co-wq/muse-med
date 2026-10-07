/** Scene and utterance observations with explicit deferred coverage. */
import Schema from '@deepseek-ai/schemastery'

/** One requested observation and the source events that selected it. */
export interface ObservationPoint {
  /** Requested source timecode in seconds. */
  time: number
  /** Detected cuts, utterance midpoints, or uniform coverage checkpoints. */
  reasons: string[]
}

/** Bounded observation selection; deferred points have not been viewed. */
export interface AdaptivePlan {
  /** Event-based selection mode. */
  strategy: 'scene_dialogue'
  /** Requested points for this sampling call. */
  selected: ObservationPoint[]
  /** Remaining event observations requiring a later explicit sampling call. */
  deferred: ObservationPoint[]
}

const segments: Schema<{ start: number; end: number; text: string; speaker_id?: string }[]> = Schema.array(Schema.object({
  start: Schema.number().min(0).required(), end: Schema.number().min(0).required(),
  text: Schema.string().required(), speaker_id: Schema.string().min(1),
}))
const transcriptSchema = Schema.union([segments, Schema.object({ segments: segments.required() })])

/**
 * Read scene-filter metadata emitted to stdout by FFmpeg.
 * @param bytes - Bounded UTF-8 metadata output, possibly empty when no cut is detected.
 * @param start - Inclusive source range start.
 * @param end - Exclusive source range end.
 * @returns Verified source timecodes for the detected frame transitions.
 */
export function sceneTimecodes(bytes: Uint8Array, start: number, end: number): number[] {
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  const times: number[] = []
  for (const match of text.matchAll(/\bpts_time:(\S+)/g)) {
    const time = Number(match[1])
    if (!Number.isFinite(time) || time < start || time >= end) throw Error('Scene detector returned an invalid source timecode')
    times.push(time)
  }
  return [...new Set(times)].sort((a, b) => a - b)
}

/**
 * Spread observations across the range, prioritizing cuts and utterances within each temporal bucket.
 * @param input - Verified range, uniform fallback points, detected cuts and optional raw ASR JSON.
 * @param limits - Maximum returned frames, candidate points and cut-adjacent time offset.
 * @returns Chronological selected and deferred observations; no character identity is inferred.
 */
export function adaptivePlan(input: {
  start: number
  end: number
  duration: number
  uniform: readonly number[]
  cuts: readonly number[]
  transcript?: unknown
}, limits: { maxFrames: number; maxPlanPoints: number; scenePaddingSeconds: number }): AdaptivePlan {
  const points = new Map<number, { point: ObservationPoint; priority: number }>()
  const add = (time: number, reason: string, priority: number): void => {
    if (time < input.start || time >= input.end) return
    const previous = points.get(time)
    if (previous !== undefined) {
      if (!previous.point.reasons.includes(reason)) previous.point.reasons.push(reason)
      previous.priority = Math.min(previous.priority, priority)
    } else points.set(time, { point: { time, reasons: [reason] }, priority })
  }
  for (const time of input.uniform) add(time, 'uniform_checkpoint', 2)
  for (const time of input.cuts) {
    add(Math.max(input.start, time - limits.scenePaddingSeconds), 'before_scene_cut', 0)
    add(Math.min(input.end - Number.EPSILON * Math.max(1, input.end), time + limits.scenePaddingSeconds), 'after_scene_cut', 0)
  }
  if (input.transcript !== undefined) {
    const parsed = transcriptSchema(input.transcript)
    const utterances = Array.isArray(parsed) ? parsed : parsed.segments
    let previousSpeaker: string | undefined
    for (const row of utterances) {
      if (row.end < row.start || row.end > input.duration) throw Error('Transcript timecodes exceed the verified video source')
      const changed = row.speaker_id !== undefined && row.speaker_id !== previousSpeaker
      if (row.speaker_id !== undefined) previousSpeaker = row.speaker_id
      if (row.start >= input.end || row.end < input.start) continue
      const midpoint = (Math.max(row.start, input.start) + Math.min(row.end, input.end)) / 2
      add(midpoint, changed ? 'speaker_change_utterance' : 'utterance_midpoint', 1)
    }
  }
  if (points.size > limits.maxPlanPoints) throw Error('Adaptive observation plan exceeds its point budget; inspect a shorter interval')
  const ordered = [...points.values()].sort((a, b) => a.priority - b.priority || a.point.time - b.point.time)
  const selected = new Set<typeof ordered[number]>()
  const span = input.end - input.start
  for (let bucket = 0; bucket < limits.maxFrames; bucket++) {
    const start = input.start + span * bucket / limits.maxFrames
    const end = input.start + span * (bucket + 1) / limits.maxFrames
    const center = (start + end) / 2
    const candidates = ordered.filter(value => value.point.time >= start && value.point.time < end)
      .sort((a, b) => a.priority - b.priority || Math.abs(a.point.time - center) - Math.abs(b.point.time - center)
        || a.point.time - b.point.time)
    const choice = candidates[0]
    if (choice !== undefined) selected.add(choice)
  }
  for (const value of ordered) {
    if (selected.size >= limits.maxFrames) break
    selected.add(value)
  }
  const chronological = (values: typeof ordered): ObservationPoint[] => values.map(value => value.point).sort((a, b) => a.time - b.time)
  return { strategy: 'scene_dialogue', selected: chronological([...selected]), deferred: chronological(ordered.filter(value => !selected.has(value))) }
}
