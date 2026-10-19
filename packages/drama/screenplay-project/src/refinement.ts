/** Immutable source-preserving policy, located modification notes, and bounded supplementation. @module screenplay-project/refinement */

import type { z } from 'zod'
import { HUMAN_AUTHORIZATION, MODIFICATION_NOTES } from './schema.ts'
import type { ProjectFile } from './schema.ts'
import { candidateDigest, sha256 } from './episode.ts'
import { factDigest } from './review.ts'

type Candidate = ProjectFile['candidates'][number]
type Fact = ProjectFile['facts'][number]
type Policy = NonNullable<ProjectFile['refinement']>
type Notes = z.infer<typeof MODIFICATION_NOTES>

/** Actual user-message metadata supplied by the Host from visible session history. */
export type HumanAuthorization = z.infer<typeof HUMAN_AUTHORIZATION>

/**
 * Hash the immutable policy without its own digest.
 * @param policy - Host-issued fork policy.
 * @returns Exact policy content digest.
 */
export function refinementPolicyDigest(policy: Omit<Policy, 'sha256'> | Policy): string {
  const { sha256: _digest, ...content } = 'sha256' in policy ? policy : { ...policy, sha256: '' }
  return sha256(JSON.stringify(content))
}

/**
 * Hash candidate content before adding notes and their output binding.
 * @param candidate - Structured episode content.
 * @returns Non-circular content digest.
 */
export function refinementContentDigest(candidate: Candidate): string {
  return sha256(JSON.stringify({ episode: candidate.episode, scenes: candidate.scenes,
    ...(candidate.coverage === undefined ? {} : { coverage: candidate.coverage }),
    ...(candidate.source_ids === undefined ? {} : { source_ids: candidate.source_ids }) }))
}

/**
 * Validate immutable fork inputs without changing historical review context hashes.
 * @param project - Parsed project containing optional policy.
 */
export function validateRefinementPolicy(project: ProjectFile): void {
  const policy = project.refinement
  if (policy === undefined) return
  if (policy.sha256 !== refinementPolicyDigest(policy)) throw Error('refinement_policy_digest: 精修授权或基线已变更。')
  if (new Set(policy.allowed_categories).size !== policy.allowed_categories.length
    || new Set(policy.baselines.map(candidate => candidate.id)).size !== policy.baselines.length
    || JSON.stringify(policy.scope.episodes) !== JSON.stringify(policy.baselines.map(candidate => candidate.episode))) {
    throw Error('refinement_scope: 精修类别及实际候选集号不可重复或脱离基线。')
  }
  for (const baseline of policy.baselines) {
    if (baseline.sha256 !== candidateDigest(baseline)) throw Error('refinement_baseline_digest: 输入候选快照与摘要不符。')
  }
  for (const original of policy.original_facts) {
    const fact = project.facts.find(fact => fact.id === original.id)
    if (fact === undefined || factDigest(fact) !== original.sha256) throw Error('refinement_original_fact: 原事实内容不可覆盖或改写。')
  }
  for (const original of policy.original_sources) {
    const source = project.sources.find(source => source.id === original.id)
    if (source === undefined || sha256(JSON.stringify(source)) !== original.sha256) throw Error('refinement_original_source: 原来源与索引必须保留。')
  }
  if (project.sources.length !== policy.original_sources.length) throw Error('refinement_original_source: 新来源须另行建立项目及范围授权。')
}

/**
 * Validate a supplemental fact's category, origin, grant, and original source context.
 * @param project - Immutable policy and source indexes.
 * @param fact - Existing fact or proposed durable fact fields.
 */
export function validateSupplement(project: ProjectFile, fact: Pick<Fact, 'kind' | 'origin' | 'layer' | 'actor' | 'supplemental'> & { anchors: { unit_id: string; quote: string }[] }): void {
  const supplemental = fact.supplemental
  if (supplemental === undefined) return
  const policy = project.refinement
  if (policy === undefined || fact.origin !== 'adaptation' || supplemental.policy_sha256 !== policy.sha256
    || supplemental.authorization_sha256 !== sha256(JSON.stringify(policy.authorization))
    || !policy.allowed_categories.includes(supplemental.category)) {
    throw Error('refinement_authorization: 补充须为 adaptation，绑定真实用户授权、精修版本及获准类别。')
  }
  const kind = { performance_detail: 'action', minimal_os: 'thought', supporting_dialogue: 'speech' }[supplemental.category]
  if (fact.kind !== kind || fact.layer === 'commentary' || !fact.actor?.trim()) {
    throw Error('refinement_category: 表演细节、最小 OS、承接对白必须分别保留动作、本人心理、本人发声归属。')
  }
  const baselineUnits = new Set(policy.baselines.flatMap(baseline => [...baselineSourceUnits(project, baseline)]))
  if (fact.anchors.length === 0 || fact.anchors.some(anchor => !baselineUnits.has(anchor.unit_id))) {
    throw Error('refinement_supplement_context: 补充须引用实际基线覆盖的原来源上下文，不得伪装成原声或画面事实。')
  }
}

