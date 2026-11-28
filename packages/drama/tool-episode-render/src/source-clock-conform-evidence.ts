/** Trust the actual execution that copied the original sound onto the restored picture clock. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-session-projection'
import type {} from '@deepseek-ai/dsh-tool-executor-ptc/types'
import type { VideoSourceQaVerifier } from '@deepseek-ai/dsh-tool-video-inspect/source-qa'
import { TOOL_BODY_META_KEY } from '@deepseek-ai/dsh-tools/pipeline'
import { z } from 'zod'
import { sourceClockConformBindingSchema, type SourceClockConformBinding } from './source-clock-conform.ts'

export { sourceClockConformBindingSchema, type SourceClockConformBinding } from './source-clock-conform.ts'

type Session = Parameters<VideoSourceQaVerifier>[0]
const tool = 'drama_conform_clip'
const stateSchema = z.object({
  inheritedEventCount: z.number().int().nonnegative(),
  pending: z.record(z.string(), z.literal(true)),
  edits: z.record(z.string(), sourceClockConformBindingSchema),
})
type State = z.infer<typeof stateSchema>

function pathKey(path: string): string {
  return process.platform === 'win32' ? path.toLowerCase() : path
}

function receipt(value: SourceClockConformBinding): string {
  const parsed = sourceClockConformBindingSchema.parse(value)
  return JSON.stringify({ ...parsed, project: pathKey(parsed.project),
    original: { ...parsed.original, path: pathKey(parsed.original.path) },
    processed: { ...parsed.processed, path: pathKey(parsed.processed.path) },
    output: { ...parsed.output, path: pathKey(parsed.output.path) } })
}

function ptcKey(value: { rootCallId: string; parentCallId: string; subCallId: string }): string {
  return 'ptc:' + JSON.stringify([value.rootCallId, value.parentCallId, value.subCallId])
}

/**
 * Establish the current Session's trusted source-clock conform evidence.
 * @param ctx - The Host scope carrying the Session projection registry.
 * @returns A verifier for one exact, completed native or PTC tool result.
 */
export async function createSourceClockConformVerifier(ctx: Context): Promise<(
  session: Session, binding: SourceClockConformBinding, signal: AbortSignal,
) => void> {
  const projection = await ctx.sessionProjections.register<'episodeSourceClockConform', State>({
    key: 'episodeSourceClockConform', stateVersion: 1, stateSchema,
    init: (_header, inheritedEventCount) => ({ inheritedEventCount, pending: {}, edits: {} }),
    apply: (state, event) => {
      if (event.seq < state.inheritedEventCount) return state
      if (event.type === 'tool/call' && event.data.name === tool) {
        return { ...state, pending: { ...state.pending, ['native:' + event.data.callId]: true } }
      }
      if (event.type === 'tool/ptc-dispatch-start' && event.data.name === tool) {
        return { ...state, pending: { ...state.pending, [ptcKey(event.data)]: true } }
      }
      if (event.type !== 'tool/result' && event.type !== 'tool/ptc-dispatch') return state
      const id = event.type === 'tool/result' ? 'native:' + event.data.message.toolCallId : ptcKey(event.data)
      if (!Object.hasOwn(state.pending, id)) return state
      const { [id]: _settled, ...pending } = state.pending
      const { meta } = event.data
      const failed = event.type === 'tool/result' ? event.data.message.isError : event.data.isError || event.data.name !== tool
      if (failed || typeof meta !== 'object' || meta === null || Array.isArray(meta)) return { ...state, pending }
      const checked = sourceClockConformBindingSchema.safeParse(meta[TOOL_BODY_META_KEY])
      if (!checked.success) return { ...state, pending }
      return { ...state, pending, edits: { ...state.edits, [pathKey(checked.data.output.path)]: checked.data } }
    },
  })
  return (session, binding, signal) => {
    signal.throwIfAborted()
    const edits = session === undefined || session.header.origin === 'subagent' ? undefined : projection.stateOf(session).edits
    const key = pathKey(binding.output.path)
    const saved = edits !== undefined && Object.hasOwn(edits, key) ? edits[key] : undefined
    if (saved === undefined || receipt(saved) !== receipt(binding)) {
      throw new Error('SOURCE_CLOCK_SESSION: 请在当前普通 Muse 会话运行 drama_conform_clip，并引用本次工具真实回执。')
    }
  }
}
