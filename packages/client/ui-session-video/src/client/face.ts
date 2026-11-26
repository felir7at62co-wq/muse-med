/** Session video queries and conversation-owned navigation callbacks. */
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { SessionVideoAnalysis, SessionVideoSourceId } from '@deepseek-ai/dsh-session-video/types'
import type { PropsLocale, PropsRuntime, PropsStore } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import type { VideoStore } from './store.ts'
import type { VideoTarget } from './target-selection.ts'
import type { Occurrence, TokenSpan } from '@deepseek-ai/dsh-client-ui-conversation/client'

/** Unwrapped Host queries; AbortSignal cancels work when a conversation leaves. */
export interface VideoInjected {
  readonly detectShots: (sessionId: SessionId, id: SessionVideoSourceId, version: string,
    signal: AbortSignal) => Promise<SessionVideoAnalysis>
  readonly pixelsPerSecond: number
  /** Reveal this Session's video workspace at an exact source or start comparing a returned shot. */
  readonly openWorkspace: (destination?: 'sidebar' | 'float', target?: VideoTarget, intent?: 'compare') => void
  /** Retry the inventory of existing resource readers without opening another workspace. */
  readonly refreshVideos: () => void
  /** Open this Session's composer file picker when it accepts attachments. */
  readonly addVideoAttachment: () => boolean
  /** Insert a video chip after the captured selection; false means the draft refused the edit. */
  readonly addTargetReference: (target: VideoTarget, label: string, span: TokenSpan) => boolean
  /** Remove only an identity-matched video chip; unrelated references are refused. */
  readonly removeTargetReference: (occurrence: Occurrence) => boolean
  /** Add one read-only chip at the captured insertion, or remove this plugin's mode chips before editing. */
  readonly setReviewMode: (enabled: boolean, span: TokenSpan) => boolean
}
/** Store and locale shared by the shelf and inline cards. */
export type VideoShared = PropsStore<VideoStore> & PropsLocale<'sessionVideo'> & VideoInjected
/** Right-Sidebar body with the same Session store and composer as the conversation. */
export type VideoWorkspaceProps = PropsRuntime<'sidebar.right.pane.tab'> & VideoShared
