/** Host-scheduled episode boundaries and exact evidence checks for a merged manuscript review. */
import { z } from 'zod'
import type { ManuscriptMaterialEpisode, ManuscriptMaterialsDocument } from './manuscript-materials.ts'
import { manuscriptQuotationMatches, manuscriptReviewEvidenceSchema } from './manuscript-review-evidence.ts'

/** One physical boundary between two indexed episode sections in the assessed manuscript. */
export interface EpisodePair { from_episode: number; to_episode: number }

/** Selected complete boundaries and explicit exclusions; preamble lines never become an invented episode. */
export interface EpisodePlan {
  path: string
  file_sha256: string
  checks: EpisodePair[]
  not_checked: (EpisodePair & { reason: 'partial_episode' | 'unread_episode' | 'numbering_gap' })[]
  preamble_lines: number
  issues: string[]
}

/** Model quotations must identify a returned line of the assessed document, never an old or reference version. */
export const episodeCheckEvidenceSchema = manuscriptReviewEvidenceSchema
/** Exact cited location used to verify both sides of an episode boundary. */
export type EpisodeCheckEvidence = z.infer<typeof episodeCheckEvidenceSchema>

/** Every scheduled boundary receives an explicit judgment, explanation and its actual evidence. */
export const episodeCheckSchema = z.strictObject({
  from_episode: z.number().int().positive(), to_episode: z.number().int().positive(),
  status: z.enum(['consistent', 'issues', 'unknown']),
  explanation: z.string().min(1).refine(value => value.trim().length > 0), evidence: z.array(episodeCheckEvidenceSchema),
})

function coverage(episode: ManuscriptMaterialEpisode, returned: ReadonlySet<number>): 'full' | 'partial' | 'unread' {
  let count = 0
  for (let line = episode.start; line <= episode.end; line++) if (returned.has(line)) count++
  return count === 0 ? 'unread' : count === episode.end - episode.start + 1 ? 'full' : 'partial'
}

/** Schedule consecutive physical episode boundaries only when both complete episodes were returned.
 * @param document - Actual current or candidate material, including its complete episode index and returned line numbers.
 * @param maxChecks - Maximum scheduled complete boundaries; overflow fails without truncating checks or exclusions.
 * @returns Version-bound checks, unread or partial boundaries, numbering gaps and indexing failures.
 */
export function buildEpisodePlan(document: ManuscriptMaterialsDocument, maxChecks: number): EpisodePlan {
  const index = document.episode_index
  const plan: EpisodePlan = { path: document.path, file_sha256: document.file_sha256, checks: [], not_checked: [],
    preamble_lines: (index.episodes[0]?.start ?? 1) - 1, issues: [] }
  if (document.role === 'reference') {
    plan.issues.push('参考资料不能作为跨集审校的当前稿或候选稿。')
    return plan
  }
  if (index.state !== 'indexed') {
    plan.issues.push(index.state === 'unavailable' ? '没有可可靠识别的分集标题。' : '分集标题存在歧义，不能建立跨集检查计划。', ...index.issues)
    return plan
  }
  const returned = new Set(document.lines.map(line => line.number))
  const states = index.episodes.map(episode => coverage(episode, returned))
  let previous: ManuscriptMaterialEpisode | undefined
  for (const [position, to] of index.episodes.entries()) {
    const from = previous
    previous = to
    if (from === undefined) continue
    const pair = { from_episode: from.episode, to_episode: to.episode }
    if (to.episode !== from.episode + 1) plan.not_checked.push({ ...pair, reason: 'numbering_gap' })
    else if (states[position - 1] === 'unread' || states[position] === 'unread') {
      plan.not_checked.push({ ...pair, reason: 'unread_episode' })
    } else if (states[position - 1] !== 'full' || states[position] !== 'full') {
      plan.not_checked.push({ ...pair, reason: 'partial_episode' })
    } else plan.checks.push(pair)
  }
  if (plan.checks.length > maxChecks) throw Error('CROSS_EPISODE_PLAN_LIMIT: 集界计划超过配置上限，未截断检查或遗漏范围。')
  return plan
}

function belongs(evidence: EpisodeCheckEvidence, document: ManuscriptMaterialsDocument, episode: number): boolean {
  if (evidence.role !== document.role || evidence.path !== document.path || evidence.file_sha256 !== document.file_sha256
    || evidence.text_sha256 !== document.text_sha256) return false
  const section = document.episode_index.episodes.find(value => value.episode === episode)
  if (section === undefined || evidence.line < section.start || evidence.line > section.end) return false
  const line = document.lines.find(value => value.number === evidence.line)
  return line !== undefined && manuscriptQuotationMatches(line.text, evidence)
}

/** Require complete planned coverage and grounded two-sided evidence before accepting a cross-episode judgment.
 * @param checks - Structured model output, parsed independently from model prose.
 * @param plan - Exact Host schedule supplied to this review.
 * @param document - Version-bound assessed document whose numbered lines were supplied.
 * @param assessment - Root judgment and findings already checked by the ordinary continuity validator.
 * @returns A rejection reason, or undefined when pair coverage, citations and judgment agree.
 */
export function validateEpisodeChecks(checks: unknown, plan: EpisodePlan, document: ManuscriptMaterialsDocument,
  assessment: {
    status: 'consistent' | 'issues' | 'unknown'
    findings: readonly { evidence: readonly EpisodeCheckEvidence[] }[]
    unknowns: readonly string[]
  }): string | undefined {
  if (plan.path !== document.path || plan.file_sha256 !== document.file_sha256) return 'Episode plan does not match the assessed file version.'
  const parsed = z.array(episodeCheckSchema).safeParse(checks)
  if (!parsed.success) return 'Episode checks are missing or invalid.'
  if (plan.issues.length > 0 || plan.checks.length === 0) return 'No complete unambiguous episode boundary is available for review.'
  if (parsed.data.length !== plan.checks.length) return 'Episode checks do not cover the complete Host schedule.'
  const seen = new Set<string>()
  for (const check of parsed.data) {
    const key = `${check.from_episode}:${check.to_episode}`
    if (seen.has(key) || !plan.checks.some(pair => pair.from_episode === check.from_episode && pair.to_episode === check.to_episode)) {
      return 'An episode check is duplicated or was not scheduled.'
    }
    seen.add(key)
    let from = false, to = false
    for (const evidence of check.evidence) {
      const left = belongs(evidence, document, check.from_episode), right = belongs(evidence, document, check.to_episode)
      if (!left && !right) return 'An episode quotation is not from the assessed boundary and supplied file version.'
      from ||= left; to ||= right
    }
    if (check.status !== 'unknown' && (!from || !to)) return 'A checked boundary needs exact assessed-document evidence from each episode.'
    if (check.status === 'unknown' && assessment.unknowns.length === 0) return 'An unknown boundary must retain a substantive root uncertainty.'
    if (assessment.status === 'consistent' && check.status !== 'consistent') return 'The root judgment cannot be consistent with unresolved boundaries.'
    const finding = assessment.findings.some(value => value.evidence.some(evidence => belongs(evidence, document, check.from_episode))
      && value.evidence.some(evidence => belongs(evidence, document, check.to_episode)))
    if (check.status === 'issues' && (assessment.status !== 'issues' || !finding)) return 'A boundary issue needs a grounded root finding for both episodes.'
    if (check.status !== 'issues' && finding) return 'A grounded boundary conflict cannot be reported as consistent or unknown.'
  }
  return undefined
}
