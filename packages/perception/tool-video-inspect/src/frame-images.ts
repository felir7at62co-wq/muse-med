/** Retained frame-image occurrences in input messages, and planned omission of frame images the model has already seen. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-compaction-image-offload/projection'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { SessionSeq, type Session } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-projection'
import { z } from 'zod'

const FRAME_LABEL = /^VIDEO_FRAME (\S+) /u
const occurrenceSchema = z.object({ seq: z.number().int().nonnegative(), index: z.number().int().nonnegative() })
const stateSchema = z.record(z.string(), z.array(occurrenceSchema))

/** Retained, not yet offloaded image occurrences keyed by `review_id/frame_id`. */
export type FrameImageOccurrences = z.infer<typeof stateSchema>

/** Synchronous reader of one Session's retained frame-image occurrences. */
export type FrameImageReader = (session: Session) => FrameImageOccurrences

function labelledImages(content: readonly ContentBlock[]): { label: string; index: number }[] {
  const images: { label: string; index: number }[] = []
  let label: string | undefined, index = 0
  for (const block of content) {
    if (block.type === 'text') label = FRAME_LABEL.exec(block.text)?.[1] ?? label
    if (block.type !== 'image') continue
    if (label !== undefined && block.offloaded !== true) images.push({ label, index })
    index += 1
  }
  return images
}

/**
 * Register the Host-only projection of labelled frame images in tool results and Host-injected user messages that later
 * model requests would still resend. State grows with retained frame images and shrinks as `image/offload` decisions
 * select them.
 * @param ctx - Session projection registration owner.
 * @returns Ready reader retained by the calling owner.
 */
export async function installFrameImageState(ctx: Context): Promise<FrameImageReader> {
  const projections = ctx.get('sessionProjections')
  if (projections === undefined) throw Error('Video frame image offload requires sessionProjections')
  const projection = await projections.register<'videoFrameImages', FrameImageOccurrences>({ key: 'videoFrameImages',
    stateSchema, init: () => ({}), stateVersion: 2,
    apply: (state, event) => {
      if (event.type === 'tool/result' || event.type === 'user/message') {
        const images = labelledImages(event.type === 'tool/result' ? event.data.message.content : event.data.content)
        if (images.length === 0) return state
        const next = { ...state }
        for (const image of images) next[image.label] = [...next[image.label] ?? [], { seq: event.seq, index: image.index }]
        return next
      }
      if (event.type !== 'image/offload') return state
      const selected = new Set(event.data.targets.flatMap(target => target.imageIndexes.map(index => `${target.seq}:${index}`)))
      let changed = false
      const next: FrameImageOccurrences = {}
      for (const [label, occurrences] of Object.entries(state)) {
        const kept = occurrences.filter(occurrence => !selected.has(`${occurrence.seq}:${occurrence.index}`))
        if (kept.length !== occurrences.length) changed = true
        if (kept.length > 0) next[label] = kept
      }
      return changed ? next : state
    } })
  return session => projection.stateOf(session)
}

/**
 * Log one `image/offload` decision for every selected retained frame image; later requests send placeholder text instead.
 * @param session - Session whose later requests omit the images.
 * @param read - Reader of retained frame-image occurrences.
 * @param select - Whether the image of one `review_id/frame_id` label recorded at one event seq is omitted.
 * @returns Number of selected image occurrences; zero appends nothing.
 */
export function offloadFrameImages(session: Session, read: FrameImageReader,
  select: (label: string, seq: number) => boolean): number {
  const bySeq = new Map<number, number[]>()
  for (const [label, occurrences] of Object.entries(read(session))) {
    for (const occurrence of occurrences) {
      if (select(label, occurrence.seq)) bySeq.set(occurrence.seq, [...bySeq.get(occurrence.seq) ?? [], occurrence.index])
    }
  }
  if (bySeq.size === 0) return 0
  const targets = [...bySeq].map(([seq, indexes]) => ({ seq: SessionSeq(seq), imageIndexes: indexes.toSorted((a, b) => a - b) }))
  session.append('image/offload', { targets })
  return targets.reduce((sum, target) => sum + target.imageIndexes.length, 0)
}
