/** Current-task successful text-read receipts, reconstructed by the Session projection registry. */
import type { Context } from '@deepseek-ai/cordis'
import { createHash } from 'node:crypto'
import { ToolCallId, type UserMessage } from '@deepseek-ai/dsh-llm'
import { SessionSeq, type Session } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-projection'
import type { VideoTranscriptCandidates } from '@deepseek-ai/dsh-tool-video-inspect'
import { z } from 'zod'

const textReadSchema = z.object({ path: z.string(), readCallId: z.string().transform(ToolCallId),
  readResultSeq: z.number().int().nonnegative().transform(SessionSeq), offset: z.number().int().positive(),
  returnedLines: z.number().int().nonnegative(), totalLines: z.number().int().nonnegative(),
  status: z.enum(['complete', 'partial', 'truncated', 'snapshot_over_budget']), episodeLabels: z.array(z.string()),
  readWindowSha256: z.string(), readTextSha256: z.string().optional(), text: z.string().optional() })
const readWindowSchema = z.object({ offset: z.number().int().positive(), totalLines: z.number().int().nonnegative(),
  lines: z.array(z.object({ number: z.number().int().positive(), text: z.string() })) })
const readStateSchema = z.object({ cwd: z.string(), taskStartSeq: z.number().int().nonnegative().transform(SessionSeq).optional(),
  pending: z.array(z.string().transform(ToolCallId)),
  reads: z.array(z.object({ path: z.string(), readCallId: z.string().transform(ToolCallId),
    readResultSeq: z.number().int().nonnegative().transform(SessionSeq) })),
  textReads: z.array(textReadSchema), omittedTextReads: z.number().int().nonnegative() })
type ReadState = z.infer<typeof readStateSchema>

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionStateMap { manuscriptVideoReads: ReadState }
}

/**
 * Fold real read-result metadata into task-scoped receipts without synchronous historical event reads.
 * @param ctx - Registry scope owning registration and teardown.
 * @param declaresOutput - Recognizes a real user's explicit output task; generic continuation preserves its receipts.
 * @param limits - Existing manuscript budgets bound retained text snapshots and their count.
 */
