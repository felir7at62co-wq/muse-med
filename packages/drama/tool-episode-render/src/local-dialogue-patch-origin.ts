/** Current ordinary Session authority for a locally repaired source. */
import { isAbsolute, resolve } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-session-projection'
import type { VideoSourceQaVerifier } from '@deepseek-ai/dsh-tool-video-inspect/source-qa'
import { TOOL_BODY_META_KEY } from '@deepseek-ai/dsh-tools/pipeline'
import { z } from 'zod'
import { localDialoguePatchBindingSchema } from './local-dialogue-patch.ts'
import { measuredPronunciationCovers, type OfflinePronunciationVerifier } from './offline-pronunciation-evidence.ts'
import { episodeNumberOf } from './paths.ts'
import { isLocalDialoguePatchOutput, type LocalDialoguePatchSourceBinding } from './source-qa.ts'

const tool = 'drama_patch_dialogue'
const evidenceId = z.uuidv4()
const startMs = z.number().int().nonnegative()
const call = z.strictObject({ project: z.string().min(1).max(32767), episode: z.number().int().positive(),
  target_evidence_id: evidenceId, donor_evidence_id: evidenceId,
  target_start_ms: startMs, donor_start_ms: startMs, duration_ms: z.number().int().min(80).max(600) })
const receipt = localDialoguePatchBindingSchema.extend({
  pronunciation_evidence: z.strictObject({ target: evidenceId, donor: evidenceId }),
})
const resultMeta = z.object({ [TOOL_BODY_META_KEY]: receipt })
const stateSchema = z.object({ inheritedEventCount: z.number().int().nonnegative(),
  pending: z.record(z.string(), z.union([call, z.literal(false)])),
  issued: z.record(z.string(), z.union([receipt, z.literal(false)])) })
const sourceReceipt = z.object({ path: z.string().refine(isAbsolute), sha256: z.hash('sha256'),
  receiptPath: z.string().refine(isAbsolute), urlSha256: z.hash('sha256') })

type State = z.infer<typeof stateSchema>
type Session = Parameters<VideoSourceQaVerifier>[0]
type HistoricalSourceReader = (session: NonNullable<Session>, request: {
  projectDir: string
  sourcePath: string
  scriptId: number
  episodeId: number
  storyboardId: number
  taskId: number
  subtaskId: number
  firstResultId: number
}, signal: AbortSignal) => Promise<unknown>

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionStateMap { episodeLocalDialoguePatch: State }
}

/** Verify the repaired source, both provider downloads, and the measured post-repair pronunciation. */
export type LocalDialogueSourceVerifier = (session: Session, binding: LocalDialoguePatchSourceBinding, signal: AbortSignal) => Promise<void>

function pathKey(path: string): string {
  const absolute = resolve(path)
  return process.platform === 'win32' ? absolute.toLowerCase() : absolute
}

function samePath(left: string, right: string): boolean {
  return isAbsolute(left) && isAbsolute(right) && pathKey(left) === pathKey(right)
}

function recent<T>(entries: Readonly<Record<string, T>>, key: string, value: T): Record<string, T> {
  return { ...Object.fromEntries(Object.entries(entries).slice(-127)), [key]: value }
}

function invocationId(turn: number, step: number, callId: string): string {
  return JSON.stringify([turn, step, callId])
}

function readCall(value: string): z.infer<typeof call> | undefined {
  let raw: unknown
  try { raw = JSON.parse(value) } catch { return undefined /* A malformed call cannot issue a repair receipt. */ }
  const parsed = call.safeParse(raw)
  return parsed.success ? parsed.data : undefined
}

function matchesCall(args: z.infer<typeof call>, result: z.infer<typeof receipt>): boolean {
  return episodeNumberOf(args.episode) === result.episode
    && (!isAbsolute(args.project) || samePath(args.project, result.project))
    && args.target_evidence_id === result.pronunciation_evidence.target
    && args.donor_evidence_id === result.pronunciation_evidence.donor
    && args.target_start_ms === result.target.startMs && args.donor_start_ms === result.donor.startMs
    && args.duration_ms === result.durationMs && isLocalDialoguePatchOutput(result.project, result.output.path)
}

/**
 * Register the private native-output projection and bind it to the trusted Jubian source service.
 * @param ctx - Host context that owns the session projections and video source service.
 * @param readPronunciation - Reader for pronunciation evidence issued in the active session.
 * @returns A verifier for locally repaired dialogue sources.
 */
