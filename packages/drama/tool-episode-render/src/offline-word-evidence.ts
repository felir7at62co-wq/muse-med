/** Bind local word timing to the exact media and receipt issued in this Session. */
import { isAbsolute, resolve } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-session-projection'
import type { VideoObservationVerifier } from '@deepseek-ai/dsh-tool-video-inspect'
import { TOOL_BODY_META_KEY } from '@deepseek-ai/dsh-tools/pipeline'
import { z } from 'zod'

const path = z.string().min(1).max(32767).refine(isAbsolute)
const digest = z.hash('sha256')
const file = z.object({ path, sha256: digest })
const engine = z.object({ name: z.literal('Systran/faster-whisper-small'),
  revision: z.literal('536b0662742c02347bc0e980a01041f333bce120'),
  sha256: z.literal('3e305921506d8872816023e4c273e75d2419fb89b24da97b4fe7bce14170d671') })

/** Native offline transcription receipt, with exact recognized-word bytes bound to a local source. */
export const offlineWordReceipt = z.object({ kind: z.literal('muse_offline_word_timing'), version: z.literal(1),
  project: path, source: file, transcript: file, receipt: path,
  pcm: z.object({ sha256: digest, sampleRate: z.literal(16_000), samples: z.number().int().positive().max(16_000 * 120) }),
  model: engine, recognition: z.literal('no_reliable_words').optional(), listening_verified: z.literal(false),
})
const meta = z.object({ [TOOL_BODY_META_KEY]: z.object({ offline_transcript: offlineWordReceipt }) })
const stateSchema = z.object({ inheritedEventCount: z.number().int().nonnegative(),
  pending: z.record(z.string(), z.literal(true)), receipts: z.record(z.string(), offlineWordReceipt) })
type State = z.infer<typeof stateSchema>
type Session = Parameters<VideoObservationVerifier>[0]
type Receipt = z.infer<typeof offlineWordReceipt>

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionStateMap { episodeOfflineWordEvidence: State }
}

/** Require an issued, unchanged offline receipt before using its words in strict evidence. */
export type OfflineWordReceiptVerifier = (receipt: Receipt) => void

function requestIsOffline(raw: string): boolean {
  let args: unknown
  try { args = JSON.parse(raw) } catch { return false }
  return args !== null && typeof args === 'object' && 'method' in args && args.method === 'offline'
}

function pathKey(filePath: string): string {
  const absolute = resolve(filePath)
  return process.platform === 'win32' ? absolute.toLowerCase() : absolute
}

function append<T>(record: Record<string, T>, key: string, value: T, limit: number): Record<string, T> {
  const { [key]: _prior, ...previous } = record
  return { ...Object.fromEntries(Object.entries(previous).slice(1 - limit)), [key]: value }
}

/** Build a verifier from this Host's bounded native tool history. */
export async function installOfflineWordEvidence(ctx: Context): Promise<
  (session: Session, signal: AbortSignal) => OfflineWordReceiptVerifier> {
  const projection = await ctx.sessionProjections.register({ key: 'episodeOfflineWordEvidence', stateVersion: 1, stateSchema,
    init: (_header, inheritedEventCount) => ({ inheritedEventCount, pending: {}, receipts: {} }),
    apply: (state, event) => {
      if (event.seq < state.inheritedEventCount) return state
      if (event.type === 'tool/call' && event.data.name === 'audio_transcribe' && requestIsOffline(event.data.arguments)) {
        const { turn, step, callId } = event.data
        return { ...state, pending: append(state.pending, JSON.stringify([turn, step, callId]), true as const, 64) }
      }
      if (event.type !== 'tool/result') return state
      const { turn, step, message } = event.data
      const key = JSON.stringify([turn, step, message.toolCallId])
      if (!Object.hasOwn(state.pending, key)) return state
      const { [key]: _pending, ...pending } = state.pending
      const next = { ...state, pending }
      if (message.isError !== false) return next
      const result = meta.safeParse(event.data.meta)
      if (!result.success) return next
      const receipt = result.data[TOOL_BODY_META_KEY].offline_transcript
      return { ...next, receipts: append(state.receipts, pathKey(receipt.receipt), receipt, 128) }
    },
  })
  return (session, signal) => (receipt) => {
    signal.throwIfAborted()
    const current = session === undefined ? undefined : projection.stateOf(session).receipts[pathKey(receipt.receipt)]
    if (current === undefined || JSON.stringify(current) !== JSON.stringify(receipt)) {
      throw new Error('当前会话缺少此声音的实际本地转写回执，请用 audio_transcribe offline 对当前文件重新转写。')
    }
  }
}