function baselineSourceUnits(project: ProjectFile, baseline: Candidate): Set<string> {
  const ids = new Set(baseline.scenes.flatMap(scene => scene.beats.flatMap(beat => [...beat.fact_ids, ...beat.requires_knowledge])))
  const units = new Set<string>(project.facts.filter(fact => ids.has(fact.id)).flatMap(fact => fact.anchors.map(anchor => anchor.unit_id)))
  for (const window of baseline.coverage?.windows ?? []) {
    const source = project.sources.find(source => source.id === window.source_id)
    for (const unit of source?.units.slice(window.start - 1, window.start - 1 + window.count) ?? []) units.add(unit.id)
  }
  return units
}
function baselineFor(project: ProjectFile, candidate: Candidate): Candidate {
  const baseline = project.refinement?.baselines.find(baseline => baseline.episode === candidate.episode)
  if (baseline === undefined) throw Error('refinement_scope: 候选集号不在用户授权的实际基线范围内。')
  return baseline
}
function located(scenes: Candidate['scenes'], location: Notes['changes'][number]['before']): void {
  if (location === undefined) return
  if (scenes[location.scene - 1]?.beats[location.beat - 1]?.text !== location.text) {
    throw Error('refinement_notes_location: 修改说明原文或改后文本须准确对应实际场次与节拍。')
  }
}
function preserveSourceExpressions(project: ProjectFile, baseline: Candidate, candidate: Candidate): void {
  const sourceIds = new Set(project.facts.filter(fact => fact.origin === 'source').map(fact => fact.id))
  const expressions = (subject: Candidate) => {
    const signatures = new Map<string, Set<string>>(), order: string[] = []
    for (const scene of subject.scenes) for (const beat of scene.beats) for (const id of beat.fact_ids) {
      if (!sourceIds.has(id)) continue
      const signature = JSON.stringify({ kind: beat.kind, actor: beat.actor, audible_in_scene: beat.audible_in_scene === true,
        witnesses: [...beat.witnesses].sort(), requires_knowledge: [...beat.requires_knowledge].sort(), hook: beat.hook === true })
      if (!signatures.has(id)) { signatures.set(id, new Set()); order.push(id) }
      signatures.get(id)?.add(signature)
    }
    return { signatures, order }
  }
  const before = expressions(baseline), after = expressions(candidate)
  if (JSON.stringify(before.order) !== JSON.stringify(after.order)) {
    throw Error('refinement_source_order: 原来源事实须保持唯一首次出现顺序，不得移除事件或提前揭示；重复表达可合并。')
  }
  for (const [id, signatures] of before.signatures) {
    const actual = after.signatures.get(id) as Set<string>
    if (signatures.size !== actual.size || [...signatures].some(value => !actual.has(value))) {
      throw Error('refinement_source_channel: 原来源表达须保留对白、OS/VO、动作、人物、实际听者及知情条件。')
    }
  }
}
function factsFor(project: ProjectFile, candidate: Candidate): Fact[] {
  const ids = new Set(candidate.scenes.flatMap(scene => scene.beats.flatMap(beat => [...beat.fact_ids, ...beat.requires_knowledge])))
  return project.facts.filter(fact => ids.has(fact.id))
}
function derivedNotes(project: ProjectFile, policy: Policy, candidate: Candidate, input: Notes): NonNullable<Candidate['refinement']>['notes'] {
  const baseline = baselineFor(project, candidate)
  const facts = factsFor(project, candidate)
  return { ...input,
    input: { project_id: policy.source_project.id, project_sha256: policy.source_project.sha256,
      candidate_id: baseline.id, candidate_sha256: baseline.sha256, episode: baseline.episode,
      policy_version: policy.version, scope_instructions: policy.scope.instructions },
    output: { candidate_id: candidate.id, content_sha256: refinementContentDigest(candidate), episode: candidate.episode },
    supplements: facts.flatMap(fact => fact.supplemental === undefined ? [] : [{ fact_id: fact.id,
      origin: 'adaptation' as const, category: fact.supplemental.category, policy_sha256: fact.supplemental.policy_sha256,
      authorization_sha256: fact.supplemental.authorization_sha256 }]),
    machine: { rule: 'located-content-and-bindings-v1', scenes: candidate.scenes.map((_, index) => index + 1),
      fact_ids: facts.map(fact => fact.id), source_units: [...new Set(facts.flatMap(fact => fact.anchors.map(anchor => anchor.unit_id)))] },
  }
}

