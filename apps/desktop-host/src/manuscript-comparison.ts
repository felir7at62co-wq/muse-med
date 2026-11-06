/** Source-anchored quantity comparisons retain model interpretation without certifying contradictions. */
import { brandString, type Branded } from '@deepseek-ai/dsh-brand'
import { z } from 'zod'
import type { ManuscriptDocument } from './manuscript-document.ts'
import { manuscriptCharacterSchema, manuscriptSourceEvidenceSchema, manuscriptEvidenceContext, validateManuscriptEvidence,
  type ManuscriptCharacter, type ManuscriptSourceEvidence } from './manuscript-relationships.ts'
import { manuscriptSourceCitationContext, manuscriptSourceCitationLabels,
  type ManuscriptSourceCitationLabel, type ManuscriptSourceCitationContext } from './manuscript-source-context.ts'

/** Stable identity of one model-authored comparison within the adopted task. */
export type ManuscriptComparisonId = Branded<'ManuscriptComparisonId'>

const text = z.string().trim().min(1)
const observation = z.strictObject({
  value_text: z.string().refine(value => value.trim().length > 0, '数值原句片段不能为空。'),
  unit: text.optional(), condition: text.optional(), story_time: text.optional(),
  evidence: z.array(manuscriptSourceEvidenceSchema).min(1),
})

/** Model-authored labels and exact source quotations; derived context is never an input field. */
export const manuscriptComparisonSchema = z.strictObject({
  comparison_id: text.transform(brandString<ManuscriptComparisonId>),
  subject_id: manuscriptCharacterSchema.shape.character_id, quantity: text,
  before: observation, after: observation,
  explanation_evidence: z.array(manuscriptSourceEvidenceSchema).default([]),
  explanation_kind: z.enum(['explicit_change', 'general_rule', 'suggested']).optional(),
  interpretation: z.enum(['explained_change', 'possible_change', 'potential_conflict', 'unresolved', 'not_comparable']),
  rationale: text,
}).refine(row => row.interpretation !== 'explained_change' || row.explanation_evidence.length > 0,
  { message: 'MANUSCRIPT_COMPARISON_EXPLANATION: 正常变化需要实际过程引文，不能用空解释证明变化。', path: ['explanation_evidence'] })

/** Canonical evidence and model-authored unit, condition and story-time labels. */
export type ManuscriptComparison = z.infer<typeof manuscriptComparisonSchema>

/** Exact source lines and their actual enclosing sections, independent of the model's labels. */
export interface ManuscriptComparisonContext {
  source_path: string
  source_sha256: string
  start_line: number
  end_line: number
  context: ManuscriptSourceCitationContext
  time_basis: ReturnType<typeof manuscriptEvidenceContext>['time_basis']
  line_labels: ReturnType<typeof manuscriptEvidenceContext>['line_labels']
}

/** Same-version source navigation spanning compared observations and their explanations. */
export interface ManuscriptComparisonSourceRange {
  source_path: string
  source_sha256: string
  start_line: number
  end_line: number
}

/** Actual selected source ownership for one endpoint or explanation quotation. */
export interface ManuscriptComparisonCitationLabel extends ManuscriptSourceCitationLabel {
  source_path: string
  source_sha256: string
}

/** One supplied endpoint time label that has no complete literal source occurrence. */
export interface ManuscriptComparisonTimeIssue {
  endpoint: 'before' | 'after'
  story_time: string
  code: 'unsupported_time'
  message: string
}

/** Stored claims that need rereading or an explicit change assessment before active recovery. */
export type ManuscriptComparisonReviewIssue = ManuscriptComparisonTimeIssue | {
  code: 'explanation_kind_requires_review'
  message: string
}

/** Verified quotations with independently recomputed source sections and explicit semantic limits. */
export interface ManuscriptComparisonResult {
  record: ManuscriptComparison
  literal_difference: boolean
  effective_interpretation: ManuscriptComparison['interpretation']
  missing_basis: string[]
  interpretation_reasons: string[]
  source_contexts: {
    before: ManuscriptComparisonContext[]
    after: ManuscriptComparisonContext[]
    explanation: ManuscriptComparisonContext[]
  }
  citation_labels: {
    before: ManuscriptComparisonCitationLabel[]
    after: ManuscriptComparisonCitationLabel[]
    explanation: ManuscriptComparisonCitationLabel[]
  }
  bridge_ranges: ManuscriptComparisonSourceRange[]
  semantic_assessment: 'model_authored'
  contradiction_proven: false
  labels_verified: false
  intervening_context_assessed: false
  notice: string
}

/**
 * Collect both endpoints and change explanations for current-source invalidation.
 * @param row - Parsed model-authored comparison.
 * @returns Every exact source anchor, retaining endpoint and explanation order.
 */
