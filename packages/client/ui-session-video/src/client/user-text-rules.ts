/** Compact presentation applies only to this plugin's validated selection envelope. */
import { z } from 'zod'
import type { UserTextRule } from '@deepseek-ai/dsh-client-ui-conversation/client'
import { parseVideoWorkspaceAddress, VIDEO_SELECTION_CLOSE, VIDEO_SELECTION_OPEN } from './target-selection.ts'

const positiveId = z.number().int().positive()
const production = z.object({ scriptId: positiveId, episodeId: positiveId.optional(), episodeNumber: positiveId.optional(),
  packageIndex: positiveId.optional(), storyboardId: positiveId.optional(), taskId: positiveId.optional(),
  subtaskId: positiveId.optional(), shotNumbers: z.array(positiveId).optional() }).strict()
const selection = z.object({ source_id: z.string().min(1), source_version: z.string().min(1), label: z.string().min(1),
  path: z.string().nullable(), remote_url: z.string().nullable(), review_link: z.string().min(1),
  event_seq: z.number().int().nonnegative(), presented_index: z.number().int().nonnegative().nullable(),
  call_id: z.string().nullable(), production: production.optional(), shot_id: z.string().min(1).optional(),
  start_seconds: z.number().nonnegative().optional(), end_seconds: z.number().positive().optional(),
}).strict().superRefine((value, context) => {
  const parsed = parseVideoWorkspaceAddress(value.review_link)
  const target = parsed?.target
  const hasSegment = value.shot_id !== undefined || value.start_seconds !== undefined || value.end_seconds !== undefined
  const matches = target !== undefined && target.sourceId === value.source_id && target.sourceVersion === value.source_version
    && (hasSegment ? target.kind === 'shot' && target.shotId === value.shot_id
      && target.startSeconds === value.start_seconds && target.endSeconds === value.end_seconds : target.kind === 'source')
  if (!matches || new URL(value.review_link).hash !== '') context.addIssue({ code: 'custom', message: 'Selection link does not match its recorded coordinates' })
})
const selections = z.array(selection).nonempty()

/** JSON data retained by one compact sent-message node. */
export interface VideoSelectionData {
  readonly sessionId: string
  readonly items: readonly {
    readonly label: string
    readonly reviewLink: string
    readonly startSeconds?: number
    readonly endSeconds?: number
  }[]
}

declare module '@deepseek-ai/dsh-client-ui-conversation/client' {
  interface UserTextDataMap {
    /** Explicit plugin evidence rendered compactly without changing the logged user message. */
    'muse-video-selection': VideoSelectionData
  }
}

/** Parse only this plugin's JSON fields and self-consistent source navigation links.
 * @param text - JSON inside one complete selection envelope.
 * @returns Compact labels and links for one Session, or null without modifying the text.
 */
export function parseVideoSelectionData(text: string): VideoSelectionData | null {
  let value: unknown
  try { value = JSON.parse(text) } catch (_error: unknown) { return null /* Invalid evidence remains ordinary user text. */ }
  const parsed = selections.safeParse(value)
  if (!parsed.success) return null
  const first = parsed.data.at(0)
  if (first === undefined) return null
  const sessionId = parseVideoWorkspaceAddress(first.review_link)?.sessionId
  if (sessionId === undefined || parsed.data.some(item => parseVideoWorkspaceAddress(item.review_link)?.sessionId !== sessionId)
    || new Set(parsed.data.map(item => item.review_link)).size !== parsed.data.length) return null
  return { sessionId, items: parsed.data.map(item => ({ label: item.label, reviewLink: item.review_link,
    ...(item.start_seconds === undefined ? {} : { startSeconds: item.start_seconds }),
    ...(item.end_seconds === undefined ? {} : { endSeconds: item.end_seconds }) })) }
}

/** Match the next valid owned envelope; arbitrary JSON and malformed evidence stay visible. */
export const videoSelectionRule: UserTextRule<'muse-video-selection'> = {
  id: 'muse-video-selection', order: 20,
  match(text, from) {
    for (let start = text.indexOf(VIDEO_SELECTION_OPEN, from); start !== -1;
      start = text.indexOf(VIDEO_SELECTION_OPEN, start + VIDEO_SELECTION_OPEN.length)) {
      const body = start + VIDEO_SELECTION_OPEN.length
      const close = text.indexOf(VIDEO_SELECTION_CLOSE, body)
      if (close === -1) return undefined
      const data = parseVideoSelectionData(text.slice(body, close))
      if (data !== null) return { id: 'muse-video-selection', start, end: close + VIDEO_SELECTION_CLOSE.length, data }
    }
    return undefined
  },
}
