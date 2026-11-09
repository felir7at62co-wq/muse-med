/** Evidence-grounded semantic dispositions for literal repetition candidates. */
import { z } from 'zod'
import type { ManuscriptMaterialsDocument } from './manuscript-materials.ts'
import { manuscriptQuotationMatches, manuscriptReviewEvidenceSchema, type ManuscriptReviewEvidence } from './manuscript-review-evidence.ts'
import type { RepeatScanResult } from './manuscript-repeat-scan.ts'

/** A literal hit can be an event replay, a legitimate narrative device, or still unverified. */
export const repetitionCheckSchema = z.strictObject({ candidate_sha256: z.string().regex(/^[a-f0-9]{64}$/u),
  status: z.enum(['repeated_event', 'legitimate', 'unknown']),
  explanation: z.string().min(1).refine(value => value.trim().length > 0), evidence: z.array(manuscriptReviewEvidenceSchema) })

interface RepetitionAssessment {
  status: 'consistent' | 'issues' | 'unknown'
  findings: readonly { category: string; evidence: readonly ManuscriptReviewEvidence[] }[]
  unknowns: readonly string[]
}

function quoteRanges(text: string, evidence: ManuscriptReviewEvidence): { start: number; end: number }[] {
  if (evidence.column !== undefined) {
    return [{ start: evidence.column, end: evidence.column + Array.from(evidence.quote).length - 1 }]
  }
  const columns = new Map<number, number>()
  let offset = 0, column = 1
  for (const character of text) { columns.set(offset, column++); offset += character.length }
  columns.set(offset, column)
  const ranges: { start: number; end: number }[] = []
  for (let at = text.indexOf(evidence.quote); at >= 0; at = text.indexOf(evidence.quote, at + 1)) {
    const start = columns.get(at), after = columns.get(at + evidence.quote.length)
    if (start !== undefined && after !== undefined) ranges.push({ start, end: after - 1 })
  }
  return ranges
}

function occurrenceAt(evidence: ManuscriptReviewEvidence, candidate: RepeatScanResult['candidates'][number],
  document: ManuscriptMaterialsDocument): number | undefined {
  if (evidence.role !== document.role || evidence.path !== document.path || evidence.file_sha256 !== document.file_sha256
    || evidence.text_sha256 !== document.text_sha256) return undefined
  const line = document.lines.find(line => line.number === evidence.line)
  if (line === undefined || !manuscriptQuotationMatches(line.text, evidence)) return undefined
  const ranges = quoteRanges(line.text, evidence)
  const matches = candidate.occurrences.flatMap((occurrence, index) => {
    if (evidence.line < occurrence.start.line || evidence.line > occurrence.end.line) return []
    const first = evidence.line === occurrence.start.line ? occurrence.start.column : 1
    const last = evidence.line === occurrence.end.line ? occurrence.end.column : Array.from(line.text).length + 1
    if (!ranges.some(range => range.start <= last && range.end >= first)) return []
    return [index]
  })
  return matches.length === 1 ? matches[0] : undefined
}

/** Require a complete fresh literal scan and an explained, grounded verdict for each returned candidate.
 * @param checks - Structured semantic output rather than assistant prose.
 * @param scan - Host-computed literal candidates bound to this exact target version.
 * @param document - Complete selected target text supplied to the reviewer.
 * @param assessment - Root status and already validated findings and uncertainties.
 * @returns A rejection reason, or undefined when coverage, positions and semantic verdicts agree.
 */
export function validateRepetitionChecks(checks: unknown, scan: RepeatScanResult, document: ManuscriptMaterialsDocument,
  assessment: RepetitionAssessment): string | undefined {
  if (!scan.coverage.complete || scan.target.path !== document.path || scan.target.role !== document.role
    || scan.target.file_sha256 !== document.file_sha256 || scan.target.text_sha256 !== document.text_sha256) {
    return 'Literal scan coverage or target version is incomplete; no passing repetition conclusion is available.'
  }
  const parsed = z.array(repetitionCheckSchema).safeParse(checks)
  if (!parsed.success || parsed.data.length !== scan.candidates.length) return 'Repetition checks must cover every returned literal candidate.'
  const seen = new Set<string>()
  for (const check of parsed.data) {
    const candidate = scan.candidates.find(candidate => candidate.candidate_sha256 === check.candidate_sha256)
    if (candidate === undefined || seen.has(check.candidate_sha256)) return 'A repetition check is duplicated or was not supplied by the Host scan.'
    seen.add(check.candidate_sha256)
    const positions = new Set<number>()
    for (const evidence of check.evidence) {
      const position = occurrenceAt(evidence, candidate, document)
      if (position === undefined) return 'A repetition check quotation does not identify one actual target occurrence; use a column for same-line occurrences.'
      positions.add(position)
    }
    if (check.status !== 'unknown' && positions.size < 2) return 'A repetition verdict needs two distinct actual target occurrences.'
    if (check.status === 'unknown' && assessment.unknowns.length === 0) return 'An unknown repetition candidate must retain a substantive root uncertainty.'
    if (assessment.status === 'consistent' && check.status !== 'legitimate') return 'A consistent root cannot contain an unresolved or repeated event candidate.'
    const finding = assessment.findings.some(finding => finding.category === 'event_repetition'
      && new Set(finding.evidence.flatMap((evidence) => {
        const position = occurrenceAt(evidence, candidate, document)
        return position === undefined ? [] : [position]
      })).size >= 2)
    if (check.status === 'repeated_event' && (assessment.status !== 'issues' || !finding)) return 'A repeated event verdict needs a grounded event_repetition finding at both occurrences.'
    if (check.status !== 'repeated_event' && finding) return 'An evidenced repeated event cannot be classified as legitimate or unknown.'
  }
  return undefined
}
