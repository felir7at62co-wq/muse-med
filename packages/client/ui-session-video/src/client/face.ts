/** Host operations injected into Session video components. */
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { SessionVideoAnalysis, SessionVideoInventory, SessionVideoSourceId } from '@deepseek-ai/dsh-session-video'
import type { PropsLocale, PropsStore } from '@deepseek-ai/dsh-client-ui-slots'
import type { VideoStore } from './store.ts'

/** Unwrapped Host queries; AbortSignal cancels work when a conversation leaves. */
export interface VideoInjected {
  readonly listVideos: (sessionId: SessionId, signal: AbortSignal) => Promise<SessionVideoInventory>
  readonly detectShots: (sessionId: SessionId, id: SessionVideoSourceId, version: string,
    signal: AbortSignal) => Promise<SessionVideoAnalysis>
  readonly pixelsPerSecond: number
}
/** Store and locale shared by the shelf and inline cards. */
export type VideoShared = PropsStore<VideoStore> & PropsLocale<'sessionVideo'> & VideoInjected