/**
 * Bind a new candidate to its actual immutable baseline and located notes.
 * @param project - Authorized refinement fork.
 * @param candidate - Host-issued candidate identity and content.
 * @param input - Model descriptions with actual before/after locations and limited checks.
 * @returns Full metadata with Host-derived scope and output references.
 */
export function buildRefinement(project: ProjectFile, candidate: Candidate, input: z.input<typeof MODIFICATION_NOTES>): NonNullable<Candidate['refinement']> {
  if (project.refinement === undefined) throw Error('refinement_policy_required: 修改说明仅用于明确精修项目。')
  const baseline = baselineFor(project, candidate)
  const refinement = { policy_sha256: project.refinement.sha256, baseline_candidate_id: baseline.id,
    baseline_sha256: baseline.sha256, output_content_sha256: refinementContentDigest(candidate),
    notes: derivedNotes(project, project.refinement, candidate, MODIFICATION_NOTES.parse(input)) }
  const bound = { ...candidate, refinement }
  bound.sha256 = candidateDigest(bound)
  validateRefinement(project, bound)
  return refinement
}

/**
 * Validate policy, output digests, actual locations, supplement attribution, and bounded check ranges.
 * Machine checks do not establish unchanged story meaning or semantic consent.
 * @param project - Authoritative project with retained original inputs.
 * @param candidate - Exact candidate being read, reviewed, accepted, or delivered.
 */
