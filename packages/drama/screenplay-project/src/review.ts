/** Sequential self-check evidence and historical independent-review validation. @module screenplay-project/review */

import type { SessionSeq } from '@deepseek-ai/dsh-session'
import type { ProjectFile } from './schema.ts'
import { inventoryReads, validateStoryCandidate } from './story.ts'
import { sha256, candidateDigest } from './episode.ts'

type Fact = ProjectFile['facts'][number]
type Candidate = ProjectFile['candidates'][number]
/** Exact content observed by one successful model-visible project read. */
export interface ReviewRead {
  kind: 'source' | 'fact' | 'candidate' | 'policy' | 'inventory'
  id: string
  sha256: string
}
/** Host-issued read receipt; only successfully delivered model context can supply it. */
export interface ProjectReadReceipt {
  project_id: ProjectFile['id']
  project_sha256: string
  revision: number
  actor: Fact['proposer']
  step: SessionSeq
  reads: ReviewRead[]
}

/**
 * Hash immutable fact fields without its subsequent review or withdrawal.
 * @param fact - Application-issued fact.
 * @returns Exact immutable-fact digest.
 */
export function factDigest(fact: Fact): string {
  const { review: _review, withdrawal: _withdrawal, ...content } = fact
  return sha256(JSON.stringify(content))
}

/**
 * Bind a source unit to its verified original bytes and attachment metadata.
 * @param source - Imported immutable source.
 * @param unit - One returned original unit.
 * @returns Source read identity and digest.
 */
export function sourceRead(source: ProjectFile['sources'][number], unit: ProjectFile['sources'][number]['units'][number]): ReviewRead {
  return { kind: 'source', id: unit.id, sha256: sha256(JSON.stringify({ source_id: source.id, source_sha256: source.sha256, unit })) }
}

/**
 * Select every fact supporting content, character knowledge, or visual coverage.
 * @param project - Authoritative project.
 * @param candidate - Exact episode candidate.
 * @returns Referenced facts in project order.
 */
export function candidateFacts(project: ProjectFile, candidate: Candidate): Fact[] {
  const ids = new Set(candidate.scenes.flatMap(scene => scene.beats.flatMap(beat => [...beat.fact_ids, ...beat.requires_knowledge])))
  const baseline = candidate.refinement === undefined ? undefined
    : project.refinement?.baselines.find(value => value.id === candidate.refinement?.baseline_candidate_id)
  for (const scene of baseline?.scenes ?? []) for (const beat of scene.beats) {
    for (const id of [...beat.fact_ids, ...beat.requires_knowledge]) ids.add(id)
  }
  const inventory = project.story_inventories?.find(value => value.id === candidate.story_adaptation?.inventory_id)
  for (const item of inventory?.items ?? []) for (const id of [...item.fact_ids, ...item.knowledge.map(value => value.fact_id)]) ids.add(id)
  for (const entry of [...(candidate.coverage?.required_beats ?? []), ...(baseline?.coverage?.required_beats ?? [])]) ids.add(entry.fact_id)
  return project.facts.filter(fact => ids.has(fact.id))
}

/**
 * Select exact source, fact, and candidate contents required for self-check.
 * @param project - Verified source indexes and direction.
 * @param subject - Proposed fact or drafted candidate.
 * @param kind - Subject type.
 * @returns Unique content bindings, sorted by type and identity.
 */
