/**
 * Pure rendering of Session status lines, the session-list view a parent reads, and of digests
 * that report changed lines and the states that need the parent.
 *
 * @module @deepseek-ai/dsh-session-activity/digest
 */

import { boundActivityText } from './projection.ts'
import type { LastToolCall } from './projection.ts'

/** Characters kept from one activity item label. */
const LABEL_CHARS = 40
/** Activity item labels shown per family. */
const SHOWN_LABELS = 3

/** What a Session is doing, as the session list shows it. */
export type SessionStatusKind = 'running' | 'idle' | 'question' | 'approval' | 'failed' | 'not-open'

/** One family of work still running for a Session, such as jobs or subagents. */
export interface ActivityFamily {
  /** Family key reported by its provider, such as `job` or `subagent`. */
  readonly kind: string
  /** Labels of the running items; empty for a family without per-item labels. */
  readonly labels: readonly string[]
}

/** The facts behind one status line. */
export interface SessionStatus {
  /** Current state. */
  readonly kind: SessionStatusKind
  /** When the current state began, epoch milliseconds; null when unknown. */
  readonly since: number | null
  /** The latest tool call. */
  readonly lastTool: LastToolCall | null
  /** Running work other than the turn itself. */
  readonly activity: readonly ActivityFamily[]
  /** Failure text of the latest turn when `kind` is `failed`, otherwise empty. */
  readonly error: string
}

/** One watched Session as a digest renders it. */
export interface DigestEntry {
  /** Parent-chosen task label. */
  readonly label: string
  /** The watched Session id, shown so the parent can open it. */
  readonly sessionId: string
  /** Current status. */
  readonly status: SessionStatus
  /** Status key the parent has logged; null before the first logged digest. */
  readonly delivered: string | null
  /** State kind last sent to the parent, logged or pending; null before the first. */
  readonly notified: SessionStatusKind | null
  /** Milliseconds the Session has been running without a new event, when a stall was detected. */
  readonly stalledMs?: number | undefined
}

/** A rendered digest. */
export interface RenderedDigest {
  /** Complete model-facing text, at most `maxChars` characters. */
  readonly text: string
  /** One-line account for the notice summary. */
  readonly summary: string
  /** Whether the digest carries a reason to wake the parent. */
  readonly wake: boolean
}

const stateText: Record<SessionStatusKind, string> = {
  'running': 'running',
  'idle': 'idle',
  'question': 'waiting for an answer in its own chat',
  'approval': 'waiting for an approval in its own chat',
  'failed': 'last turn failed',
  'not-open': 'not open',
}

/**
 * Render the state-independent part of a status line; equal keys mean nothing the parent needs changed.
 * @param status - Current status.
 * @returns The line without its duration.
 */
export function statusKey(status: SessionStatus): string {
  const parts = [stateText[status.kind]]
  if (status.lastTool !== null) parts.push(`last tool ${status.lastTool.name}`)
  for (const family of status.activity) {
    const shown = family.labels.slice(0, SHOWN_LABELS).map(label => boundActivityText(label, LABEL_CHARS))
    const more = family.labels.length > SHOWN_LABELS ? ` +${family.labels.length - SHOWN_LABELS} more` : ''
    parts.push(shown.length === 0 ? family.kind : `${family.kind}: ${shown.join(', ')}${more}`)
  }
  if (status.error !== '') parts.push(`error: ${status.error}`)
  return parts.join(' · ')
}

/**
 * Render a full status line.
 * @param status - Current status.
 * @param now - Current time, epoch milliseconds.
 * @returns The state with its duration, then the rest of the key.
 */
export function statusText(status: SessionStatus, now: number): string {
  const key = statusKey(status)
  if (status.since === null) return key
  const minutes = Math.floor(Math.max(0, now - status.since) / 60_000)
  const head = stateText[status.kind]
  return `${head} for ${minutes < 1 ? 'under 1' : minutes} min${key.slice(head.length)}`
}

/**
 * Reasons this entry should wake its parent.
 * @param entry - One watched Session.
 * @returns Human-readable reasons; empty when nothing needs the parent now.
 */
export function wakeReasons(entry: DigestEntry): string[] {
  const reasons: string[] = []
  const status = entry.status
  const call = status.lastTool === null ? '' : ` (last call: ${status.lastTool.name} ${status.lastTool.arguments})`
  if (status.kind !== entry.notified) {
    if (status.kind === 'question') reasons.push(`${entry.label} is waiting for an answer in its own chat${call}`)
    if (status.kind === 'approval') reasons.push(`${entry.label} is waiting for an approval in its own chat${call}`)
    if (status.kind === 'failed') reasons.push(`${entry.label} last turn failed: ${status.error}`)
  }
  if (entry.stalledMs !== undefined) {
    reasons.push(`${entry.label} has shown no new activity for ${Math.floor(entry.stalledMs / 60_000)} min while running`)
  }
  return reasons
}

/**
 * Render a digest of the entries whose status changed, or nothing when none changed.
 * @param entries - Watched Sessions of one parent.
 * @param options - Line and character bounds.
 * @param now - Current time, epoch milliseconds.
 * @returns The digest, or undefined when no entry changed.
 */
export function renderDigest(entries: readonly DigestEntry[], options: { readonly maxLines: number; readonly maxChars: number },
  now: number): RenderedDigest | undefined {
  const changed = entries.filter(entry => entry.stalledMs !== undefined
    || (statusKey(entry.status) !== entry.delivered && !(entry.delivered === null && entry.status.kind === 'not-open')))
  if (changed.length === 0) return undefined
  const reasons = changed.flatMap(wakeReasons)
  const header = 'Status of the Sessions you dispatched, as the session list shows it (read a Session for details):'
  const lines = changed.slice(0, options.maxLines).map(entry => `- ${entry.label} [${entry.sessionId}] ${statusText(entry.status, now)}`)
  const omitted = changed.length - lines.length
  const tail = omitted > 0 ? [`- ${omitted} more Sessions changed.`] : []
  const attention = reasons.length === 0 ? [] : ['Needs your attention:', ...reasons.map(reason => `- ${reason}`)]
  let text = [header, ...lines, ...tail, ...attention].join('\n')
  if (text.length > options.maxChars) text = `${text.slice(0, options.maxChars - 1)}…`
  const summary = reasons.length > 0 ? `${reasons.length} Session state(s) need attention` : `${changed.length} Session status change(s)`
  return { text, summary, wake: reasons.length > 0 }
}
