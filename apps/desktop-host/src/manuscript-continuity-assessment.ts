/** Pure structured-review fields and status rules shared by the submitting tool and Host validation. */
import { z } from 'zod'
import { episodeCheckSchema } from './manuscript-episode-checks.ts'
import { manuscriptReviewEvidenceSchema } from './manuscript-review-evidence.ts'
import { repetitionCheckSchema } from './manuscript-repeat-review.ts'

const findingSchema = z.strictObject({
  category: z.enum(['event_order', 'character_state', 'information_state', 'object_state', 'transition', 'event_repetition']),
  description: z.string().min(1).refine(value => value.trim().length > 0), evidence: z.array(manuscriptReviewEvidenceSchema).min(2),
})

/** JSON returned through the child's committed structured_output tool. */
export const continuityAssessmentSchema = z.strictObject({ status: z.enum(['consistent', 'issues', 'unknown']),
  findings: z.array(findingSchema), unknowns: z.array(z.string().min(1).refine(value => value.trim().length > 0)),
  episode_checks: z.array(episodeCheckSchema).optional(), repeat_checks: z.array(repetitionCheckSchema).optional() })
/** Validated review finding with two or more exact, distinct material citations. */
export type ContinuityFinding = z.infer<typeof findingSchema>
/** Semantic judgment before file freshness and exact quotation checks. */
export type ContinuityAssessment = z.infer<typeof continuityAssessmentSchema>

/** Name every rejected field of a structured submission so the reviewer can correct that exact field.
 * @param issues - Issues from a failed parse of the submitted tool arguments.
 * @returns Distinct `path: problem` entries joined by `; `; array indices collapse to `[]`, repeated problems report their item count.
 */
export function submissionIssueSummary(issues: z.ZodError['issues']): string {
  const counts = new Map<string, number>()
  for (const issue of issues) {
    const path = issue.path.map(part => typeof part === 'number' ? '[]' : `.${String(part)}`).join('').replace(/^\./u, '')
    const entry = `${path === '' ? '(root)' : path}: ${issue.message}`
    counts.set(entry, (counts.get(entry) ?? 0) + 1)
  }
  return [...counts].map(([entry, count]) => count > 1 ? `${entry} (${count} items)` : entry).join('; ')
}

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
