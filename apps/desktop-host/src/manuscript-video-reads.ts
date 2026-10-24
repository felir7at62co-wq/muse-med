/** Current-task successful text-read receipts, reconstructed by the Session projection registry. */
import type { Context } from '@deepseek-ai/cordis'
import { ToolCallId, type UserMessage } from '@deepseek-ai/dsh-llm'
import { SessionSeq, type Session } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-projection'
import type { VideoTranscriptCandidates } from '@deepseek-ai/dsh-tool-video-inspect'
import { z } from 'zod'

const readStateSchema = z.object({ cwd: z.string(), taskStartSeq: z.number().int().nonnegative().transform(SessionSeq).optional(),
  pending: z.array(z.string().transform(ToolCallId)),
  reads: z.array(z.object({ path: z.string(), readCallId: z.string().transform(ToolCallId),
    readResultSeq: z.number().int().nonnegative().transform(SessionSeq) })) })
type ReadState = z.infer<typeof readStateSchema>

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionStateMap { manuscriptVideoReads: ReadState }
}

/**
 * Fold real read-result metadata into task-scoped receipts without synchronous historical event reads.
 * @param ctx - Registry scope owning registration and teardown.
 * @param declaresOutput - Recognizes a real user's explicit output task; generic continuation preserves its receipts.
 */
export function installManuscriptVideoReads(ctx: Context, declaresOutput: (message: UserMessage, cwd: string) => boolean): void {
  ctx.sessionProjections.register({ key: 'manuscriptVideoReads', stateSchema: readStateSchema, stateVersion: 1,
    init: header => ({ cwd: header.cwd ?? '', pending: [], reads: [] }),
    apply: (state, event) => {
      if (event.type === 'user/message' && event.data.source.kind === 'user'
        && (state.taskStartSeq === undefined || declaresOutput(event.data, state.cwd))) {
        return { cwd: state.cwd, taskStartSeq: event.seq, pending: [], reads: [] }
      }
      if (event.type === 'assistant/message') {
        const ids = event.data.message.content.flatMap(block => block.type === 'tool-call' && block.name === 'read' ? [block.id] : [])
        return ids.length ? { ...state, pending: [...state.pending, ...ids] } : state
      }
      if (event.type !== 'tool/result' || !state.pending.includes(event.data.message.toolCallId)) return state
      const pending = state.pending.filter(id => id !== event.data.message.toolCallId)
      const meta = z.object({ path: z.string() }).safeParse(event.data.meta)
      if (event.data.message.isError || !meta.success || !/\.json$/iu.test(meta.data.path) || state.taskStartSeq === undefined) {
        return { ...state, pending }
      }
      return { ...state, pending, reads: [...state.reads,
        { path: meta.data.path, readCallId: event.data.message.toolCallId, readResultSeq: event.seq }] }
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
