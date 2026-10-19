/** Paragraph-level user revisions and bounded checks for subsequent manuscript candidates. */
import { createHash } from 'node:crypto'
import { diffArrays } from 'diff'

/** Deployment limits for complete paragraph comparison; exceeding either limit fails without truncation. */
export interface ManuscriptDiffLimits {
  /** Maximum nonblank paragraphs in each manuscript. */
  maxParagraphs: number
  /** Maximum paragraph additions and removals searched by the diff engine. */
  maxEditLength: number
}

/** One contiguous user edit; an empty `after` retains an exact-paragraph deletion tombstone. */
export interface ManuscriptChange {
  /** Stable identifier bound to both manuscripts, locations, and exact normalized content. */
  id: string
  kind: 'insert' | 'replace' | 'delete'
  /** One-based baseline paragraph position, including the insertion boundary after its last paragraph. */
  beforeStart: number
  /** One-based revised paragraph position, including the deletion boundary after its last paragraph. */
  afterStart: number
  before: string[]
  after: string[]
}

/** Complete comparison of a delivered baseline and the user's revised manuscript. */
export interface ManuscriptDiff {
  baseline: string[]
  revised: string[]
  changes: ManuscriptChange[]
  limits: ManuscriptDiffLimits
}

/** One user edit that a later candidate changed or restored without authorization. */
export interface ManuscriptViolation {
  changeId: string
  code: 'protected_paragraph_changed' | 'deleted_paragraph_restored'
  /** Exact normalized user text, or exact baseline text the user removed. */
  text: string
}

/** Deterministic validation result; an empty violation list permits only the checked textual protections. */
export interface ManuscriptValidation {
  ok: boolean
  violations: ManuscriptViolation[]
}

/**
 * Normalize line endings, blank lines, outside whitespace, and simple heading/emphasis/code markers.
 * Internal whitespace, punctuation, speaker names, and scene numbers remain significant.
 * @param text - Actual manuscript text extracted by the owning reader.
 * @returns Nonblank paragraphs in their original order.
 */
export function manuscriptParagraphs(text: string): string[] {
  return text.replace(/^\uFEFF/, '').split(/\r\n?|\n/u).map(line => line.trim()
    .replace(/^#{1,6}\s+/u, '')
    .replace(/\*\*([^*\n]+)\*\*/gu, '$1').replace(/__([^_\n]+)__/gu, '$1')
    .replace(/(?<!\*)\*([^*\n]+)\*(?!\*)/gu, '$1').replace(/(?<!_)_([^_\n]+)_(?!_)/gu, '$1')
    .replace(/`([^`\n]+)`/gu, '$1').trim()).filter(Boolean)
}

function compare(before: string[], after: string[], limits: ManuscriptDiffLimits) {
  if (!Number.isSafeInteger(limits.maxParagraphs) || limits.maxParagraphs < 1
    || !Number.isSafeInteger(limits.maxEditLength) || limits.maxEditLength < 1) {
    throw Error('manuscript_diff_limits: comparison limits must be positive safe integers')
  }
  if (before.length > limits.maxParagraphs || after.length > limits.maxParagraphs) {
    throw Error('manuscript_diff_budget: manuscript exceeds the paragraph budget; no partial comparison was produced')
  }
  const parts = diffArrays(before, after, { maxEditLength: limits.maxEditLength })
  if (parts === undefined) throw Error('manuscript_diff_budget: edit distance exceeds the comparison budget; no partial comparison was produced')
  return parts
}

/**
 * Compare complete manuscripts with a bounded Myers diff instead of a paragraph-count matrix.
 * @param baseline - Previously delivered manuscript body.
 * @param revised - Actual user-returned manuscript body.
 * @param limits - Deployment comparison budgets.
 * @returns Every user change, with stable identities and exact-paragraph tombstones.
 */
export function diffManuscript(baseline: string, revised: string, limits: ManuscriptDiffLimits): ManuscriptDiff {
  const before = manuscriptParagraphs(baseline), after = manuscriptParagraphs(revised)
  const parts = compare(before, after, limits), changes: ManuscriptChange[] = []
  const identity = createHash('sha256').update(JSON.stringify([before, after])).digest('hex')
  let oldPosition = 0, newPosition = 0
  let pending: { beforeStart: number; afterStart: number; removed: string[]; added: string[] } | undefined
  const flush = () => {
    if (pending === undefined) return
    const { beforeStart, afterStart, removed, added } = pending
    const kind = removed.length === 0 ? 'insert' : added.length === 0 ? 'delete' : 'replace'
    const digest = createHash('sha256').update(JSON.stringify([identity, kind, beforeStart, afterStart, removed, added])).digest('hex')
    changes.push({ id: `mc_${digest}`, kind, beforeStart, afterStart, before: removed, after: added })
    pending = undefined
  }
  for (const part of parts) {
    if (!part.added && !part.removed) {
      flush()
      oldPosition += part.value.length; newPosition += part.value.length
      continue
    }
    pending ??= { beforeStart: oldPosition + 1, afterStart: newPosition + 1, removed: [], added: [] }
    if (part.removed) { pending.removed.push(...part.value); oldPosition += part.value.length }
    else { pending.added.push(...part.value); newPosition += part.value.length }
  }
  flush()
  return { baseline: before, revised: after, changes, limits: { ...limits } }
}

function counts(paragraphs: readonly string[]): Map<string, number> {
  const result = new Map<string, number>()
  for (const paragraph of paragraphs) result.set(paragraph, (result.get(paragraph) ?? 0) + 1)
  return result
}

/**
 * Preserve user-added/replaced paragraphs in their diff-aligned order and forbid increased occurrences of removed paragraphs.
 * Changes to unmodified paragraphs remain permitted. This checks exact paragraph text, not paraphrased story meaning.
 * @param review - Host-owned comparison of the real baseline and user revision.
 * @param candidate - Complete proposed manuscript body.
 * @returns All affected user edits; this function neither rewrites text nor grants exceptions.
 */
export function validateManuscriptCandidate(review: ManuscriptDiff, candidate: string): ManuscriptValidation {
  const paragraphs = manuscriptParagraphs(candidate), parts = compare(review.revised, paragraphs, review.limits)
  const protectedAt = new Map<number, ManuscriptChange>()
  for (const change of review.changes) {
    for (let offset = 0; offset < change.after.length; offset++) protectedAt.set(change.afterStart - 1 + offset, change)
  }
  const violations: ManuscriptViolation[] = [], seen = new Set<string>()
  const record = (change: ManuscriptChange, code: ManuscriptViolation['code'], text: string) => {
    const key = JSON.stringify([change.id, code, text])
    if (!seen.has(key)) { seen.add(key); violations.push({ changeId: change.id, code, text }) }
  }
  let revisedPosition = 0
  for (const part of parts) {
    if (part.added) continue
    if (part.removed) for (const [offset, text] of part.value.entries()) {
      const change = protectedAt.get(revisedPosition + offset)
      if (change !== undefined) record(change, 'protected_paragraph_changed', text)
    }
    revisedPosition += part.value.length
  }
  const revisedCounts = counts(review.revised), candidateCounts = counts(paragraphs)
  for (const change of review.changes) for (const paragraph of change.before) {
    if ((candidateCounts.get(paragraph) ?? 0) > (revisedCounts.get(paragraph) ?? 0)) {
      record(change, 'deleted_paragraph_restored', paragraph)
    }
  }
  return { ok: violations.length === 0, violations }
}
