/** Bottom-status phases derived from the loaded Turn and Step evidence. */
import type { ConversationTimelineSnapshot } from '@deepseek-ai/dsh-client-ui-conversation/client'

/** Local preparation, admitted request, or visible turn activity inferred from the loaded timeline. */
export type RunningPhase = 'preparing' | 'waiting' | 'reasoning' | 'responding' | 'working'

/**
 * Distinguish initial preparation from an admitted request awaiting content.
 * A Step start does not establish provider queueing or network request timing.
 * @param timeline - Current Chat timeline, including Step-scoped Assistant data.
 * @returns a presentation phase; incomplete evidence retains the general activity label.
 */
export function runningPhase(timeline: ConversationTimelineSnapshot): RunningPhase {
  const turnNumber = timeline.turnOrder.at(-1)
  const turn = turnNumber === undefined ? undefined : timeline.turns.get(turnNumber)
  if (turn?.status !== 'open') return 'working'
  const step = turn.steps.at(-1)
  if (step === undefined) return turn.start === undefined ? 'working' : 'preparing'
  if (step.status !== 'open' || step.start === undefined) return 'working'
  const assistant = step.data.get('assistant-step')
  if (assistant?.status !== 'running') return 'working'
  const block = assistant.blocks.findLast(candidate =>
    candidate.kind === 'text' || candidate.kind === 'reasoning' ? candidate.text.trim() !== '' : true)
  if (block === undefined) return 'waiting'
  return block.kind === 'text' ? 'responding' : block.kind === 'reasoning' ? 'reasoning' : 'working'
}