export function requiredReads(project: ProjectFile, subject: Fact | Candidate, kind: 'fact' | 'candidate'): ReviewRead[] {
  const facts = kind === 'fact' ? [subject as Fact] : candidateFacts(project, subject as Candidate)
  const reads: ReviewRead[] = facts.map(fact => ({ kind: 'fact', id: fact.id, sha256: factDigest(fact) }))
  const units = new Set(facts.flatMap(fact => fact.anchors.map(anchor => anchor.unit_id)))
  if (kind === 'candidate') {
    const candidate = subject as Candidate
    const inventory = project.story_inventories?.find(value => value.id === candidate.story_adaptation?.inventory_id)
    if (inventory !== undefined) reads.push(...inventoryReads(project, inventory))
    reads.push({ kind: 'candidate', id: candidate.id, sha256: candidate.sha256 })
    if (candidate.refinement !== undefined) {
      const baseline = project.refinement?.baselines.find(value => value.id === candidate.refinement?.baseline_candidate_id)
      if (baseline !== undefined) reads.push({ kind: 'candidate', id: baseline.id, sha256: baseline.sha256 })
    }
    const baseline = candidate.refinement === undefined ? undefined
      : project.refinement?.baselines.find(value => value.id === candidate.refinement?.baseline_candidate_id)
    for (const window of [...(candidate.coverage?.windows ?? []), ...(baseline?.coverage?.windows ?? [])]) {
      const source = project.sources.find(source => source.id === window.source_id)
      for (const unit of source?.units.slice(window.start - 1, window.start - 1 + window.count) ?? []) units.add(unit.id)
    }
  }
  for (const source of project.sources) for (const unit of source.units) if (units.has(unit.id)) reads.push(sourceRead(source, unit))
  return [...new Map(reads.map(read => [`${read.kind}:${read.id}`, read])).values()].sort((a, b) => `${a.kind}:${a.id}`.localeCompare(`${b.kind}:${b.id}`))
}

function contextDigest(project: ProjectFile, subject?: Fact | Candidate): string {
  if (project.story_policy !== undefined) {
    const inherited = subject !== undefined && ('scenes' in subject
      ? project.story_policy.retained_candidates?.some(value => value.id === subject.id && value.sha256 === subject.sha256)
      : project.story_policy.original_facts?.some(value => value.id === subject.id && value.sha256 === factDigest(subject)))
    if (inherited && project.story_policy.legacy_context_sha256 !== undefined) return project.story_policy.legacy_context_sha256
    const candidate = subject !== undefined && 'scenes' in subject ? subject : undefined
    return sha256(JSON.stringify({ protocol: 'story-faithful-self-check-v2', mode: project.mode, instructions: project.instructions,
      workflow: project.workflow, review_mode: project.review_mode, policy_sha256: project.story_policy.sha256,
      ...(candidate?.story_adaptation === undefined ? {} : { inventory_sha256: candidate.story_adaptation.inventory_sha256,
        scope_sha256: candidate.story_adaptation.scope_sha256 }) }))
  }
  return sha256(JSON.stringify({ mode: project.mode, instructions: project.instructions,
    ...(project.workflow === undefined ? {} : { workflow: project.workflow }),
    ...(project.review_mode === undefined ? {} : { review_mode: project.review_mode }) }))
}

/**
 * Validate review actor, step ordering, and exact immutable evidence on every replay path.
 * Omitted kind retains historical independent-review semantics.
 * @param project - Parsed project, including its explicit review mode.
 * @param subject - Fact or candidate carrying the review.
 * @param kind - Subject type.
 * @returns Whether a present review is valid; absence returns false.
 */
export function validReview(project: ProjectFile, subject: Fact | Candidate, kind: 'fact' | 'candidate'): boolean {
  const review = subject.review
  if (kind === 'candidate' && project.story_policy !== undefined) {
    try { validateStoryCandidate(project, subject as Candidate) } catch (error) {
      if (!(error instanceof Error)) throw error
      return false
    }
  }
  if (review === undefined) return false
  const author = kind === 'fact' ? (subject as Fact).proposer : (subject as Candidate).author
  if (review.kind !== 'self-check') return review.actor !== author && review.evidence === undefined
  return project.review_mode === 'self-check' && review.actor === author
    && (kind === 'fact' || (subject as Candidate).sha256 === candidateDigest(subject as Candidate))
    && validSelfCheck(project, subject, kind, review.evidence, subject.created_step)
}