export function comparisonEvidence(row: ManuscriptComparison): ManuscriptSourceEvidence[] {
  return [...row.before.evidence, ...row.after.evidence, ...row.explanation_evidence]
}

function endpointContext(anchor: ManuscriptSourceEvidence, sources: readonly ManuscriptDocument[],
  storyTime?: string): ManuscriptComparisonContext {
  const source = comparisonSource(anchor, sources)
  const actual = manuscriptEvidenceContext(anchor, [source], storyTime)
  return { source_path: actual.source_path, source_sha256: actual.source_sha256,
    start_line: actual.start_line, end_line: actual.end_line,
    context: manuscriptSourceCitationContext(actual),
    time_basis: actual.time_basis, line_labels: actual.line_labels }
}

function comparisonSource(anchor: ManuscriptSourceEvidence, sources: readonly ManuscriptDocument[]): ManuscriptDocument {
  const source = sources.find(source => source.path === anchor.source_path && source.sha256 === anchor.source_sha256)
  if (!source) {
    throw Error('MANUSCRIPT_COMPARISON_STALE: 对照来源版本已变或不在当前任务中，请重读后登记。')
  }
  return source
}

function endpointTimeIssues(row: ManuscriptComparison,
  contexts: Pick<ManuscriptComparisonResult['source_contexts'], 'before' | 'after'>): ManuscriptComparisonTimeIssue[] {
  const issues: ManuscriptComparisonTimeIssue[] = []
  for (const endpoint of ['before', 'after'] as const) {
    const value = row[endpoint].story_time
    if (value !== undefined && !contexts[endpoint].some(context => context.time_basis.length > 0)) {
      issues.push({ endpoint, story_time: value, code: 'unsupported_time',
        message: `${endpoint}.story_time=${JSON.stringify(value)}须完整逐字出现在本端引文或其真实标题中；未明示时省略，不自由推写时点。` })
    }
  }
  return issues
}

/**
 * Identify old endpoint time labels unsupported by the same current source quotations or their actual titles.
 * @param row - Parsed comparison with canonical source paths.
 * @param sources - Complete current bound sources with unchanged file digests.
 * @returns Unsupported supplied time labels; omitted times remain unknown.
 * @throws Error when a source version, range or quotation no longer matches.
 */
export function comparisonTimeIssues(row: ManuscriptComparison, sources: readonly ManuscriptDocument[]): ManuscriptComparisonTimeIssue[] {
  return endpointTimeIssues(row, {
    before: row.before.evidence.map(anchor => endpointContext(anchor, sources, row.before.story_time)),
    after: row.after.evidence.map(anchor => endpointContext(anchor, sources, row.after.story_time)),
  })
}

function explanationReviewIssues(row: ManuscriptComparison): ManuscriptComparisonReviewIssue[] {
  return row.interpretation === 'explained_change' && row.explanation_kind !== 'explicit_change'
    ? [{ code: 'explanation_kind_requires_review',
      message: 'explained_change须有实际变化过程引文并明确标记explanation_kind=explicit_change；一般规则、猜测或未分类解释请用possible_change，不能当作本次变化已发生。' }]
    : []
}

/**
 * Identify stored time or explanation claims that must be reviewed before active recovery.
 * @param row - Parsed comparison retained under the compatible storage schema.
 * @param sources - Complete current sources used to verify literal endpoint time labels.
 * @returns Unsupported time labels and explained claims without an explicit-change assessment.
 * @throws Error when a source version, range or quotation no longer matches.
 */
export function comparisonReviewIssues(row: ManuscriptComparison,
  sources: readonly ManuscriptDocument[]): ManuscriptComparisonReviewIssue[] {
  return [...comparisonTimeIssues(row, sources), ...explanationReviewIssues(row)]
}

/**
 * Recompute actual source sections without persisting redundant source text.
 * Unit and condition are model labels. Supplied story_time needs a complete
 * literal occurrence, which does not establish its semantic accuracy. General
 * rules and suggested mechanisms do not establish that this change occurred.
 * Different episodes never by themselves make the observations incomparable.
 * @param row - Validated comparison whose paths identify canonical current sources.
 * @param sources - Complete current adopted source documents.
 * @returns The clean record, literal difference, actual sections and bridge reread ranges.
 * @throws Error when any source anchor belongs to an unavailable or different version.
 */