export function validateRefinement(project: ProjectFile, candidate: Candidate): void {
  validateRefinementPolicy(project)
  const refinement = candidate.refinement
  if (refinement === undefined) {
    if (project.refinement !== undefined && !project.refinement.retained_candidates.some(value => value.id === candidate.id
      && value.sha256 === candidateDigest(candidate))) throw Error('refinement_report_required: 新精修候选须绑定实际基线与修改说明。')
    return
  }
  const policy = project.refinement
  if (policy === undefined) throw Error('refinement_policy_required: 精修候选缺少项目授权。')
  if (candidate.sha256 !== candidateDigest(candidate)) throw Error('refinement_candidate_digest: 精修正文或修改说明与最终版本摘要不符。')
  const baseline = baselineFor(project, candidate)
  if (refinement.policy_sha256 !== policy.sha256 || refinement.baseline_candidate_id !== baseline.id
    || refinement.baseline_sha256 !== baseline.sha256 || refinement.output_content_sha256 !== refinementContentDigest(candidate)) {
    throw Error('refinement_content_digest: 授权、输入版本或最终内容摘要不一致。')
  }
  if (JSON.stringify(candidate.coverage) !== JSON.stringify(baseline.coverage)
    || JSON.stringify(candidate.source_ids) !== JSON.stringify(baseline.source_ids)) {
    throw Error('refinement_source_scope: 精修须保留实际基线的来源编号、采样窗口及必保留表达清单。')
  }
  for (const fact of factsFor(project, candidate)) {
    if (fact.origin === 'adaptation' && fact.supplemental === undefined
      && !policy.original_facts.some(original => original.id === fact.id)) {
      throw Error('refinement_authorization: 新演绎事实必须绑定明确获准的补充策略，不能仅依赖改编模式或审批字段。')
    }
    validateSupplement(project, fact)
    if (fact.supplemental !== undefined && fact.anchors.some(anchor => !baselineSourceUnits(project, baseline).has(anchor.unit_id))) {
      throw Error('refinement_context_scope: 本集补充只能依据本集实际基线与知情前提，不能借未来集来源提前揭示。')
    }
  }
  preserveSourceExpressions(project, baseline, candidate)
  const notes = refinement.notes
  const metadata = (scene: Candidate['scenes'][number]) => { const { beats: _beats, ...content } = scene; return content }
  if (candidate.scenes.length !== baseline.scenes.length || candidate.scenes.some((scene, index) =>
    JSON.stringify(metadata(scene)) !== JSON.stringify(metadata(baseline.scenes[index] as Candidate['scenes'][number])))) {
    throw Error('refinement_scene_metadata: 此保源版本仅精修节拍表达；场次时间、地点、人物及叙述结构变更需要单独授权流程。')
  }
  for (const change of notes.changes) {
    if (change.before === undefined && change.after === undefined) throw Error('refinement_notes_empty: 每条修改须有实际原文或改后位置。')
    located(baseline.scenes, change.before); located(candidate.scenes, change.after)
    if (JSON.stringify(change.before) === JSON.stringify(change.after) && change.before !== undefined
      && JSON.stringify(baseline.scenes[change.before.scene - 1]?.beats[change.before.beat - 1])
        === JSON.stringify(candidate.scenes[change.before.scene - 1]?.beats[change.before.beat - 1])) {
      throw Error('refinement_notes_empty: 不可将无变化文本报告为修改。')
    }
  }
  for (const [sceneIndex, scene] of candidate.scenes.entries()) for (const [beatIndex, beat] of scene.beats.entries()) {
    const old = baseline.scenes[sceneIndex]?.beats[beatIndex]
    if (JSON.stringify(old) !== JSON.stringify(beat) && !notes.changes.some(change => change.after?.scene === sceneIndex + 1
      && change.after.beat === beatIndex + 1)) throw Error('refinement_notes_unhandled: 实际变更节拍须逐项列入修改说明。')
    for (const id of beat.fact_ids) {
      const fact = project.facts.find(fact => fact.id === id)
      if (fact?.supplemental === undefined) continue
      const expected = { performance_detail: 'action', minimal_os: 'os', supporting_dialogue: 'dialogue' }[fact.supplemental.category]
      if (beat.kind !== expected || beat.actor !== fact.actor || scene.layer !== fact.layer) {
        throw Error('refinement_category: 补充表达渠道、人物及叙述层须与获准类别一致。')
      }
    }
  }
  for (const [sceneIndex, scene] of baseline.scenes.entries()) for (const [beatIndex, beat] of scene.beats.entries()) {
    if (JSON.stringify(candidate.scenes[sceneIndex]?.beats[beatIndex]) !== JSON.stringify(beat)
      && !notes.changes.some(change => change.before?.scene === sceneIndex + 1 && change.before.beat === beatIndex + 1)) {
      throw Error('refinement_notes_unhandled: 删除、替换或换序节拍须保留准确的原文位置。')
    }
  }
  for (const comment of notes.editor_comments) {
    if (comment.change_indices.some(index => index > notes.changes.length)
      || (['adopted', 'partial'].includes(comment.disposition) && comment.change_indices.length === 0)) {
      throw Error('refinement_comment_location: 采纳或部分采纳须对应实际修改条目。')
    }
  }
  const { semantic, visual } = notes.validation
  const checkedUnits = new Set([...factsFor(project, candidate), ...factsFor(project, baseline)]
    .flatMap(fact => fact.anchors.map(anchor => anchor.unit_id)))
  for (const bound of [baseline, candidate]) for (const window of bound.coverage?.windows ?? []) {
    const source = project.sources.find(source => source.id === window.source_id)
    for (const unit of source?.units.slice(window.start - 1, window.start - 1 + window.count) ?? []) checkedUnits.add(unit.id)
  }
  const sourceUnits = new Set(project.sources.flatMap(source => source.units
    .filter(unit => unit.image !== undefined && checkedUnits.has(unit.id)).map(unit => unit.id)))
  if (semantic.scenes.some(index => index > candidate.scenes.length)
    || (semantic.status === 'not_run') !== (semantic.scenes.length === 0)
    || visual.source_units.some(id => !sourceUnits.has(id))
    || (visual.status === 'not_run') !== (visual.source_units.length === 0)) {
    throw Error('refinement_validation_range: 语义及视觉声明须列实际有限范围，未检查必须留空。')
  }
  if (JSON.stringify(notes) !== JSON.stringify(derivedNotes(project, policy, candidate, MODIFICATION_NOTES.strip().parse(notes)))) {
    throw Error('refinement_report_digest: 修改说明的输入、输出、补充或机器检查引用已过期。')
  }
}

/**
 * Decide whether an adaptation fact has a valid explicit candidate-bound bounded grant.
 * @param project - Immutable policy and actual facts.
 * @param candidate - Explicit refinement output.
 * @param fact - Fact otherwise rejected by managed-video source checks.
 * @returns True only for a valid supplemental fact, never for adaptation mode or reason alone.
 */