function validSelfCheck(project: ProjectFile, subject: Fact | Candidate, kind: 'fact' | 'candidate',
  evidence: NonNullable<Fact['review']>['evidence'], creationStep: SessionSeq | undefined): boolean {
  if (evidence === undefined || creationStep === undefined || evidence.creation_step !== creationStep
    || evidence.context_sha256 !== contextDigest(project, subject)
    || evidence.subject_sha256 !== (kind === 'fact' ? factDigest(subject as Fact) : (subject as Candidate).sha256)) return false
  const expected = requiredReads(project, subject, kind)
  return expected.length === evidence.reads.length && expected.every((read, index) => {
    const actual = evidence.reads[index]
    return actual !== undefined && actual.kind === read.kind && actual.id === read.id && actual.sha256 === read.sha256
      && evidence.creation_step < actual.step && actual.step < evidence.review_step
  })
}

/**
 * Validate a retained fact withdrawal without relabeling historical independent approval.
 * @param project - Project carrying the fact's original approval.
 * @param fact - Approved fact with optional subsequent withdrawal.
 * @returns Whether a present withdrawal has valid review identity and sequential evidence.
 */
export function validWithdrawal(project: ProjectFile, fact: Fact): boolean {
  const withdrawal = fact.withdrawal
  if (withdrawal === undefined || fact.review?.decision !== 'approve' || !validReview(project, fact, 'fact')) return false
  if (withdrawal.kind !== 'self-check') return withdrawal.actor !== fact.proposer && withdrawal.evidence === undefined
  return project.review_mode === 'self-check' && fact.review.kind === 'self-check' && withdrawal.actor === fact.proposer
    && validSelfCheck(project, fact, 'fact', withdrawal.evidence, fact.review.evidence?.review_step)
}

/**
 * Construct review evidence from current-version reads delivered during earlier model steps.
 * @param project - Current verified project.
 * @param projectHash - Exact bytes loaded for the review mutation.
 * @param subject - Fact or candidate authored by this actor.
 * @param kind - Subject type.
 * @param actor - Initiating session identity.
 * @param step - Live host model-step sequence.
 * @param receipts - Successful exact-content reads present in model history; previously observed images may be offloaded.
 * @param afterStep - Original approval step when withdrawing an already approved fact.
 * @returns Durable exact-content and sequential-step evidence.
 */
export function selfCheckEvidence(project: ProjectFile, projectHash: string, subject: Fact | Candidate, kind: 'fact' | 'candidate',
  actor: Fact['proposer'], step: SessionSeq | undefined, receipts: readonly ProjectReadReceipt[], afterStep?: SessionSeq): NonNullable<NonNullable<Fact['review']>['evidence']> {
  const author = kind === 'fact' ? (subject as Fact).proposer : (subject as Candidate).author
  if (author !== actor) throw Error('self_check_actor: 自检须由原编写会话分轮完成，不能冒充独立审校。')
  const creationStep = afterStep ?? subject.created_step
  if (step === undefined || creationStep === undefined || step <= creationStep) {
    throw Error('self_check_step: 先结束编写轮，在后续模型轮重新读取来源和版本，再由下一模型轮自检。')
  }
  const available = receipts.filter(receipt => receipt.project_id === project.id && receipt.project_sha256 === projectHash
    && receipt.revision === project.revision && receipt.actor === actor && creationStep < receipt.step && receipt.step < step)
  const reads = requiredReads(project, subject, kind).map((read) => {
    const receipt = available.find(receipt => receipt.reads.some(value => value.kind === read.kind
      && value.id === read.id && value.sha256 === read.sha256))
    if (receipt === undefined) throw Error(`self_check_read_required: ${read.kind} ${read.id} 须在编写后的模型轮实际读回当前内容，待下一模型轮自检；内容变更后须重读。图像分小批读回，须真正进入成功模型轮，不能把请求前卸载的图像当已看。`)
    return { ...read, step: receipt.step }
  })
  return { project_id: project.id, project_revision: project.revision, context_sha256: contextDigest(project, subject),
    subject_sha256: kind === 'fact' ? factDigest(subject as Fact) : (subject as Candidate).sha256,
    creation_step: creationStep, review_step: step, reads }
}
