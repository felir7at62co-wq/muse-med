/** Retained frame-image occurrences in input messages, and planned omission of frame images the model has already seen. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-compaction-image-offload/projection'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { SessionSeq, type Session } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-projection'
import { z } from 'zod'

const FRAME_LABEL = /^VIDEO_FRAME (\S+) /u
const GRID_LABEL = /^VIDEO_FRAME_GRID (\S+)\/(\S+) /u

/**
 * Read the `review_id/frame_id` labels a marker text assigns to the images after it: one for a single frame, one per tile
 * for a grid page.
 * @param text - One text block of a tool result or user message.
 * @returns Labels in tile order, or undefined when the text is not a frame marker.
 */
export function frameLabels(text: string): string[] | undefined {
  const grid = GRID_LABEL.exec(text)
  if (grid !== null) return (grid[2] as string).split(',').map(id => `${grid[1]}/${id}`)
  const frame = FRAME_LABEL.exec(text)?.[1]
  return frame === undefined ? undefined : [frame]
}

const occurrenceSchema = z.object({ seq: z.number().int().nonnegative(), index: z.number().int().nonnegative(),
  /** Present when the image came in a Host-injected user message rather than a tool result. */
  host: z.literal(true).optional() })
const stateSchema = z.record(z.string(), z.array(occurrenceSchema))

/** Not yet offloaded image occurrences keyed by `review_id/frame_id`. */
export type FrameImageOccurrences = z.infer<typeof stateSchema>

/** One retained frame-image occurrence. */
export type FrameImageOccurrence = z.infer<typeof occurrenceSchema>

/** Synchronous reader of one Session's frame-image occurrences still present in its current surface. */
export type FrameImageReader = (session: Session) => FrameImageOccurrences

function labelledImages(content: readonly ContentBlock[]): { label: string; index: number }[] {
  const images: { label: string; index: number }[] = []
  let labels: readonly string[] = [], index = 0
  for (const block of content) {
    if (block.type === 'text') labels = frameLabels(block.text) ?? labels
    if (block.type !== 'image') continue
    if (block.offloaded !== true) for (const label of labels) images.push({ label, index })
    index += 1
  }
  return images
}

/**
 * Register the Host-only image-occurrence index and read it against the owning Session's current surface. Compaction
 * can replace message nodes without an image/offload event; those historical occurrences are excluded at read time.
 * @param ctx - Session projection registration owner.
 * @returns Ready reader retained by the calling owner.
 */
export async function installFrameImageState(ctx: Context): Promise<FrameImageReader> {
  const projections = ctx.get('sessionProjections')
  if (projections === undefined) throw Error('Video frame image offload requires sessionProjections')
  const projection = await projections.register<'videoFrameImages', FrameImageOccurrences>({ key: 'videoFrameImages',
    stateSchema, init: () => ({}), stateVersion: 3,
    apply: (state, event) => {
      if (event.type === 'tool/result' || event.type === 'user/message') {
        const images = labelledImages(event.type === 'tool/result' ? event.data.message.content : event.data.content)
        if (images.length === 0) return state
        const next = { ...state }
        const host = event.type === 'user/message' ? { host: true as const } : {}
        for (const image of images) next[image.label] = [...next[image.label] ?? [], { seq: event.seq, index: image.index, ...host }]
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
  return (session) => {
    const state = projection.stateOf(session)
    const nodes = new Set<number>(session.surface.nodes)
    const current: FrameImageOccurrences = {}
    let changed = false
    for (const [label, occurrences] of Object.entries(state)) {
      const retained = occurrences.filter(occurrence => nodes.has(occurrence.seq))
      if (retained.length !== occurrences.length) changed = true
      if (retained.length > 0) current[label] = retained
    }
    return changed ? current : state
  }
}

/**
 * Log one `image/offload` decision for every selected retained frame image; later requests send `notice` after each
 * image identity instead. A grid page is one image shared by its tile labels and is selected only when every label selects it.
 * @param session - Session whose later requests omit the images.
 * @param read - Reader of retained frame-image occurrences.
 * @param select - Whether one retained occurrence of a `review_id/frame_id` label, among all retained occurrences of that
 *   label in log order, is omitted; `tiles` lists every label sharing that image, in label order.
 * @param notice - Model-visible reason logged with the decision.
 * @returns Number of selected image occurrences; zero appends nothing.
 */
export function offloadFrameImages(session: Session, read: FrameImageReader,
  select: (label: string, occurrence: FrameImageOccurrence, occurrences: readonly FrameImageOccurrence[],
    tiles: readonly string[]) => boolean,
  notice: string): number {
  const current = Object.entries(read(session))
  const tiles = new Map<string, string[]>()
  for (const [label, occurrences] of current) {
    for (const { seq, index } of occurrences) tiles.set(`${seq}:${index}`, [...tiles.get(`${seq}:${index}`) ?? [], label])
  }
  const decisions = new Map<string, { occurrence: FrameImageOccurrence; selected: boolean }>()
  for (const [label, occurrences] of current) {
    for (const occurrence of occurrences) {
      const key = `${occurrence.seq}:${occurrence.index}`
      const selected = select(label, occurrence, occurrences, tiles.get(key) as string[])
      const decision = decisions.get(key)
      if (decision === undefined) decisions.set(key, { occurrence, selected })
      else decision.selected &&= selected
    }
  }
  const bySeq = new Map<number, number[]>()
  for (const { occurrence, selected } of decisions.values()) {
    if (selected) bySeq.set(occurrence.seq, [...bySeq.get(occurrence.seq) ?? [], occurrence.index])
  }
  if (bySeq.size === 0) return 0
  const targets = [...bySeq].map(([seq, indexes]) => ({ seq: SessionSeq(seq), imageIndexes: indexes.toSorted((a, b) => a - b) }))
  session.append('image/offload', { targets, notice })
  return targets.reduce((sum, target) => sum + target.imageIndexes.length, 0)
}
