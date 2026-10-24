/** Model-authored visual events bound to the actual frame observations that support them. */
import { createHash } from 'node:crypto'
import { z } from 'zod'
import type { ReviewFrame } from './review-state.ts'

/** Optional event notes; identities and action meaning remain the model's interpretation. */
export const reviewEventNoteSchema = z.object({
  event_id: z.string().trim().min(1).max(80), frame_ids: z.array(z.string().min(1)).min(1),
  actor: z.string().trim().max(1000), action: z.string().trim().min(1).max(2000),
  object: z.string().trim().max(1000), before: z.string().trim().max(2000),
  after: z.string().trim().max(2000), uncertainty: z.string().trim().max(2000),
})

/** Saved event notes retain the observation revision and sampled time interval, not inferred action onset. */
export const reviewEventSchema = reviewEventNoteSchema.extend({
  start_seconds: z.number().nonnegative(), end_seconds: z.number().nonnegative(),
  observation_digest: z.string(),
})

/** One optional model-authored event with Host-derived sampled evidence times. */
export type ReviewEvent = z.infer<typeof reviewEventSchema>

function observationDigest(frames: readonly ReviewFrame[]): string {
  return createHash('sha256').update(JSON.stringify(frames.map(frame => ({
    id: frame.id, time: frame.time, observation: frame.observation,
  })))).digest('hex')
}

/**
 * Bind an event batch to current recorded frames without determining whether its description is visually correct.
 * @param notes - Complete replacement event list supplied by the model; empty clears the optional list.
 * @param frames - Actual source revision's frames and observations.
 * @returns Time-ordered event notes with derived evidence intervals and revision digests.
 */
export function bindReviewEvents(notes: z.infer<typeof reviewEventNoteSchema>[], frames: readonly ReviewFrame[]): ReviewEvent[] {
  const ids = new Set<string>()
  return notes.map((note) => {
    if (ids.has(note.event_id)) throw Error(`VIDEO_EVENT_DUPLICATE: ${note.event_id}`)
    ids.add(note.event_id)
    if (new Set(note.frame_ids).size !== note.frame_ids.length) throw Error(`VIDEO_EVENT_FRAME: ${note.event_id}包含重复frame_id。`)
    const evidence = note.frame_ids.map((id) => {
      const frame = frames.find(frame => frame.id === id)
      if (frame?.observation === undefined) throw Error(`VIDEO_EVENT_FRAME: ${id}没有当前视频的已记录观察。`)
      return frame
    }).sort((a, b) => a.time - b.time || a.id.localeCompare(b.id))
    const first = evidence[0], last = evidence.at(-1)
    if (first === undefined || last === undefined) throw Error(`VIDEO_EVENT_FRAME: ${note.event_id}没有引用观察帧。`)
    return { ...note, frame_ids: evidence.map(frame => frame.id), start_seconds: first.time,
      end_seconds: last.time, observation_digest: observationDigest(evidence) }
  }).sort((a, b) => a.start_seconds - b.start_seconds || a.end_seconds - b.end_seconds)
}

/**
 * Report whether an event still refers to the same saved observations.
 * @param event - Saved optional event group.
 * @param frames - Current source revision's recorded frames.
 * @returns Whether all references and their observation digest still match; this does not verify event meaning.
 */
export function reviewEventCurrent(event: ReviewEvent, frames: readonly ReviewFrame[]): boolean {
  const evidence = event.frame_ids.flatMap((id) => {
    const frame = frames.find(frame => frame.id === id)
    return frame?.observation === undefined ? [] : [frame]
  }).sort((a, b) => a.time - b.time || a.id.localeCompare(b.id))
  return evidence.length === event.frame_ids.length && observationDigest(evidence) === event.observation_digest
}

/**
 * Place current model-authored frame notes beside their event summary without verifying its interpretation.
 * @param event - Saved optional event group.
 * @param frames - Current source revision's frames.
 * @returns Referenced current frame notes, with missing observations identified rather than replaced.
 */
export function reviewEventEvidence(event: ReviewEvent, frames: readonly ReviewFrame[]): {
  frame_id: string
  time?: number
  visible?: string
  change?: string
  uncertainty?: string
  status: 'recorded' | 'not_recorded'
}[] {
  return event.frame_ids.map((id) => {
    const frame = frames.find(frame => frame.id === id)
    return { frame_id: id, ...frame === undefined ? {} : { time: frame.time },
      ...frame?.observation, status: frame?.observation === undefined ? 'not_recorded' : 'recorded' }
  })
}
