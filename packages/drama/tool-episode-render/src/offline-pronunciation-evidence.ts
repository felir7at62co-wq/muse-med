/** Read bounded pronunciation evidence from the originating ordinary Session's native tools. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-session-projection'
import type { VideoSourceQaVerifier } from '@deepseek-ai/dsh-tool-video-inspect/source-qa'
import { TOOL_BODY_META_KEY } from '@deepseek-ai/dsh-tools/pipeline'
import { z } from 'zod'

const tool = 'audio_transcribe'
const id = z.uuidv4()
const hash = z.hash('sha256')
const syllable = z.string().regex(/^[a-z]{1,8}[1-5]$/u)
const tokens = z.array(syllable).min(3).max(24)
const path = z.string().min(1).max(32767)
const rangeFields = { start: z.number().nonnegative(), end: z.number().positive() }
const request = z.strictObject({ tokens, target_index: z.number().int().min(1).max(22), alternative: syllable,
  windows: z.array(z.strictObject(rangeFields)).min(2).max(3) })
const call = z.strictObject({ method: z.literal('pronunciation'), project: path, input: path, pronunciation: request })
const receipt = z.strictObject({
  version: z.literal(1), evidence_id: id, project: path, source: z.strictObject({ path, sha256: hash }),
  model: z.strictObject({ name: z.literal('robinsonphan/sensevoice-small-zh-pinyin-dual-ctc'),
    revision: z.literal('884e70660b97f9c242f1d77c8516aea62a8fdf29'),
    sha256: z.literal('ed3c7db2468b99fd3811578fff6000c990875c22b1e93abcd08f9c05bc61a93a') }),
  status: z.enum(['uncertain', 'matching_in_windows', 'suspected_mismatch']),
  expected: syllable, alternative: syllable, target_index: request.shape.target_index,
  windows: z.array(z.strictObject({ ...rangeFields, observed: syllable.optional(),
    target_seconds: z.number().nonnegative().optional(), alternative_minus_expected: z.number().optional(),
    pcm: z.strictObject({ sha256: hash, sampleRate: z.literal(16000), samples: z.number().int().positive() }),
  })).min(2).max(3),
  minimum_margin: z.number().min(8).max(50), listening_verified: z.literal(false), note: z.string().max(1024),
})
const evidence = receipt.extend({ tokens })
const body = z.strictObject({ offline_pronunciation: receipt })
const stateSchema = z.object({ inheritedEventCount: z.number().int().nonnegative(),
  pending: z.record(z.string(), call), results: z.record(id, evidence) })

type State = z.infer<typeof stateSchema>
type Session = Parameters<VideoSourceQaVerifier>[0]

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionStateMap { episodeOfflinePronunciation: State }
}

/** The native tool's result and phrase from its matching committed call. */
export type OfflinePronunciationEvidence = z.infer<typeof evidence>

/** Read an actual local tool result by issuance ID in the originating Session. */
export type OfflinePronunciationVerifier = (session: Session, evidenceId: string, signal: AbortSignal) => OfflinePronunciationEvidence

/** At least two independently captured windows support the requested sound inside the exact edit. */
export function measuredPronunciationCovers(evidence: OfflinePronunciationEvidence, observed: string,
  startMs: number, durationMs: number): boolean {
  const start = startMs / 1000, end = (startMs + durationMs) / 1000
  return evidence.windows.filter(window => window.start <= start && window.end >= end
    && window.observed === observed && window.target_seconds !== undefined
    && window.target_seconds > start && window.target_seconds < end
    && window.alternative_minus_expected !== undefined
    && (observed === evidence.expected ? -window.alternative_minus_expected : window.alternative_minus_expected)
      >= evidence.minimum_margin).length >= 2
}

function identity(turn: number, step: number, callId: string): string {
  return JSON.stringify([turn, step, callId])
}

function appendBounded<T>(entries: Record<string, T>, key: string, value: T, max: number): Record<string, T> {
  if (Object.hasOwn(entries, key)) return entries
  return Object.fromEntries([...Object.entries(entries).slice(1 - max), [key, value]])
}

function parseArgs(raw: string): z.infer<typeof call> | undefined {
  let args: unknown
  try { args = JSON.parse(raw) } catch { return undefined /* Invalid tool arguments never issue evidence. */ }
  const parsed = call.safeParse(args)
  return parsed.success ? parsed.data : undefined
}

function matchesRequest(args: z.infer<typeof call>, result: z.infer<typeof receipt>): boolean {
  const { tokens: phrase, alternative, target_index, windows } = args.pronunciation
  return target_index < phrase.length - 1 && phrase[target_index] === result.expected && alternative !== result.expected
    && target_index === result.target_index && alternative === result.alternative && windows.length === result.windows.length
    && windows.every(({ start, end }, index) => {
      const measured = result.windows[index]
      return measured !== undefined && start === measured.start && end === measured.end
    })
}

/** Await the native evidence projection before exposing an invocation-local reader. */
export async function createOfflinePronunciationVerifier(ctx: Context): Promise<OfflinePronunciationVerifier> {
  const projection = await ctx.sessionProjections.register({ key: 'episodeOfflinePronunciation', stateVersion: 1, stateSchema,
    init: (_header, inheritedEventCount) => ({ inheritedEventCount, pending: {}, results: {} }),
    apply: (state, event) => {
      if (event.seq < state.inheritedEventCount) return state
      if (event.type === 'tool/call' && event.data.name === tool) {
        const args = parseArgs(event.data.arguments)
        return args === undefined ? state : { ...state, pending: appendBounded(state.pending,
          identity(event.data.turn, event.data.step, event.data.callId), args, 64) }
      }
      if (event.type !== 'tool/result') return state
      const key = identity(event.data.turn, event.data.step, event.data.message.toolCallId)
      if (!Object.hasOwn(state.pending, key)) return state
      const { [key]: args, ...pending } = state.pending
      const next = { ...state, pending }
      const { meta } = event.data
      if (event.data.message.isError !== false || args === undefined || typeof meta !== 'object' || meta === null || Array.isArray(meta)) return next
      const parsed = body.safeParse(meta[TOOL_BODY_META_KEY])
      if (!parsed.success || !matchesRequest(args, parsed.data.offline_pronunciation)) return next
      const result = parsed.data.offline_pronunciation
      const results = appendBounded(state.results, result.evidence_id, { ...result, tokens: args.pronunciation.tokens }, 128)
      return { ...next, results }
    },
  })
  return (session, evidenceId, signal) => {
    signal.throwIfAborted()
    const results = session !== undefined && session.header.origin !== 'subagent' && id.safeParse(evidenceId).success
      ? projection.stateOf(session).results : undefined
    const result = results !== undefined && Object.hasOwn(results, evidenceId) ? results[evidenceId] : undefined
    if (result === undefined) throw new Error('OFFLINE_PRONUNCIATION_SESSION: 请引用当前普通 Muse 会话刚用 audio_transcribe pronunciation 得到的检测编号。')
    return structuredClone(result)
  }
}
