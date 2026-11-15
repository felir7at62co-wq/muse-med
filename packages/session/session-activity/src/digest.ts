/**
 * Pure rendering of activity digests: one line per watched Session and the reasons that wake the parent.
 *
 * @module @deepseek-ai/dsh-session-activity/digest
 */

import type { SessionActivityState } from './projection.ts'

/** Tool names shown per line, most-called first. */
const SHOWN_TOOLS = 4
/** Deliverable names shown per line, most recent first. */
const SHOWN_FILES = 4

/** One watched Session as the digest renders it. */
export interface DigestEntry {
  /** Parent-chosen task label. */
  readonly label: string
  /** The watched Session id, shown so the parent can address it. */
  readonly sessionId: string
  /** Current totals. */
  readonly state: SessionActivityState
  /** State the parent has logged; null before the first logged digest. Sessions unchanged since it are not listed. */
  readonly delivered: SessionActivityState | null
  /** State last sent to the parent, logged or still pending; facts up to it never wake the parent again. Defaults to `delivered`. */
  readonly notified?: SessionActivityState | null | undefined
  /** Milliseconds the Session has been running without a new event, when a stall was detected. */
  readonly stalledMs?: number | undefined
}

/** Digest rendering options. */
export interface DigestOptions {
  /** Tool names whose new calls wake the parent; their bounded arguments are quoted. */
  readonly wakeTools: readonly string[]
  /** Maximum Session lines; further changed Sessions are counted. */
  readonly maxLines: number
  /** Maximum characters of the whole digest. */
  readonly maxChars: number
}

/**
 * Format a token count compactly.
 * @param tokens - Non-negative token count.
 * @returns e.g. `950`, `21k`, `2.1M`.
 */
export function formatTokens(tokens: number): string {
  if (tokens < 1000) return String(Math.round(tokens))
  if (tokens < 1_000_000) return `${Math.round(tokens / 1000)}k`
  return `${(tokens / 1_000_000).toFixed(1)}M`
}

/**
 * Final path segment of a deliverable path.
 * @param path - Absolute or relative path with `/` or `\` separators.
 * @returns The file name.
 */
function baseName(path: string): string {
  return path.slice(Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\')) + 1)
}

/**
 * Reasons this entry should wake its parent, newest facts only.
 * @param entry - One watched Session.
 * @param options - Wake tool names.
 * @returns Human-readable reasons; empty when nothing needs the parent now.
 */
export function wakeReasons(entry: DigestEntry, options: Pick<DigestOptions, 'wakeTools'>): string[] {
  const since = (entry.notified ?? entry.delivered)?.seq ?? -1
  const reasons: string[] = []
  for (const name of options.wakeTools) {
    const tally = Object.hasOwn(entry.state.tools, name) ? entry.state.tools[name] : undefined
    if (tally !== undefined && tally.lastSeq > since) reasons.push(`${entry.label} called ${name}: ${tally.lastArguments}`)
  }
  const end = entry.state.lastTurnEnd
  if (end !== null && end.seq > since && end.kind === 'error') reasons.push(`${entry.label} turn failed: ${end.text}`)
  if (entry.stalledMs !== undefined) reasons.push(`${entry.label} has had no new activity for ${Math.round(entry.stalledMs / 60_000)} min while running`)
  return reasons
}

/**
 * Render one Session's current totals.
 * @param entry - One watched Session.
 * @returns A single line without a trailing newline.
 */
export function activityLine(entry: DigestEntry): string {
  const state = entry.state
  const parts: string[] = [state.openTurn === null ? `idle after ${state.turns} turns` : `running turn ${state.openTurn}`]
  const tools = Object.entries(state.tools).sort(([a, x], [b, y]) => y.calls - x.calls || a.localeCompare(b))
  if (tools.length > 0) {
    const shown = tools.slice(0, SHOWN_TOOLS).map(([name, tally]) => `${name} ${tally.calls}`)
    parts.push(`tools ${shown.join(', ')}${tools.length > SHOWN_TOOLS ? ` +${tools.length - SHOWN_TOOLS} more` : ''}`)
  }
  if (state.images > 0) parts.push(`images ${state.images}`)
  const files = Object.entries(state.files).sort(([a, x], [b, y]) => y - x || a.localeCompare(b))
  if (files.length > 0) {
    const shown = files.slice(0, SHOWN_FILES).map(([path]) => baseName(path))
    parts.push(`delivered ${shown.join(', ')}${files.length > SHOWN_FILES ? ` +${files.length - SHOWN_FILES} more` : ''}`)
  }
  const jobs = state.jobs
  if (jobs.running + jobs.completed + jobs.failed > 0) parts.push(`jobs ${jobs.running} running/${jobs.completed} done/${jobs.failed} failed`)
  if (state.errors > 0) parts.push(`errors ${state.errors}${state.lastError === null ? '' : ` (last: ${state.lastError.text})`}`)
  if (state.inputTokens > 0) parts.push(`context ${formatTokens(state.contextTokens)} tokens, input total ${formatTokens(state.inputTokens)}`)
  return `- ${entry.label} [${entry.sessionId}] ${parts.join(' · ')}`
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

/**
 * Render a digest for the changed entries, or nothing when none changed.
 * @param entries - Watched Sessions of one parent.
 * @param options - Line, character and wake bounds.
 * @returns The digest, or undefined when no entry changed.
 */
export function renderDigest(entries: readonly DigestEntry[], options: DigestOptions): RenderedDigest | undefined {
  const changed = entries.filter(entry => entry.stalledMs !== undefined
    || (entry.delivered === null ? entry.state.seq >= 0 : entry.delivered !== entry.state))
  if (changed.length === 0) return undefined
  const reasons = changed.flatMap(entry => wakeReasons(entry, options))
  const header = 'Activity of the Sessions you dispatched (running totals; read a Session for details):'
  const lines = changed.slice(0, options.maxLines).map(activityLine)
  const omitted = changed.length - lines.length
  const attention = reasons.length === 0 ? [] : ['Needs your attention:', ...reasons.map(reason => `- ${reason}`)]
  const tail = omitted > 0 ? [`- ${omitted} more Sessions changed.`] : []
  let text = [header, ...lines, ...tail, ...attention].join('\n')
  if (text.length > options.maxChars) text = `${text.slice(0, options.maxChars - 1)}…`
  const summary = reasons.length > 0 ? `${reasons.length} activity item(s) need attention` : `${changed.length} Session(s) progressed`
  return { text, summary, wake: reasons.length > 0 }
}
