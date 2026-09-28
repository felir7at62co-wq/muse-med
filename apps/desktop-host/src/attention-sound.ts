/** Live Desktop cues for user-owned turns and questions. */

import type { SessionEvent, SessionHeader } from '@deepseek-ai/dsh-session'

/** The two signals the Electron shell can play through the system sound. */
export type AttentionSound = 'complete' | 'question'

/**
 * Select a cue from a newly appended session event.
 * @param header - Session lineage metadata; subagent activity stays quiet.
 * @param event - Newly appended event, not replayed history.
 * @returns The cue to play, if this event needs the user's attention.
 */
export function attentionSoundForEvent(
  header: Pick<SessionHeader, 'origin'>,
  event: SessionEvent,
): AttentionSound | undefined {
  if (header.origin === 'subagent') return undefined
  if (event.type === 'tool/call' && event.data.name === 'ask_user_question') return 'question'
  if (event.type === 'turn/end' && event.data.reason.kind === 'completed') return 'complete'
  return undefined
}
