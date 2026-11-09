/** Pure structured-review fields and status rules shared by the submitting tool and Host validation. */
import { z } from 'zod'
import { episodeCheckSchema } from './manuscript-episode-checks.ts'

const evidenceSchema = z.strictObject({ role: z.enum(['current', 'reference', 'candidate']),
  path: z.string().min(1), file_sha256: z.string().regex(/^[a-f0-9]{64}$/u),
  text_sha256: z.string().regex(/^[a-f0-9]{64}$/u), line: z.number().int().positive(),
  quote: z.string().min(1).refine(quote => quote.trim().length > 0) })
const findingSchema = z.strictObject({
  category: z.enum(['event_order', 'character_state', 'information_state', 'object_state', 'transition']),
  description: z.string().min(1).refine(value => value.trim().length > 0), evidence: z.array(evidenceSchema).min(2),
})

/** JSON returned through the child's committed structured_output tool. */
export const continuityAssessmentSchema = z.strictObject({ status: z.enum(['consistent', 'issues', 'unknown']),
  findings: z.array(findingSchema), unknowns: z.array(z.string().min(1).refine(value => value.trim().length > 0)),
  episode_checks: z.array(episodeCheckSchema).optional() })
/** Validated review finding with two or more exact, distinct material citations. */
export type ContinuityFinding = z.infer<typeof findingSchema>
/** Semantic judgment before file freshness and exact quotation checks. */
export type ContinuityAssessment = z.infer<typeof continuityAssessmentSchema>

/** Reject inconsistent status declarations without altering findings or actual unknowns.
 * @param value - Result fields already parsed from the structured tool JSON.
 * @returns Feedback for a rejected combination, or undefined when the status agrees with its arrays.
 */
export function continuityAssessmentProblem(value: ContinuityAssessment): string | undefined {
  if (value.status === 'consistent' && (value.findings.length > 0 || value.unknowns.length > 0)) {
    return 'status consistent requires both findings and unknowns to be empty. '
      + 'Do not discard actual unknowns to satisfy this rule; use status unknown when substantive uncertainties remain, '
      + 'or status issues when evidenced conflicts are present.'
  }
  if (value.status === 'issues' && value.findings.length === 0) {
    return 'status issues requires at least one evidenced finding. '
      + 'Use status unknown for substantive uncertainty without an evidenced conflict.'
  }
  if (value.status === 'unknown' && value.unknowns.length === 0) {
    return 'status unknown requires at least one substantive uncertainty in unknowns. '
      + 'Report the missing information instead of asserting an unsupported judgment.'
  }
  return undefined
}
