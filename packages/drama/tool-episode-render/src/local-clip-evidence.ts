/** Bind selected local clip bytes to the ordinary Session that produced them. */
import type { Context } from '@deepseek-ai/cordis'
import { TOOL_BODY_META_KEY } from '@deepseek-ai/dsh-tools/pipeline'
import type { VideoSourceQaVerifier } from '@deepseek-ai/dsh-tool-video-inspect/source-qa'
import type {} from '@deepseek-ai/dsh-session-projection'
import type {} from '@deepseek-ai/dsh-tool-executor-ptc/types'
import { z } from 'zod'

const media = z.strictObject({ path: z.string().min(1), sha256: z.hash('sha256') })

/** Identity and measured clock of one completed clip repair. */
export const localClipRepairBindingSchema = z.strictObject({
  project: z.string().min(1), episode: z.string().regex(/^\d{2,}$/u),
  original: media, output: media,
  startMs: z.number().int().nonnegative(), endMs: z.number().int().positive(),
  durationSeconds: z.number().positive(),
  pictureClock: z.strictObject({
    status: z.enum(['matching', 'unverified']), matchingSamples: z.number().int().min(0).max(3),
  }).optional(),
}).refine(value => value.endMs > value.startMs && value.output.sha256 !== value.original.sha256)

/** Exact physical source and local edit proved by one completed tool execution. */
export type LocalClipRepairBinding = z.infer<typeof localClipRepairBindingSchema>
type Session = Parameters<VideoSourceQaVerifier>[0]

const stateSchema = z.object({
  inheritedEventCount: z.number().int().nonnegative(),
  pending: z.record(z.string(), z.literal(true)),
  repairs: z.record(z.string(), localClipRepairBindingSchema),
})
type State = z.infer<typeof stateSchema>

function key(path: string): string {
  return process.platform === 'win32' ? path.toLowerCase() : path
}

function sameRepair(left: LocalClipRepairBinding, right: LocalClipRepairBinding): boolean {
  // Review documents identify the exact issued edit. The diagnostic remains in the tool result.
  return key(left.project) === key(right.project) && left.episode === right.episode
    && key(left.original.path) === key(right.original.path) && left.original.sha256 === right.original.sha256
    && key(left.output.path) === key(right.output.path) && left.output.sha256 === right.output.sha256
    && left.startMs === right.startMs && left.endMs === right.endMs && left.durationSeconds === right.durationSeconds
}

/**
 * Register the projection that attests completed local media edits.
 * @param ctx - Owner scope with the Session projection registry.
 * @returns A verifier for exact inputs and outputs of a completed ordinary tool execution.
 */
export async function createLocalClipRepairVerifier(ctx: Context): Promise<(
  session: Session, repair: LocalClipRepairBinding, signal: AbortSignal,
) => void> {
  const projection = await ctx.sessionProjections.register<'episodeLocalClipRepair', State>({
    key: 'episodeLocalClipRepair', stateVersion: 2, stateSchema,
    init: (_header, inheritedEventCount) => ({ inheritedEventCount, pending: {}, repairs: {} }),
    apply: (state, event) => {
      if (event.seq < state.inheritedEventCount) return state
      if (event.type === 'tool/call' && event.data.name === 'drama_repair_clip') {
        return { ...state, pending: { ...state.pending, ['native:' + event.data.callId]: true } }
      }
      if (event.type === 'tool/ptc-dispatch-start' && event.data.name === 'drama_repair_clip') {
        return { ...state, pending: { ...state.pending, ['ptc:' + event.data.subCallId]: true } }
      }
      if (event.type !== 'tool/result' && event.type !== 'tool/ptc-dispatch') return state
      const callId = event.type === 'tool/result' ? 'native:' + event.data.message.toolCallId : 'ptc:' + event.data.subCallId
      if (!state.pending[callId]) return state
      const { [callId]: _done, ...pending } = state.pending
      const { meta } = event.data
      const failed = event.type === 'tool/result'
        ? event.data.message.isError
        : event.data.isError || event.data.name !== 'drama_repair_clip'
      if (failed || typeof meta !== 'object' || meta === null || Array.isArray(meta)) {
        return { ...state, pending }
      }
      const parsed = localClipRepairBindingSchema.safeParse(meta[TOOL_BODY_META_KEY])
      if (!parsed.success) return { ...state, pending }
      return { ...state, pending, repairs: { ...state.repairs, [key(parsed.data.output.path)]: parsed.data } }
    },
  })
  return (session, repair, signal) => {
    signal.throwIfAborted()
    const existing = session === undefined ? undefined : projection.stateOf(session).repairs[key(repair.output.path)]
    if (existing === undefined || !sameRepair(existing, repair)) {
      throw new Error('SOURCE_LOCAL_CLIP: 请在当前 Muse 会话运行 drama_repair_clip，并引用本次工具真实回执。')
    }
  }
}
