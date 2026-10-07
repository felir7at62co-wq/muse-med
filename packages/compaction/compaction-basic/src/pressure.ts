/**
 * Feasible pressure retention and unchanged-summary suppression identities.
 *
 * @module @deepseek-ai/dsh-compaction-basic/pressure
 */

import { createHash } from 'node:crypto'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { Session, SessionSeq } from '@deepseek-ai/dsh-session'
import type { TokenMeasurement, TokenMeter } from '@deepseek-ai/dsh-token-meter'
import { selectCompactableRange } from './region.ts'
import { frameSummary } from './summarizer.ts'
import type { ResolvedCompactSpec } from './types.ts'

/** Inclusive current surface positions selected for a pressure summary. */
export interface PressureRange {
  readonly start: SessionSeq
  readonly end: SessionSeq
}

/**
 * Keep the configured tail only while fixed request content leaves room for a nonempty checkpoint.
 * Tool-pair rounding may retain more; retry with the newest indivisible unit
 * before declining a tail that still leaves no checkpoint space.
 * @param session - current conversation surface and system-head event.
 * @param measurement - unified request and positional token prices.
 * @param spec - routed pressure threshold and configured retention budget.
 * @param meter - singleton estimator for checkpoint framing.
 * @returns a feasible balanced range, or null when no useful replacement fits.
 */
export function selectPressureRange(
  session: Session,
  measurement: TokenMeasurement,
  spec: ResolvedCompactSpec,
  meter: TokenMeter,
): PressureRange | null {
  const head = measurement.nodes[0]
  // Positional node seqs always refer to committed log events.
  // oxlint-disable-next-line typescript/no-deprecated
  const systemTokens = head !== undefined && session.eventAt(head.seq)?.type === 'system/message'
    ? head.tokens
    : 0
  const fixedTokens = Math.max(0, measurement.totalTokens - measurement.surfaceTokens) + systemTokens
  const minimumCheckpointTokens = meter.estimateMessage(createUserMessage({
    content: frameSummary([{ type: 'text', text: 'x' }]),
    source: { kind: 'user' },
  }))
  const retainedBudget = Math.min(spec.retainTokens, spec.thresholdTokens - fixedTokens - minimumCheckpointTokens - 1)
  if (retainedBudget < 0) return null
  for (const retention of [retainedBudget, 0]) {
    const range = selectCompactableRange(session, measurement, retention)
    if (range === null) continue
    const start = measurement.nodes.findIndex(node => node.seq === range.start)
    const end = measurement.nodes.findIndex(node => node.seq === range.end)
    const selectedTokens = measurement.nodes.slice(start, end + 1).reduce((total, node) => total + node.tokens, 0)
    if (selectedTokens > minimumCheckpointTokens
      && measurement.totalTokens - selectedTokens + minimumCheckpointTokens < spec.thresholdTokens) return range
  }
  return null
}

/**
 * Identify the request policy and exact selected messages independently of tail appends.
 * @param session - logged envelope and projected selected content.
 * @param range - inclusive selected surface range.
 * @param spec - resolved policy whose changes permit another pressure attempt.
 * @returns a digest that changes when selected content, route, or policy changes.
 */
export function pressureSelectionKey(session: Session, range: PressureRange, spec: ResolvedCompactSpec): string {
  const nodes = session.surface.nodes
  const seqs = nodes.slice(nodes.indexOf(range.start), nodes.indexOf(range.end) + 1)
  // Selected positional node seqs always refer to committed log events.
  // oxlint-disable-next-line typescript/no-non-null-assertion, typescript/no-deprecated
  const messages = seqs.map(seq => session.deriveEventMessage(session.eventAt(seq)!))
  // A nonempty selected range has a committed surface head.
  // oxlint-disable-next-line typescript/no-non-null-assertion, typescript/no-deprecated
  const head = session.deriveEventMessage(session.eventAt(nodes[0]!)!)
  const system = head?.role === 'system' ? head : undefined
  return createHash('sha256').update(JSON.stringify({ header: session.requestHeader(), spec, system, seqs, messages })).digest('hex')
}
