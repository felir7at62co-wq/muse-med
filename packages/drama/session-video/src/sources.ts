/** Pure, bounded extraction of explicitly recorded video sources. */
import { createHash } from 'node:crypto'
import { basename, extname, join, win32 } from 'node:path'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import { MEDIA_ALLOWED_ORIGINS } from '@deepseek-ai/dsh-jubian-api'
import { z } from 'zod'

const attachmentSchema = z.object({ attachmentId: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  name: z.string(), bytes: z.number().int().nonnegative() })
const candidateSchema = z.object({ key: z.string(), label: z.string(), origin: z.enum(['workspace', 'presented', 'attachment', 'generated']),
  path: z.string().nullable(), eventSeq: z.number().int().nonnegative(), presentedIndex: z.number().int().nonnegative().nullable(),
  callId: z.string().nullable(), remoteUrl: z.string().nullable(), attachment: attachmentSchema.nullable() })
const callSchema = z.object({ id: z.string(), name: z.string(), taskId: z.number().nullable(), mediaKind: z.string().nullable() })
/** Validates the private projection cache without trusting persisted JSON. */
export const sourceStateSchema = z.object({ sources: z.array(candidateSchema), calls: z.array(callSchema),
  complete: z.boolean(), issues: z.array(z.string()) })
/** One source coordinate retained by the private Session projection. */
export type VideoCandidate = z.infer<typeof candidateSchema>
/** Bounded video facts and unsettled supported-tool calls. */
export type VideoSourceState = z.infer<typeof sourceStateSchema>
/** Deployment limits applied during the complete source fold. */
export interface SourceBounds { readonly maxSources: number; readonly maxResultBytes: number }

const tools = new Set(['jubian_video', 'jubian_media', 'video_generate', 'ffmpeg_cut', 'ffmpeg_concat', 'ffmpeg_encode', 'ffmpeg_adjust'])
/**
 * Read an untrusted durable object without converting arrays to records.
 * @param value - Parsed durable value.
 * @returns Object fields, or undefined for other JSON values.
 */
export function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}
/**
 * Recognize containers supported by the browser playback service.
 * @param value - Recorded local filename.
 * @returns Whether the filename has a supported video extension.
 */
export function videoPath(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && !value.includes('\0')
    && ['.mp4', '.m4v', '.mov', '.webm'].includes(extname(value).toLowerCase())
}
/**
 * Accept only the public media origins the existing Jubian downloader accepts.
 * @param value - Provider media address from a recorded tool result.
 * @returns Whether the address uses an allowed HTTPS origin without credentials.
 */
export function publicJubianVideo(value: string): boolean {
  if (value.length > 16384 || !value.isWellFormed() || /[\u0000-\u0020\u007f]/u.test(value)) return false
  try {
    const url = new URL(value)
    return url.protocol === 'https:' && !url.username && !url.password && !url.hash
      && (MEDIA_ALLOWED_ORIGINS as readonly string[]).includes(url.origin)
  } catch (_error) { return false } // Malformed provider addresses are unavailable sources.
}
/**
 * Compute a deterministic digest for source, version, and range coordinates.
 * @param value - Exact coordinate or version input.
 * @returns Lowercase SHA-256 hexadecimal text.
 */
export function digest(value: string): string { return createHash('sha256').update(value).digest('hex') }

function json(value: unknown, bounds: SourceBounds): Record<string, unknown> | undefined {
  if (typeof value !== 'string') return record(value)
  if (Buffer.byteLength(value) > bounds.maxResultBytes) return undefined
  try { return record(JSON.parse(value)) } catch (_error) { return undefined } // Non-JSON tool text contributes no structured source.
}

/**
 * Fold one event without reading files, invoking providers, or interpreting assistant prose.
 * @param previous - Validated projection state before this event.
 * @param event - Exact durable event and coordinate.
 * @param bounds - Source and tool-result parsing limits.
 * @returns The same state for irrelevant events, otherwise the next bounded state.
 */
