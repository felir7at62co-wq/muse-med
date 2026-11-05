/** Running Turn clock isolated from the transcript's render cycle. */
import { memo, useEffect, useState } from 'react'
import { TextShimmer } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ChatViewSlotProps } from '../contract/slots.ts'
import { formatRunDuration, LIVE_RUN_CLOCK_INTERVAL_MS } from './message-chrome.ts'
import { RunningWhaleTail } from './RunningWhaleTail.tsx'
import type { RunningPhase } from './running-phase.ts'
import a11yCss from './accessibility.module.css'
import css from './ChatView.module.css'

interface RunningStatusProps {
  readonly startTime: number | undefined
  readonly stepStartTime?: number | undefined
  readonly phase: RunningPhase
  /** Freeze the shown duration while the Client cannot observe the Session. */
  readonly paused: boolean
  /** Keep the slot hidden until the closed Turn's actions row replaces it. */
  readonly holding?: boolean
  readonly t: ChatViewSlotProps['t']
}

/**
 * Show live elapsed time after the current Turn's content without announcing ticks.
 * @param props - Current Turn and Step start times, observed phase, pause state, and localized copy.
 * @returns the running indicator, retaining its hidden slot until the Turn's actions row replaces it.
 */
export const RunningStatus = memo(function RunningStatus({
  startTime, stepStartTime, phase, paused, holding = false, t,
}: RunningStatusProps) {
  const [now, setNow] = useState(Date.now)
  useEffect(() => {
    if (startTime === undefined || paused || holding) return
    setNow(Date.now())
    const timer = setInterval(() => { setNow(Date.now()) }, LIVE_RUN_CLOCK_INTERVAL_MS)
    return () => { clearInterval(timer) }
  }, [startTime, paused, holding])
  const keys = {
    preparing: ['chat.preparing', 'chat.preparingFor'],
    waiting: ['chat.waitingForResponse', 'chat.waitingForResponseFor'],
    reasoning: ['chat.receivingReasoning', 'chat.receivingReasoningFor'],
    responding: ['chat.receivingResponse', 'chat.receivingResponseFor'],
    working: ['chat.deepDiving', 'chat.deepDivingFor'],
  } as const
  const [statusKey, durationKey] = keys[phase]
  const status = t(statusKey)
  const elapsed = (since: number): string => formatRunDuration(Math.max(1000, now - since), t).map(part => part.text).join('')
  const label = startTime === undefined ? status : phase === 'waiting' && stepStartTime !== undefined
    ? t('chat.waitingForResponseStep', { stepDuration: elapsed(stepStartTime), duration: elapsed(startTime) })
    : t(durationKey, { duration: elapsed(startTime) })
  return (
    <div className={css.running} data-chat-running data-phase={phase} data-holding={holding ? '' : undefined} aria-hidden={holding || undefined}>
      {holding ? null : <span className={a11yCss.visuallyHidden} role="status" aria-live="polite" aria-atomic="true">{status}</span>}
      <span className={css.runningDivider} aria-hidden="true" />
      <span className={css.runningContent}>
        <RunningWhaleTail />
        <TextShimmer active={!holding} className={css.runningText}>{label}</TextShimmer>
      </span>
    </div>
  )
})
