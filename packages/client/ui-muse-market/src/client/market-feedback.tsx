/** Operation outcomes retained by the shell overlay across market navigation. */
import type { ReactNode } from 'react'
import { IconWarningOutlineRegular, Toast } from '@deepseek-ai/dsh-client-ui-primitives'
import type { HostObservable, InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type { MarketOutcomeKey } from './market-actions.ts'

interface MarketOutcome { key: MarketOutcomeKey; failed: boolean; sequence: number }

/** Shell-owned operation feedback, independent of the market page's lifetime. */
export interface MarketFeedback {
  /** Outcome source bound to the overlay's selector hook. */
  hooks: { outcome: HostObservable<MarketOutcome | null> }
  /** Report only a settled operation; ignored after plugin disposal. */
  report: (key: MarketOutcomeKey, failed: boolean) => void
  /** Dismiss the current banner. */
  dismiss: () => void
  /** Release subscribers and ignore late operation completions. */
  dispose: () => void
}

/** Create the market plugin's shell-level feedback source.
 * @returns Feedback actions and the observable current outcome.
 */
export function createMarketFeedback(): MarketFeedback {
  let current: MarketOutcome | null = null, sequence = 0, disposed = false
  const listeners = new Set<() => void>()
  const publish = (next: MarketOutcome | null): void => {
    if (disposed) return
    current = next
    for (const listener of listeners) listener()
  }
  return {
    hooks: { outcome: { getSnapshot: () => current,
      subscribe: (listener) => { listeners.add(listener); return () => { listeners.delete(listener) } } } },
    report: (key, failed) => { publish({ key, failed, sequence: ++sequence }) },
    dismiss: () => { publish(null) },
    dispose: () => { disposed = true; current = null; listeners.clear() },
  }
}

/** Render operation feedback outside the main panel's lifetime.
 * @param props Framework selector hook, localized copy and dismissal action.
 * @returns Transient outcome banner, or nothing.
 */
export function MarketFeedbackOverlay({ useOutcome, dismiss, t }: PropsRuntime<'shell.overlay'>
  & PropsLocale<'settings.museMarket'> & InjectFace<Pick<MarketFeedback, 'hooks' | 'dismiss'>>): ReactNode {
  const outcome = useOutcome(value => value)
  if (!outcome) return null
  return outcome.failed
    ? <Toast key={outcome.sequence} text={t(outcome.key)} icon={<IconWarningOutlineRegular />} onDone={dismiss} />
    : <Toast key={outcome.sequence} text={t(outcome.key)} tone="success" onDone={dismiss} />
}