export function installManuscriptVideoReads(ctx: Context, declaresOutput: (message: UserMessage, cwd: string) => boolean,
  limits: { maxTextChars: number; maxDocuments: number; maxLedgerBytes: number }): void {
  ctx.sessionProjections.register({ key: 'manuscriptVideoReads', stateSchema: readStateSchema, stateVersion: 2,
    init: header => ({ cwd: header.cwd ?? '', pending: [], reads: [], textReads: [], omittedTextReads: 0 }),
    apply: (state, event) => {
      if (event.type === 'user/message' && event.data.source.kind === 'user'
        && (state.taskStartSeq === undefined || declaresOutput(event.data, state.cwd))) {
        return { cwd: state.cwd, taskStartSeq: event.seq, pending: [], reads: [], textReads: [], omittedTextReads: 0 }
      }
      if (event.type === 'assistant/message') {
        const ids = event.data.message.content.flatMap(block => block.type === 'tool-call' && block.name === 'read' ? [block.id] : [])
        return ids.length ? { ...state, pending: [...state.pending, ...ids] } : state
      }
      if (event.type !== 'tool/result' || !state.pending.includes(event.data.message.toolCallId)) return state
      const pending = state.pending.filter(id => id !== event.data.message.toolCallId)
      const meta = z.object({ path: z.string() }).safeParse(event.data.meta)
      if (event.data.message.isError || !meta.success || state.taskStartSeq === undefined) {
        return { ...state, pending }
      }
      if (/\.json$/iu.test(meta.data.path)) return { ...state, pending, reads: [...state.reads,
        { path: meta.data.path, readCallId: event.data.message.toolCallId, readResultSeq: event.seq }] }
      const window = readWindowSchema.safeParse(event.data.meta)
      if (!/\.(?:md|txt)$/iu.test(meta.data.path) || !window.success) return { ...state, pending }
      const { lines, totalLines, offset } = window.data, text = lines.map(line => line.text).join('\n')
      const readWindowSha256 = createHash('sha256').update(text).digest('hex')
      const complete = offset === 1 && lines.length === totalLines && lines.every((line, index) => line.number === index + 1)
      const truncated = lines.some(line => /\.\.\. \(line truncated to \d+ chars\)$/u.test(line.text))
      const episodeLabels = [...new Set(lines.flatMap(({ text }) => {
        const line = text.replace(/^\s*#{1,6}\s*/u, '').trim()
        const episode = /^第\s*([\d一二三四五六七八九十百零〇]+)\s*集/u.exec(line)?.[1]
          ?? /^(\d+)\s*[-—－]\s*\d+(?:\s|[.、])/u.exec(line)?.[1]
        return episode === undefined ? [] : [episode]
      }))]
      if (state.textReads.some(read => read.path === meta.data.path && read.offset === offset
        && read.returnedLines === lines.length && read.totalLines === totalLines && read.readWindowSha256 === readWindowSha256)) {
        return { ...state, pending }
      }
      const knownPaths = new Set(state.textReads.map(read => read.path))
      if (!knownPaths.has(meta.data.path) && knownPaths.size >= limits.maxDocuments) {
        return { ...state, pending, omittedTextReads: state.omittedTextReads + 1 }
      }
      const otherComplete = state.textReads.filter(read => read.path !== meta.data.path || read.status !== 'complete')
      const retain = complete && !truncated && text.length <= limits.maxTextChars
        && otherComplete.reduce((sum, read) => sum + Buffer.byteLength(read.text ?? ''), 0) + Buffer.byteLength(text) <= limits.maxLedgerBytes
      const read: z.infer<typeof textReadSchema> = { path: meta.data.path, readCallId: event.data.message.toolCallId,
        readResultSeq: event.seq, offset, returnedLines: lines.length, totalLines, episodeLabels, readWindowSha256,
        status: truncated ? 'truncated' : !complete ? 'partial' : retain ? 'complete' : 'snapshot_over_budget',
        ...retain ? { text, readTextSha256: readWindowSha256 } : {} }
      const previous = state.textReads.filter(previous => previous.path !== read.path
        || (previous.status === 'complete') !== retain)
      return { ...state, pending, textReads: [...previous, read] }
    },
  })
}

/**
 * Return actual current-task read receipts; the video provider validates file identity, ASR format and source-directory candidates.
 * @param ctx - Registry with the Host read-receipt projection installed.
 * @param session - Current author Session.
 * @returns Current-task successful JSON reads, or undefined before any real user task.
 */
export function manuscriptVideoReadCandidates(ctx: Context, session: Session): VideoTranscriptCandidates | undefined {
  const state = ctx.sessionProjections.stateOf(session, 'manuscriptVideoReads')
  return state?.taskStartSeq === undefined ? undefined : { taskStartSeq: state.taskStartSeq, reads: state.reads }
}

/**
 * Return bounded actual native text-read snapshots without inferring an adopted manuscript or reading a changed file as its old version.
 * @param ctx - Registry owning the task-scoped read projection.
 * @param session - Current author Session; persisted metadata reconstructs snapshots on resume.
 * @returns Actual complete snapshots and partial-read diagnostics for this task, or undefined before its first user input.
 */
export function manuscriptTextReadSnapshots(ctx: Context, session: Session) {
  const state = ctx.sessionProjections.stateOf(session, 'manuscriptVideoReads')
  return state?.taskStartSeq === undefined ? undefined : { taskStartSeq: state.taskStartSeq,
    reads: state.textReads, omitted: state.omittedTextReads }
}

/**
 * Match the native read tool's line text while retaining internal and trailing blank lines.
 * @param text - Complete actual file text, not a preview or formatted tool output.
 * @returns CRLF-normalized text without the final newline omitted by native read; its digest is not the file-byte digest.
 */
export function manuscriptReadText(text: string): string {
  const lines = text.split('\n')
  if (text.endsWith('\n') || text === '') lines.pop()
  return lines.map(line => line.endsWith('\r') ? line.slice(0, -1) : line).join('\n')
}