export function foldVideoSources(previous: VideoSourceState, event: { seq: number; type: string; data: unknown },
  bounds: SourceBounds): VideoSourceState {
  const data = record(event.data)
  if (!data) return previous
  let state = previous
  let ownsSources = false
  const add = (source: Omit<VideoCandidate, 'key' | 'label' | 'eventSeq'>): void => {
    if (!ownsSources) {
      state = { ...state, sources: [...state.sources], issues: [...state.issues] }
      ownsSources = true
    }
    if (state.sources.length >= bounds.maxSources) {
      state.complete = false
      if (!state.issues.includes('video source inventory limit reached')) state.issues.push('video source inventory limit reached')
      return
    }
    const index = state.sources.filter(item => item.eventSeq === event.seq).length
    // oxlint-disable-next-line typescript/no-non-null-assertion -- Each private caller supplies a local path, attachment or remote URL.
    const path = source.path ?? source.attachment?.name ?? source.remoteUrl!
    // oxlint-disable-next-line typescript/no-non-null-assertion -- split always returns its first field, including for an empty address.
    const label = path.includes('\\') ? win32.basename(path) : basename(path.split('?')[0]!)
    state.sources.push({ ...source, key: `${event.seq}:${index}`, eventSeq: event.seq, label })
  }
  const local = (path: string, origin: VideoCandidate['origin'], callId: string | null = null, presentedIndex: number | null = null): void => {
    if (videoPath(path)) add({ origin, path, callId, presentedIndex, remoteUrl: null, attachment: null })
  }
  if (event.type === 'deliverables/presented' && Array.isArray(data.files)) {
    data.files.forEach((file, index) => { const path = record(file)?.path; if (typeof path === 'string') local(path, 'presented', null, index) })
  } else if (event.type === 'user/message' && Array.isArray(data.content)) {
    for (const block of data.content) {
      const item = record(block)
      if (item?.type === 'file') {
        const parsed = attachmentSchema.safeParse(item.attachment)
        if (parsed.success && videoPath(parsed.data.name)) add({ origin: 'attachment', path: null, callId: null,
          presentedIndex: null, remoteUrl: null, attachment: parsed.data })
      } else if (item?.type === 'text' && typeof item.text === 'string') {
        // Desktop file chips serialize with the shared @path / @"quoted path" grammar.
        for (const match of item.text.matchAll(/(?:^|\s)@(?:"([^"\r\n]+)"|([^\s]+))/gu)) {
          // oxlint-disable-next-line typescript/no-non-null-assertion -- The pattern requires one nonempty quoted or unquoted path.
          const path = match[1] ?? match[2]!
          if (!/^[a-z]+:\/\//i.test(path)) local(path, 'workspace')
        }
      }
    }
  } else if (event.type === 'tool/call' && typeof data.callId === 'string' && typeof data.name === 'string' && tools.has(data.name)) {
    if (previous.calls.length >= bounds.maxSources) return { ...previous, complete: false,
      issues: previous.issues.includes('unsettled video call limit reached') ? previous.issues : [...previous.issues, 'unsettled video call limit reached'] }
    const args = json(data.arguments, bounds)
    state = { ...previous, calls: [...previous.calls, { id: data.callId, name: data.name,
      taskId: typeof args?.task_id === 'number' ? args.task_id : null, mediaKind: typeof args?.media_kind === 'string' ? args.media_kind : null }] }
  } else if (event.type === 'tool/result') {
    const message = record(data.message)
    if (!message) return previous
    const call = previous.calls.find(item => item.id === message.toolCallId)
    if (!call) return previous
    state = { ...previous, calls: previous.calls.filter(item => item !== call) }
    if (message.isError === true || !Array.isArray(message.content)) return state
    if (call.name === 'video_generate') {
      const name = record(data.meta)?.fileName
      if (typeof name === 'string' && /^[\w.-]+\.mp4$/i.test(name)) {
        local(join(dshHomePath('plugins', 'subscriptions', 'videos'), name), 'generated', call.id)
      }
    }
    for (const block of message.content) {
      const item = record(block)
      if (item?.type !== 'text') continue
      if (typeof item.text === 'string' && Buffer.byteLength(item.text) > bounds.maxResultBytes) {
        state = { ...state, complete: false, issues: [...state.issues, 'video tool result exceeds parsing limit'] }
        continue
      }
      const result = json(item.text, bounds)
      if (!result) continue
      if (call.name === 'jubian_media' && call.mediaKind === 'video' && typeof result.path === 'string') local(result.path, 'generated', call.id)
      if (call.name.startsWith('ffmpeg_') && typeof result.output === 'string') local(result.output, 'workspace', call.id)
      if (call.name !== 'jubian_video') continue
      const subtasks = record(result.subtasks)
      const sources = record(result.sources)
      const rows = Array.isArray(subtasks?.rows) ? subtasks.rows : Array.isArray(sources?.sources) ? sources.sources : []
      for (const raw of rows) {
        const row = record(raw)
        if (!row || typeof row.video_url !== 'string' || typeof row.status !== 'string'
          || !['succeeded', 'completed', 'success'].includes(row.status.toLowerCase())) continue
        if (subtasks && (call.taskId === null || row.parent_task_id !== call.taskId)) continue
        add({ origin: 'generated', path: null, callId: call.id, presentedIndex: null, remoteUrl: row.video_url, attachment: null })
      }
    }
  }
  return state
}