export function isAuthorizedSupplement(project: ProjectFile, candidate: Candidate, fact: Fact): boolean {
  if (candidate.refinement === undefined || fact.supplemental === undefined) return false
  validateRefinement(project, candidate)
  validateSupplement(project, fact)
  return true
}

/**
 * Render the fixed delivery explanation from actual final metadata and review evidence.
 * @param project - Authoritative project.
 * @param candidate - Final accepted or drafted candidate.
 * @returns Separate Chinese modification notes with one trailing newline, or an empty string for historical candidates.
 */
export function renderModificationNotes(project: ProjectFile, candidate: Candidate): string {
  if (candidate.refinement === undefined) return ''
  validateRefinement(project, candidate)
  const notes = candidate.refinement.notes
  const policy = project.refinement as Policy
  const location = (value: Notes['changes'][number]['before']) => value === undefined ? '无（新增或删除）' : `场${value.scene}/节拍${value.beat}：${value.text}`
  const label = (change: Notes['changes'][number]) => {
    const beat = change.after === undefined ? undefined : candidate.scenes[change.after.scene - 1]?.beats[change.after.beat - 1]
    const supplemental = beat?.fact_ids.flatMap((id) => {
      const fact = project.facts.find(fact => fact.id === id)
      return fact?.supplemental === undefined ? [] : [`${id}/${fact.supplemental.category}`]
    }) ?? []
    if (supplemental.length > 0) return `补充演绎（${supplemental.join('、')}）`
    if (beat?.sync_with !== undefined) return '展示调整（保留来源动作及发声渠道）'
    return '保留来源的表达调整'
  }
  const rows = ['《修改说明》', `策略：${notes.input.policy_version}；范围：第${notes.input.episode}集；${notes.input.scope_instructions}`,
    `输入：${notes.input.project_id} / ${notes.input.project_sha256}；${notes.input.candidate_id} / ${notes.input.candidate_sha256}`,
    `输出：${candidate.id} / ${candidate.sha256}；正文摘要：${notes.output.content_sha256}`,
    ...notes.changes.map((change, index) => `${index + 1}. ${label(change)}：${location(change.before)} → ${location(change.after)}；理由：${change.reason}`),
    '编辑意见：', ...notes.editor_comments.map(comment => `${comment.disposition}：${comment.comment}；修改条目 ${comment.change_indices.join('、') || '无'}；${comment.reason}`),
    ...(notes.editor_comments.length === 0 ? ['无提供的编辑意见；采纳情况未知。'] : []),
    '补充来源：', ...notes.supplements.map(value => `${value.fact_id}：${value.origin} / ${value.category}；策略 ${value.policy_sha256}；授权 ${value.authorization_sha256}`),
    ...(notes.supplements.length === 0 ? ['无新增演绎事实。'] : []),
    `用户授权证据：${policy.authorization.session_id} / ${policy.authorization.message_id} / seq ${policy.authorization.seq}；原话：${policy.authorization.quote}`,
    '原话匹配仅核对真实用户文本；授权语义及剧情保持仍须审查。',
    `未解决：${notes.unresolved.join('；') || '未列出；不等同于全局通过。'}`,
    `未处理：${notes.unhandled.join('；') || '未列出；不等同于全局通过。'}`,
    `机器检查：${notes.machine.rule}；场 ${notes.machine.scenes.join('、')}；事实 ${notes.machine.fact_ids.join('、')}；来源 ${notes.machine.source_units.join('、')}。仅检查位置、摘要、类别、引用、场次结构和来源渠道与顺序。`,
    `语义检查：${notes.validation.semantic.status}；场 ${notes.validation.semantic.scenes.join('、') || '无'}；${notes.validation.semantic.reason}`,
    `视觉检查：${notes.validation.visual.status}；来源 ${notes.validation.visual.source_units.join('、') || '无'}；${notes.validation.visual.reason}`,
    candidate.review === undefined ? '版本审查：尚未进行。' : `版本审查：${candidate.review.kind ?? 'independent'} / ${candidate.review.decision}；${candidate.review.reason}；${candidate.review.evidence === undefined ? (candidate.review.kind === 'advisory' ? 'Agent自主审校记录' : '独立会话记录') : `真实检查步骤 ${candidate.review.evidence.creation_step} → ${candidate.review.evidence.reads.map(read => read.step).join('、')} → ${candidate.review.evidence.review_step}`}`]
  return `${rows.join('\n')}\n`
}
