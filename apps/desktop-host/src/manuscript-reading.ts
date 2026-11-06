/** Version-specific source pagination and exact returned-text coverage. */
import { z } from 'zod'
import { buildWindow, type ReadPosition, type WindowResult } from '@deepseek-ai/dsh-tool-fs'
import type { ManuscriptDocument } from './manuscript-document.ts'

const spanSchema = z.strictObject({ start: z.number().int().min(0), end: z.number().int().min(0) })
  .refine(span => span.end >= span.start, '来源区间结束位置不能早于开始。')
/** Returned reading-text intervals; positions count Unicode code points after CRLF and terminal-CR display normalization. */
export const manuscriptReadingSchema = z.strictObject({ path: z.string().min(1), sha256: z.string().regex(/^[a-f0-9]{64}$/u),
  spans: z.array(spanSchema).refine(spans => spans.every((span, index) => {
    const previous = spans[index - 1]
    return previous === undefined || span.start > previous.end
  }), '来源区间必须有序且已合并。'), empty_returned: z.boolean().optional() })
/** A source-version record of text returned by read_source, not a semantic review verdict. */
export type ManuscriptReading = z.infer<typeof manuscriptReadingSchema>
/** Deployment limits for one complete source page. */
export interface ManuscriptReadingLimits { maxLines: number; maxLineCharacters: number; maxBytes: number }

/**
 * Match the shared reader's CRLF and terminal-CR display without dropping internal carriage returns.
 * @param text - Complete extracted manuscript text before display normalization.
 * @returns Reading text whose Unicode positions and exact quotations use the same newline representation.
 */
export function manuscriptReadingText(text: string): string { return text.replace(/\r\n/g, '\n').replace(/\r$/u, '') }

function indexAt(lines: readonly string[], position: ReadPosition): number {
  const line = lines[position.offset - 1]
  if (line === undefined || position.column > Array.from(line).length + 1) throw Error('MANUSCRIPT_READ_POSITION: 来源续读位置不存在。')
  return lines.slice(0, position.offset - 1).reduce((total, value) => total + Array.from(value).length + 1, 0) + position.column - 1
}

function positionAt(lines: readonly string[], index: number): ReadPosition {
  let rest = index
  for (const [offset, text] of lines.entries()) {
    const length = Array.from(text).length
    if (rest <= length || offset === lines.length - 1) return { offset: offset + 1, column: rest + 1 }
    rest -= length + 1
  }
  return { offset: 1, column: 1 }
}

/**
 * Return one complete reading-text page under byte, line and per-line limits.
 * @param source - Complete bounded text and exact source-file identity.
 * @param position - First line and Unicode column to return.
 * @param limit - Requested line count within the deployment cap.
 * @param limits - Deployment-controlled source page limits.
 * @returns Text page and its half-open character interval; no source file is changed.
 */
export async function readManuscriptPage(source: ManuscriptDocument, position: ReadPosition, limit: number,
  limits: ManuscriptReadingLimits): Promise<WindowResult & { start: number; end: number }> {
  if (limit > limits.maxLines) throw Error('MANUSCRIPT_READ_LIMIT: 每页行数超出配置。')
  const text = manuscriptReadingText(source.text), lines = text.split('\n')
  const start = indexAt(lines, position)
  const page = await buildWindow([source.text], { ...position, limit,
    maxLineLength: limits.maxLineCharacters, maxBytes: limits.maxBytes }, source.path)
  const end = page.continuation ? indexAt(lines, page.continuation) : Array.from(text).length
  return { ...page, start, end }
}

/**
 * Merge returned intervals for the current immutable source version.
 * @param previous - Current or historical page receipts.
 * @param source - Exact source version supplied by the reader.
 * @param page - Successfully produced page interval.
 * @returns A new version-specific record with overlapping intervals merged.
 */
export function recordManuscriptPage(previous: readonly ManuscriptReading[], source: ManuscriptDocument,
  page: { start: number; end: number }): ManuscriptReading {
  const old = previous.find(entry => entry.path === source.path && entry.sha256 === source.sha256)
  const spans = [...old?.spans ?? [], { start: page.start, end: page.end }].sort((a, b) => a.start - b.start)
  const merged: { start: number; end: number }[] = []
  for (const span of spans) {
    const tail = merged.at(-1)
    if (tail && span.start <= tail.end) tail.end = Math.max(tail.end, span.end)
    else merged.push({ ...span })
  }
  return { path: source.path, sha256: source.sha256, spans: merged,
    ...(manuscriptReadingText(source.text).length === 0 ? { empty_returned: true } : {}) }
}

/**
 * Describe missing source intervals without treating old-version reads as current.
 * @param sources - Current complete source documents in adopted order.
 * @param readings - Returned-page receipts, including historical versions.
 * @returns Exact character coverage and resumable missing ranges; completion does not certify understanding.
 */
export function manuscriptReadingCoverage(sources: readonly ManuscriptDocument[], readings: readonly ManuscriptReading[]) {
  return sources.map((source) => {
    const text = manuscriptReadingText(source.text), lines = text.split('\n'), total = Array.from(text).length
    const record = readings.find(entry => entry.path === source.path && entry.sha256 === source.sha256)
    if (record?.spans.some(span => span.end > total)) throw Error('MANUSCRIPT_READ_RECORD: 已存阅读区间超出当前来源，不能判定完整。')
    const missing: { start_line: number; end_line: number; start_column: number; end_column: number }[] = []
    let cursor = 0, returned = 0
    for (const span of record?.spans ?? []) {
      if (span.start > cursor) {
        const start = positionAt(lines, cursor), end = positionAt(lines, span.start)
        missing.push({ start_line: start.offset, start_column: start.column, end_line: end.offset, end_column: end.column })
      }
      returned += Math.max(0, Math.min(total, span.end) - Math.max(cursor, span.start))
      cursor = Math.max(cursor, span.end)
    }
    if (cursor < total) {
      const start = positionAt(lines, cursor), end = positionAt(lines, total)
      missing.push({ start_line: start.offset, start_column: start.column, end_line: end.offset, end_column: end.column })
    }
    const complete = total === 0 ? record?.empty_returned === true : missing.length === 0
    return { path: source.path, sha256: source.sha256, total_characters: total,
      returned_characters: returned, complete, missing,
      coverage_basis: 'returned_source_text', semantic_assessment: 'not_performed' }
  })
}
