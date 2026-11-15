/**
 * Type declarations of the session-activity domain: the service key, the digest message source and the public state types.
 *
 * @module @deepseek-ai/dsh-session-activity/types
 */

import type { ContextFormed } from '@deepseek-ai/dsh-llm'
import type { SessionId } from '@deepseek-ai/dsh-session'

export type { ActivityNote, SessionActivityState, ToolTally } from './projection.ts'

/** Service surface consumers use to watch Sessions on behalf of a parent. */
export interface SessionActivityWatcher {
  /**
   * Deliver compact activity digests of one Session to a parent Session's live Agent until disposed.
   * Registering the same pair again adds a reference and replaces the label.
   * @param parent - Session whose Agent receives the digests.
   * @param child - Session whose committed events are summarized.
   * @param label - Short task label shown on the child's digest line.
   * @returns the disposer removing this registration; repeated calls do nothing.
   */
  watch(parent: SessionId, child: SessionId, label: string): () => void
}

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    /** Running activity totals of Sessions another component watches for this Session; never human-authored. */
    'session-activity': { readonly kind: 'session-activity' } & ContextFormed
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    sessionActivity: SessionActivityWatcher
  }
}
