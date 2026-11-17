/**
 * Type declarations of the session-activity domain: the service key, the digest message source and the public status types.
 *
 * @module @deepseek-ai/dsh-session-activity/types
 */

import type { ContextFormed } from '@deepseek-ai/dsh-llm'
import type { SessionId } from '@deepseek-ai/dsh-session'

export type { LastToolCall, LastTurnEnd, SessionActivityState } from './projection.ts'
export type { ActivityFamily, SessionStatus, SessionStatusKind } from './digest.ts'

/** Service surface consumers use to read Session status lines and watch Sessions on behalf of a parent. */
export interface SessionActivityWatcher {
  /**
   * Deliver status digests of one Session to a parent Session's live Agent until disposed.
   * Registering the same pair again adds a reference and replaces the label.
   * @param parent - Session whose Agent receives the digests.
   * @param child - Session whose status is reported.
   * @param label - Short task label shown on the child's line.
   * @returns the disposer removing this registration; repeated calls do nothing.
   */
  watch(parent: SessionId, child: SessionId, label: string): () => void
  /**
   * Render one Session's current status line, as the session list shows it.
   * @param sessionId - Any local Session, open or not.
   * @returns The line, such as `running for 12 min · last tool bash · job: ffmpeg`.
   */
  describe(sessionId: SessionId): Promise<string>
}

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    /** Status lines of Sessions another component watches for this Session; never human-authored. */
    'session-activity': { readonly kind: 'session-activity' } & ContextFormed
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    sessionActivity: SessionActivityWatcher
  }
}
