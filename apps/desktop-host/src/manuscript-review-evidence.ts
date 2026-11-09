/** Exact manuscript quotation identities shared by independent review results. */
import { z } from 'zod'

/** Optional columns distinguish repeated spans on one extracted line using one-based Unicode code points. */
export const manuscriptReviewEvidenceSchema = z.strictObject({
  role: z.enum(['current', 'reference', 'candidate']), path: z.string().min(1),
  file_sha256: z.string().regex(/^[a-f0-9]{64}$/u), text_sha256: z.string().regex(/^[a-f0-9]{64}$/u),
  line: z.number().int().positive(), quote: z.string().min(1).refine(value => value.trim().length > 0),
  column: z.number().int().positive().optional(),
})
/** A quoted original location, not a model paraphrase or an automatically inferred event. */
export type ManuscriptReviewEvidence = z.infer<typeof manuscriptReviewEvidenceSchema>

/** Match a literal quotation, checking its exact starting column when supplied.
 * @param text - Actual extracted line text returned to the reviewer.
 * @param evidence - Parsed quotation and optional Unicode column.
 * @returns Whether the line contains the quotation at its declared position.
 */
export function manuscriptQuotationMatches(text: string, evidence: Pick<ManuscriptReviewEvidence, 'quote' | 'column'>): boolean {
  if (evidence.column === undefined) return text.includes(evidence.quote)
  const characters = Array.from(text), quoted = Array.from(evidence.quote)
  return characters.slice(evidence.column - 1, evidence.column - 1 + quoted.length).join('') === evidence.quote
}