export function annotateComparison(row: ManuscriptComparison, sources: readonly ManuscriptDocument[]): ManuscriptComparisonResult {
  const contexts = { before: row.before.evidence.map(anchor => endpointContext(anchor, sources, row.before.story_time)),
    after: row.after.evidence.map(anchor => endpointContext(anchor, sources, row.after.story_time)),
    explanation: row.explanation_evidence.map(anchor => endpointContext(anchor, sources)) }
  const timeIssues = endpointTimeIssues(row, contexts)
  if (timeIssues.length > 0) throw Error(`MANUSCRIPT_COMPARISON_TIME: ${timeIssues.map(issue => issue.message).join('\n')}`)
  const citations = (rows: readonly ManuscriptComparisonContext[]): ManuscriptComparisonCitationLabel[] => rows.flatMap(row =>
    manuscriptSourceCitationLabels(row.context).map(label => ({
      source_path: row.source_path, source_sha256: row.source_sha256, ...label })))
  const bridges = new Map<string, ManuscriptSourceEvidence>()
  for (const anchor of comparisonEvidence(row)) {
    const previous = bridges.get(anchor.source_path)
    bridges.set(anchor.source_path, previous
      ? { ...previous, start_line: Math.min(previous.start_line, anchor.start_line),
        end_line: Math.max(previous.end_line, anchor.end_line) }
      : anchor)
  }
  const missing: string[] = []
  const reasons: string[] = []
  if (row.interpretation === 'potential_conflict') {
    for (const [name, endpoint] of [['before', row.before], ['after', row.after]] as const) {
      for (const field of ['unit', 'condition', 'story_time'] as const) {
        if (endpoint[field] === undefined) missing.push(`${name}.${field}`)
      }
    }
  }
  let interpretation = missing.length > 0 ? 'unresolved' as const : row.interpretation
  if (missing.length > 0) reasons.push('missing_comparison_basis')
  if (row.explanation_kind === 'general_rule') reasons.push('general_rule_does_not_establish_occurrence')
  if (row.explanation_kind === 'suggested') reasons.push('suggested_mechanism_does_not_establish_occurrence')
  if (row.interpretation === 'explained_change' && row.explanation_kind !== 'explicit_change') {
    interpretation = 'possible_change'
    if (row.explanation_kind === undefined) reasons.push('explanation_kind_missing')
  }
  return { record: row, literal_difference: row.before.value_text !== row.after.value_text,
    effective_interpretation: interpretation, missing_basis: missing, interpretation_reasons: reasons,
    source_contexts: contexts,
    citation_labels: { before: citations(contexts.before), after: citations(contexts.after), explanation: citations(contexts.explanation) },
    bridge_ranges: [...bridges.values()].map(({ source_path, source_sha256, start_line, end_line }) => ({
      source_path, source_sha256, start_line, end_line })),
    semantic_assessment: 'model_authored', contradiction_proven: false, labels_verified: false, intervening_context_assessed: false,
    notice: '字面值不同不等于矛盾。单位和口径是模型标记；时点的逐字出处也不证明语义。原文有一般规则不等于本次已发生或已到账，general_rule、suggested及未标明kind的解释最多记possible_change；explicit_change仍是模型判断。潜在冲突缺少单位、条件或时点降unresolved。用read_source回读bridge_ranges两端完整场景和中间过程。' }
}

/**
 * Validate source attribution and literal values before annotating a model's comparison.
 * @param raw - Tool JSON with endpoint and optional change-explanation quotations.
 * @param sources - Complete current adopted sources with exact file digests.
 * @param roster - Current source-supported character identities.
 * @param cwd - Workspace used to resolve incoming citation paths.
 * @returns A canonical record for persistence and separately derived source context.
 * @throws Error when source attribution is invalid or an explained change lacks an explicit-change assessment.
 */
export async function validateManuscriptComparison(raw: unknown, sources: readonly ManuscriptDocument[],
  roster: readonly ManuscriptCharacter[], cwd: string): Promise<ManuscriptComparisonResult> {
  const parsed = manuscriptComparisonSchema.parse(raw)
  const explanationIssues = explanationReviewIssues(parsed)
  if (explanationIssues.length > 0) {
    throw Error(`MANUSCRIPT_COMPARISON_EXPLANATION_KIND: ${explanationIssues.map(issue => issue.message).join('\n')}`)
  }
  if (!roster.some(character => character.character_id === parsed.subject_id)) {
    throw Error('MANUSCRIPT_COMPARISON_SUBJECT: 对照主体须是当前已登记角色ID，不能按姓名猜测。')
  }
  const [before, after, explanation] = await Promise.all([
    validateManuscriptEvidence(parsed.before.evidence, sources, cwd),
    validateManuscriptEvidence(parsed.after.evidence, sources, cwd),
    validateManuscriptEvidence(parsed.explanation_evidence, sources, cwd),
  ])
  for (const [name, endpoint, evidence] of [['before', parsed.before, before], ['after', parsed.after, after]] as const) {
    if (!evidence.some(anchor => anchor.quote.includes(endpoint.value_text))) {
      throw Error(`MANUSCRIPT_COMPARISON_VALUE: ${name}.value_text=${JSON.stringify(endpoint.value_text)}须逐字出现在本端实际引文中。`)
    }
  }
  const record = { ...parsed, before: { ...parsed.before, evidence: before },
    after: { ...parsed.after, evidence: after }, explanation_evidence: explanation }
  return annotateComparison(record, sources)
}