export async function createLocalDialogueSourceVerifier(ctx: Context,
  readPronunciation: OfflinePronunciationVerifier): Promise<LocalDialogueSourceVerifier> {
  const projection = await ctx.sessionProjections.register({ key: 'episodeLocalDialoguePatch', stateVersion: 1, stateSchema,
    init: (_header, inheritedEventCount) => ({ inheritedEventCount, pending: {}, issued: {} }),
    apply: (state, event) => {
      if (event.seq < state.inheritedEventCount) return state
      if (event.type === 'tool/call' && event.data.name === tool) {
        const { turn, step, callId, arguments: raw } = event.data
        const args = readCall(raw)
        const key = invocationId(turn, step, callId)
        return args === undefined ? state : { ...state, pending: recent(state.pending, key,
          Object.hasOwn(state.pending, key) ? false as const : args) }
      }
      if (event.type !== 'tool/result') return state
      const { turn, step, message, meta } = event.data
      const key = invocationId(turn, step, message.toolCallId)
      if (!Object.hasOwn(state.pending, key)) return state
      const { [key]: args, ...pending } = state.pending
      const next = { ...state, pending }
      if (!args || message.isError !== false) return next
      const parsed = resultMeta.safeParse(meta)
      if (!parsed.success) return next
      const result = parsed.data[TOOL_BODY_META_KEY]
      if (!matchesCall(args, result)) return next
      const output = pathKey(result.output.path)
      return { ...next, issued: recent(state.issued, output, Object.hasOwn(state.issued, output) ? false as const : result) }
    },
  })

  const readResult = (session: NonNullable<Session>, output: string) => projection.stateOf(session).issued[pathKey(output)]
  return async (session, binding, signal) => {
    signal.throwIfAborted()
    if (session === undefined || session.header.origin === 'subagent'
      || !isLocalDialoguePatchOutput(binding.project, binding.output)) {
      throw Error('SOURCE_DIALOGUE_PATCH: 需要当前普通 Muse 会话产生且保留原路径的修音候选。')
    }
    const native = readResult(session, binding.output)
    const { target, donor } = binding.originals
    if (!native || !samePath(native.project, binding.project) || native.episode !== binding.episode
      || !samePath(native.output.path, binding.output) || native.output.sha256 !== binding.sha256
      || !samePath(native.target.path, target.path) || native.target.sha256 !== target.sha256
      || !samePath(native.donor.path, donor.path) || native.donor.sha256 !== donor.sha256
      || samePath(target.path, donor.path) || samePath(target.receiptPath, donor.receiptPath)
      || target.urlSha256 === donor.urlSha256 || target.task_id === donor.task_id || target.subtask_id === donor.subtask_id
      || target.first_result_id === donor.first_result_id || new Set([target.sha256, donor.sha256, binding.sha256]).size !== 3) {
      throw Error('SOURCE_DIALOGUE_PATCH: 选片与当前两份原片、分包或实际修音回执不符。')
    }
    const before = readPronunciation(session, native.pronunciation_evidence.target, signal)
    const after = readPronunciation(session, binding.recheckEvidenceId, signal)
    if (before.source.sha256 !== target.sha256 || !samePath(before.source.path, target.path)
      || after.status !== 'matching_in_windows' || !samePath(after.project, binding.project)
      || !samePath(after.source.path, binding.output) || after.source.sha256 !== binding.sha256
      || before.expected !== after.expected || before.alternative !== after.alternative || before.target_index !== after.target_index
      || before.minimum_margin !== after.minimum_margin || before.tokens.length !== after.tokens.length
      || before.tokens.some((token, index) => token !== after.tokens[index])
      || !measuredPronunciationCovers(after, before.expected, native.target.startMs, native.durationMs)) {
      throw Error('SOURCE_DIALOGUE_PATCH: 先在当前会话对修音后同一候选、同一句话和同一短段复测读音。')
    }
    const verifyOriginal = ctx.get('jubianHistoricalVideoSource') as HistoricalSourceReader | undefined
    if (typeof verifyOriginal !== 'function') {
      throw Error('SOURCE_DIALOGUE_PATCH: 当前 Muse 缺少剧变原片下载核验。')
    }
    await Promise.all([target, donor].map(async (original) => {
      const verified = await verifyOriginal(session, {
        projectDir: binding.project, sourcePath: original.path, scriptId: binding.scriptId,
        episodeId: binding.episodeId, storyboardId: binding.storyboardId, taskId: original.task_id,
        subtaskId: original.subtask_id, firstResultId: original.first_result_id,
      }, signal)
      const parsed = sourceReceipt.safeParse(verified)
      if (!parsed.success || !samePath(parsed.data.path, original.path) || parsed.data.sha256 !== original.sha256
        || !samePath(parsed.data.receiptPath, original.receiptPath) || parsed.data.urlSha256 !== original.urlSha256) {
        throw Error('SOURCE_DIALOGUE_PATCH: 两份同集同卡的剧变原片本次下载回执与实际修音来源不符。')
      }
    }))
    signal.throwIfAborted()
    if (readResult(session, binding.output) !== native) throw Error('SOURCE_DIALOGUE_PATCH: 核验期间修音回执变化。')
  }
}
