/** Story-faithful policy, episode inventories and located semantic judgments. @module screenplay-project/story */
import { z } from 'zod'
import type { Context } from '@deepseek-ai/cordis'
import { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-query'
import { CANDIDATE_RECORD, SEMANTIC_INPUT, STORY_NOTES } from './schema.ts'
import type { ProjectFile } from './schema.ts'
import type { SessionSeq } from '@deepseek-ai/dsh-session'
import type { ActorId } from './ids.ts'
import { candidateDigest, sha256 } from './episode.ts'
import { factDigest, sourceRead, validReview, validWithdrawal } from './review.ts'
import type { ProjectReadReceipt, ReviewRead } from './review.ts'

type Candidate = ProjectFile['candidates'][number]
type Fact = ProjectFile['facts'][number]
/** Exact proposed or reviewed episode inventory. */
export type StoryInventory = NonNullable<ProjectFile['story_inventories']>[number]
type Policy = NonNullable<ProjectFile['story_policy']>
type Location = z.infer<typeof STORY_NOTES>['mapping'][number]['outputs'][number]

/**
 * Hash an immutable scoped work grant.
 * @param policy - Host-stamped current work policy.
 * @returns Digest excluding its own digest.
 */
export function storyPolicyDigest(policy: Policy): string {
  const { sha256: _hash, ...content } = policy
  return sha256(JSON.stringify(content))
}
/**
 * Hash inventory content independently of later review or invalidation.
 * @param inventory - Application-issued story items.
 * @returns Immutable inventory digest.
 */
export function inventoryDigest(inventory: StoryInventory): string {
  const { sha256: _hash, review: _review, superseded_at_revision: _superseded, ...content } = inventory
  return sha256(JSON.stringify(content))
}
/**
 * Bind only this episode's policy, sources and facts; later episodes cannot invalidate accepted prefixes.
 * @param project - Immutable imported indexes and facts.
 * @param inventory - Exact declared episode scope.
 * @returns Episode-specific content digest.
 */
export function storyScopeDigest(project: ProjectFile, inventory: Pick<StoryInventory, 'episode' | 'coverage' | 'items'>): string {
  const ids = new Set(inventory.items.flatMap(item => [...item.fact_ids, ...item.knowledge.map(value => value.fact_id)]))
  return sha256(JSON.stringify({ policy: project.story_policy?.sha256, episode: inventory.episode, coverage: inventory.coverage,
    sources: inventory.coverage.windows.map((window) => {
      const source = project.sources.find(value => value.id === window.source_id)
      return { id: source?.id, sha256: source?.sha256, video: source?.video, story_video_path: source?.story_video_path,
        units: source?.units.slice(window.start - 1, window.start - 1 + window.count) }
    }), facts: project.facts.filter(fact => ids.has(fact.id)).map(fact => ({ id: fact.id, sha256: factDigest(fact) })) }))
}
/**
 * Validate policy isolation, video identities and original ownership without changing V1 rules.
 * @param project - Parsed artifact.
 */
export function validateStoryPolicy(project: ProjectFile): void {
  const policy = project.story_policy
  if (policy === undefined) {
    if (project.story_inventories?.length) throw Error('story_policy_required: 故事创作记录缺少实际作品授权。')
    return
  }
  if (project.refinement !== undefined || project.workflow !== 'video_to_screenplay' || project.review_mode !== 'self-check'
    || policy.sha256 !== storyPolicyDigest(policy)) throw Error('story_policy_digest: 故事策略须独立绑定当前作品、自检及真实用户授权。')
  if (new Set(policy.scope.episodes).size !== policy.scope.episodes.length
    || new Set(policy.videos.map(video => video.path)).size !== policy.videos.length
    || policy.videos.some(video => !policy.scope.episodes.includes(video.episode))
    || new Set(policy.allowed_categories).size !== policy.allowed_categories.length) throw Error('story_policy_scope: 作品、集号与类别不能重复。')
  for (const original of policy.original_facts ?? []) {
    const fact = project.facts.find(value => value.id === original.id)
    if (fact === undefined || factDigest(fact) !== original.sha256) throw Error('story_original_fact: 原事实不可覆盖或重标为演绎。')
  }
  for (const original of policy.original_sources ?? []) {
    const source = project.sources.find(value => value.id === original.id)
    if (source === undefined || source.sha256 !== original.sha256 || sha256(JSON.stringify({ units: source.units, video: source.video })) !== original.index_sha256) throw Error('story_original_source: 原来源、原ASR与观察索引不可更改。')
  }
  for (const input of policy.input_candidates ?? []) {
    const candidate = CANDIDATE_RECORD.parse(JSON.parse(input))
    if (candidate.sha256 !== candidateDigest(candidate)) throw Error('story_input_digest: 原输入候选摘要不一致。')
  }
  for (const source of project.sources) {
    const videoPath = source.story_video_path ?? source.video?.path
    const video = policy.videos.find(video => video.path === videoPath)
    if (video === undefined || (source.video !== undefined && source.video.source_version !== video.source_version)) {
      throw Error('story_source_scope: 新来源须属于实际获授权的原作品版本。')
    }
  }
}
/**
 * Validate every inventory reference, source window and declared evidence status.
 * @param project - Authoritative artifact.
 * @param inventory - Proposed or reviewed episode scope.
 * @param purpose - Active use, or loading unused superseded inventory history.
 */
export function validateInventory(project: ProjectFile, inventory: StoryInventory, purpose: 'active' | 'history' = 'active'): void {
  validateStoryPolicy(project)
  const historical = purpose === 'history' && inventory.superseded_at_revision !== undefined
    && inventory.superseded_at_revision <= project.revision
    && !project.candidates.some(candidate => candidate.story_adaptation?.inventory_id === inventory.id)
  if (project.story_policy === undefined || inventory.policy_sha256 !== project.story_policy.sha256
    || !project.story_policy.scope.episodes.includes(inventory.episode)
    || inventory.sha256 !== inventoryDigest(inventory) || inventory.scope_sha256 !== storyScopeDigest(project, inventory)) {
    throw Error('story_inventory_digest: 故事清单、策略或本集来源版本不一致。')
  }
  const units = new Set<string>()
  for (const window of inventory.coverage.windows) {
    const source = project.sources.find(value => value.id === window.source_id)
    if (source === undefined || window.start + window.count - 1 > source.units.length
      || !project.story_policy.videos.some(video => video.episode === inventory.episode && video.path === (source.story_video_path ?? source.video?.path))) throw Error('story_source_window: 清单须绑定实际完整来源窗口。')
    for (const unit of source.units.slice(window.start - 1, window.start - 1 + window.count)) units.add(unit.id)
  }
  if (new Set(inventory.items.map(item => item.id)).size !== inventory.items.length) throw Error('story_item_duplicate: 故事项编号不能重复。')
  const dimensions = ['event', 'action_result', 'emotion_conflict', 'relationship_stance', 'causality_reveal'] as const
  if (new Set(inventory.not_applicable.map(value => value.dimension)).size !== inventory.not_applicable.length
    || dimensions.some(dimension => inventory.items.some(item => item.dimension === dimension) === inventory.not_applicable
      .some(value => value.dimension === dimension))) {
    throw Error('story_dimensions_required: 五维故事项须完整列出，确实不适用须明确理由，不可用单一非关键项替代复原清单。')
  }
  const itemIds = new Set(inventory.items.map(item => item.id))
  for (const item of inventory.items) {
    if (item.source_units.some(id => !units.has(id)) || item.depends_on.some(id => !itemIds.has(id) || id === item.id)) {
      throw Error('story_item_scope: 故事项来源或因果依赖须在当前集清单中。')
    }
    for (const id of [...item.fact_ids, ...item.knowledge.map(value => value.fact_id)]) {
      const fact = project.facts.find(value => value.id === id)
      if (fact === undefined || fact.origin !== 'source' || fact.review?.decision !== 'approve'
        || (fact.withdrawal !== undefined && !(historical && validWithdrawal(project, fact)))
        || !validReview(project, fact, 'fact') || !fact.anchors.some(anchor => units.has(anchor.unit_id))) {
        throw Error('story_fact_review: 清单须引用本集已真实审校的来源事实，不能以演绎充当来源。')
      }
    }
    for (const unit of item.source_units) if (!item.fact_ids.some(id => project.facts.find(fact => fact.id === id)?.anchors
      .some(anchor => anchor.unit_id === unit))) {
      throw Error('story_item_evidence: 每个来源定位须对应本项已审校事实。')
    }
  }
  const visiting = new Set<string>(), visited = new Set<string>()
  const visit = (id: string): void => {
    if (visiting.has(id)) throw Error('story_causal_cycle: 同一事件链的因果依赖不能成环。')
    if (visited.has(id)) return
    visiting.add(id)
    for (const dependency of inventory.items.find(item => item.id === id)?.depends_on ?? []) visit(dependency)
    visiting.delete(id); visited.add(id)
  }
  for (const id of itemIds) visit(id)
}
/**
 * Describe remaining sampled-window evidence without claiming continuous visual coverage.
 * @param project - Imported actual frame manifests and Host-issued inspection receipts.
 * @param inventory - This episode's complete declared source range.
 * @returns Recoverable missing evidence descriptions.
 */
export function storyEvidencePending(project: ProjectFile, inventory: StoryInventory): string[] {
  const pending: string[] = []
  const windows = inventory.coverage.windows.flatMap((window) => {
    const source = project.sources.find(value => value.id === window.source_id)
    return source?.video === undefined ? [] : [{ source, window }]
  })
  if (windows.length === 0) return ['本集没有实际视频图像证据']
  for (const video of project.story_policy?.videos.filter(video => video.episode === inventory.episode) ?? []) {
    if (!windows.some(value => (value.source.story_video_path ?? value.source.video?.path) === video.path)) pending.push(`${video.path} 本集原视频尚未实际probe/抽帧覆盖`)
  }
  if (!project.story_policy?.videos.some(video => video.episode === inventory.episode)) pending.push('本集没有明确关联的获授权原视频；须绑定集号，不能从其他集借证据')
  for (const { source } of windows) {
    const receipt = source.trusted_video_receipt
    if (receipt === undefined || receipt.video_path !== source.video?.path || receipt.source_version !== source.video.source_version
      || receipt.duration_seconds !== source.video.duration_seconds || receipt.manifest_sha256 !== source.sha256) {
      pending.push(`${source.id} 缺少本原件实际probe与抽帧日志证明`); continue
    }
    const range = { start_seconds: 0, end_seconds: receipt.duration_seconds }
    // Coverage intervals select returned units, never grant permission to omit the rest of this original video.
    for (const plan of receipt.plan) {
      const start = Math.max(plan.start_seconds, range.start_seconds), end = Math.min(plan.end_seconds, range.end_seconds)
      if (end <= start) continue
      const sampled = windows.some(other => (other.source.story_video_path ?? other.source.video?.path)
        === (source.story_video_path ?? source.video?.path)
        && other.source.video?.source_version === receipt.source_version
        && other.source.units.slice(other.window.start - 1, other.window.start - 1 + other.window.count)
          .some(unit => unit.image !== undefined && unit.start !== undefined && unit.start >= start && unit.start < end))
      if (!sampled) pending.push(`${receipt.video_path} ${start}–${end}s 计划窗口尚无实际图片`)
    }
    for (const unresolved of receipt.unresolved) if (unresolved.critical && unresolved.time >= range.start_seconds && unresolved.time < range.end_seconds) pending.push(`${unresolved.time}s 关键证据未解决：${unresolved.reason}`)
  }
  return [...new Set(pending)]
}

/**
 * Collect actual reads for the inventory and its scoped sources.
 * @param project - Authoritative policy, sources and facts.
 * @param inventory - Exact episode inventory.
 * @returns Unique sorted read bindings.
 */
export function inventoryReads(project: ProjectFile, inventory: StoryInventory): ReviewRead[] {
  const ids = new Set(inventory.items.flatMap(item => [...item.fact_ids, ...item.knowledge.map(value => value.fact_id)]))
  const reads: ReviewRead[] = [{ kind: 'policy', id: project.id, sha256: project.story_policy?.sha256 ?? '' },
    { kind: 'inventory', id: inventory.id, sha256: inventory.sha256 },
    ...project.facts.filter(fact => ids.has(fact.id)).map(fact => ({ kind: 'fact' as const, id: fact.id, sha256: factDigest(fact) }))]
  for (const window of inventory.coverage.windows) {
    const source = project.sources.find(value => value.id === window.source_id)
    if (source !== undefined) for (const unit of source.units.slice(window.start - 1,
      window.start - 1 + window.count)) reads.push(sourceRead(source, unit))
  }
  return [...new Map(reads.map(read => [`${read.kind}:${read.id}`, read])).values()]
    .sort((a, b) => `${a.kind}:${a.id}`.localeCompare(`${b.kind}:${b.id}`))
}
/**
 * Issue inventory review evidence only from current, earlier successful model-visible reads.
 * @param project - Exact loaded artifact.
 * @param projectHash - Current file bytes.
 * @param inventory - Proposed scope.
 * @param actor - Real initiating session.
 * @param step - Actual live model step.
 * @param receipts - Contexts successfully retained in current model history.
 * @returns Durable A/B/C evidence.
 */
export function inventoryEvidence(project: ProjectFile, projectHash: string, inventory: StoryInventory, actor: ActorId,
  step: SessionSeq | undefined, receipts: readonly ProjectReadReceipt[]): NonNullable<StoryInventory['review']>['evidence'] {
  if (actor !== inventory.author) throw Error('self_check_actor: 故事清单须由原会话分轮自检。')
  if (step === undefined || step <= inventory.created_step) throw Error('self_check_step: 清单提交后须后续模型轮实际读回，再于下一模型轮判断。')
  const available = receipts.filter(receipt => receipt.actor === actor && receipt.project_id === project.id
    && receipt.project_sha256 === projectHash && receipt.revision === project.revision
    && inventory.created_step < receipt.step && receipt.step < step)
  const reads = inventoryReads(project, inventory).map((read) => {
    const receipt = available.find(receipt => receipt.reads.some(value => JSON.stringify(value) === JSON.stringify(read)))
    if (receipt === undefined) throw Error(`self_check_read_required: ${read.kind} ${read.id} 须在清单提交后的模型轮实际读回。`)
    return { ...read, step: receipt.step }
  })
  return { project_id: project.id, project_revision: project.revision, context_sha256: inventory.scope_sha256,
    subject_sha256: inventory.sha256, creation_step: inventory.created_step, review_step: step, reads }
}
/**
 * Verify persisted inventory review without relying on a model's completion claim.
 * @param project - Current immutable content.
 * @param inventory - Saved inventory.
 * @returns Whether its self-check review has exact ordered read evidence.
 */
export function validInventoryReview(project: ProjectFile, inventory: StoryInventory): boolean {
  const review = inventory.review, evidence = review?.evidence
  const expected = inventoryReads(project, inventory)
  return review?.kind === 'self-check' && review.actor === inventory.author && evidence !== undefined
    && evidence.creation_step === inventory.created_step && evidence.context_sha256 === inventory.scope_sha256
    && evidence.subject_sha256 === inventory.sha256 && evidence.reads.length === expected.length
    && expected.every((read, index) => {
      const actual = evidence.reads[index]
      return actual !== undefined && actual.kind === read.kind && actual.id === read.id && actual.sha256 === read.sha256
        && inventory.created_step < actual.step && actual.step < evidence.review_step
    })
}
function inventoryFor(project: ProjectFile, candidate: Candidate): StoryInventory {
  const inventory = project.story_inventories?.find(value => value.id === candidate.story_adaptation?.inventory_id)
  if (inventory === undefined) throw Error('story_inventory_required: 候选须绑定本集实际故事清单。')
  return inventory
}
const INPUT_SNAPSHOT = CANDIDATE_RECORD.pick({ id: true, sha256: true, episode: true, scenes: true, coverage: true,
  source_ids: true }).extend({ content_sha256: z.string().regex(/^[a-f0-9]{64}$/) })
function inputSnapshot(candidate: Candidate) {
  return INPUT_SNAPSHOT.strip().parse({ ...candidate, content_sha256: storyContentDigest(candidate) })
}
function located(candidate: Pick<Candidate, 'scenes'>, location: Location): Candidate['scenes'][number]['beats'][number] {
  const beat = candidate.scenes[location.scene - 1]?.beats[location.beat - 1]
  if (beat === undefined || beat.text !== location.text) {
    throw Error('story_notes_location: 成稿定位须准确对应实际场次、节拍与文字。')
  }
  return beat
}
/**
 * Hash final screenplay content before attaching adaptation notes.
 * @param candidate - Host-issued scenes and sources.
 * @returns Non-circular content digest.
 */
export function storyContentDigest(candidate: Candidate): string {
  return sha256(JSON.stringify({ episode: candidate.episode, scenes: candidate.scenes, coverage: candidate.coverage,
    source_ids: candidate.source_ids }))
}
/**
 * Bind source-based notes to this candidate and optional actual input snapshot.
 * @param project - Scoped current work grant and reviewed inventory.
 * @param candidate - New output version.
 * @param input - Source/output mappings supplied by the writer.
 * @returns Final-bound story metadata.
 */
export function buildStoryAdaptation(project: ProjectFile, candidate: Candidate, input: z.input<typeof STORY_NOTES>): NonNullable<Candidate['story_adaptation']> {
  const notes = STORY_NOTES.parse(input)
  const inventory = project.story_inventories?.find(value => value.id === notes.inventory_id)
  if (inventory === undefined || project.story_policy === undefined) throw Error('story_inventory_required: 使用已审校的本集故事清单。')
  const previous = notes.input_candidate_id === undefined
    ? undefined : project.candidates.find(value => value.id === notes.input_candidate_id)
    ?? project.story_policy.input_candidates?.map(value => CANDIDATE_RECORD.parse(JSON.parse(value))).find(value => value
      .id === notes.input_candidate_id)
  if (notes.input_candidate_id !== undefined && (previous === undefined || previous.episode !== candidate.episode)) {
    throw Error('story_input_candidate: 修改输入须为项目中真实存在的同集候选，不能虚构逐字基线。')
  }
  return { version: 'story-faithful-v2', policy_sha256: project.story_policy.sha256, inventory_id: inventory.id,
    inventory_sha256: inventory.sha256, scope_sha256: inventory.scope_sha256, output_content_sha256: storyContentDigest(candidate), notes,
    ...(previous === undefined ? {} : { input_candidate_json: JSON.stringify(inputSnapshot(previous)) }) }
}
/**
 * Check bounded supplementation independently of mode and free-form reasons.
 * @param project - Scoped story work grant.
 * @param fact - Proposed or durable fact fields.
 */
export function validateStorySupplement(project: ProjectFile, fact: Pick<Fact, 'origin' | 'kind' | 'actor' | 'layer' | 'story_supplement'> & { anchors: { unit_id: string; quote: string }[] }): void {
  const supplement = fact.story_supplement
  if (supplement === undefined) return
  const policy = project.story_policy
  if (policy === undefined || fact.origin !== 'adaptation' || supplement.policy_sha256 !== policy.sha256
    || supplement.authorization_sha256 !== sha256(JSON.stringify(policy.authorization))
      || !policy.allowed_categories.includes(supplement.category)
    || fact.kind !== { performance_detail: 'action', minimal_os: 'thought', supporting_dialogue: 'speech' }[supplement.category]
    || !fact.actor?.trim() || fact.layer === 'commentary' || fact.anchors.length === 0) {
    throw Error('story_supplement_authorization: 演绎须绑定本作品实际用户授权、明确类别与原来源上下文。')
  }
}
/**
 * Validate mappings, actual inputs, critical actions, causality and knowledge declarations.
 * Artistic meaning is evaluated by the C-step model, not inferred by this function.
 * @param project - Authoritative policy and reviewed source scope.
 * @param candidate - Exact candidate used by all acceptance and rendering paths.
 * @param requireReady - Refuse superseded inventories or unknown critical evidence when accepting.
 */
export function validateStoryCandidate(project: ProjectFile, candidate: Candidate, requireReady = false): void {
  validateStoryPolicy(project)
  const metadata = candidate.story_adaptation
  if (project.story_policy === undefined) {
    if (metadata !== undefined) throw Error('story_policy_required: 候选没有获授权的作品策略。')
    return
  }
  if (metadata === undefined && project.story_policy.retained_candidates?.some(value => value.id === candidate.id
    && value.sha256 === candidateDigest(candidate))) return
  if (metadata === undefined || candidate.refinement !== undefined) throw Error('story_report_required: 故事忠实候选须有独立实际来源映射和修改说明。')
  const inventory = inventoryFor(project, candidate)
  validateInventory(project, inventory)
  if (inventory.episode !== candidate.episode || inventory.review?.decision !== 'approve' || !validInventoryReview(project, inventory)
    || metadata.policy_sha256 !== project.story_policy.sha256 || metadata.inventory_sha256 !== inventory.sha256
    || metadata.scope_sha256 !== inventory.scope_sha256 || metadata.output_content_sha256 !== storyContentDigest(candidate)
    || JSON.stringify(candidate.coverage) !== JSON.stringify(inventory.coverage)
    || candidate.sha256 !== candidateDigest(candidate)) throw Error('story_candidate_digest: 候选须绑定本集已分轮审校清单、策略与成稿版本。')
  if (requireReady && (inventory.superseded_at_revision !== undefined || inventory.items.some(item => item.critical && item.evidence !== 'confirmed') || storyEvidencePending(project, inventory).length > 0)) {
    throw Error('story_evidence_pending: 本集关键证据未解决或补帧后清单已失效，须完成来源复看和新的清单审校。')
  }
  const notes = metadata.notes
  if (notes.inventory_id !== inventory.id || new Set(notes.mapping.map(value => value.item_id)).size !== notes.mapping.length
    || notes.mapping.length !== inventory.items.length) throw Error('story_mapping_required: 每个故事项须有唯一完整成稿定位。')
  const positions = new Map<string, number>()
  for (const item of inventory.items) {
    const mapping = notes.mapping.find(value => value.item_id === item.id)
    if (mapping === undefined) throw Error('story_mapping_required: 关键事件或关系不得静默遗漏。')
    for (const output of mapping.outputs) {
      const beat = located(candidate, output)
      if (!beat.fact_ids.some(id => item.fact_ids.includes(id) || project.facts.some(fact => fact.id === id
        && fact.origin === 'adaptation' && fact.anchors.some(anchor => item.source_units.includes(anchor.unit_id))))) {
        throw Error('story_mapping_evidence: 成稿映射须实际承接该故事项的来源事实或获授权演绎上下文。')
      }
    }
    const beats = mapping.outputs.map(output => located(candidate, output))
    if (item.critical && item.dimension === 'action_result'
      && item.fact_ids.some(id => project.facts.some(fact => fact.id === id && fact.kind === 'action'))
      && !beats.some(beat => beat.kind === 'action')) {
      throw Error('story_key_action: 关键动作与结果须在可拍动作中保留。')
    }
    for (const knowledge of item.knowledge) if (!beats.some(beat => beat.fact_ids.includes(knowledge.fact_id)
      && beat.actor === knowledge.actor && (beat.kind === 'dialogue' || (beat.kind === 'vo' && beat.audible_in_scene === true))
      && knowledge.recipients.every(recipient => beat.witnesses.includes(recipient) || beat.actor === recipient))) {
      throw Error(`story_knowledge_preservation: ${item.id} / ${knowledge.fact_id} 须在该项 mapping.outputs 中保留`
        + ` ${knowledge.actor} 的实际发声及听者 ${JSON.stringify(knowledge.recipients)}；不能以OS替代。`)
    }
    positions.set(item.id, Math.min(...mapping.outputs.map(output => output.scene * 1_000_000 + output.beat)))
  }
  for (const item of inventory.items) for (const dependency of item.depends_on) {
    if ((positions.get(dependency) ?? Infinity) > (positions.get(item.id) ?? -Infinity)) throw Error('story_causal_order: 因果及揭晓依赖不能提前于其前提。')
  }
  const unitIds = new Set(inventoryReads(project, inventory).filter(read => read.kind === 'source').map(read => read.id))
  const scopedFacts = project.facts.filter(fact => fact.origin === 'source' && fact.created_at <= inventory.created_at && fact.withdrawal === undefined
    && fact.review?.decision === 'approve' && fact.anchors.some(anchor => unitIds.has(anchor.unit_id)))
  if (new Set(notes.dispositions.map(value => value.fact_id)).size !== notes.dispositions.length
    || notes.dispositions.length !== scopedFacts.length
      || scopedFacts.some(fact => !notes.dispositions.some(value => value.fact_id === fact.id))) {
    throw Error('story_source_disposition: 本集每个已批准来源事实须说明保留、合并或非故事性省略。')
  }
  for (const disposition of notes.dispositions) {
    const fact = scopedFacts.find(value => value.id === disposition.fact_id)
    if (fact === undefined) throw Error('story_source_disposition: 处置引用超出实际本集来源。')
    if (disposition.disposition === 'omitted_non_story' && inventory.items.some(item => item.critical && item.fact_ids.includes(fact.id))) {
      throw Error('story_key_omitted: 关键事件、动作、关系和因果不能声明为非故事性省略。')
    }
  }
  let previous: z.infer<typeof INPUT_SNAPSHOT> | undefined
  if (metadata.input_candidate_json !== undefined) {
    previous = INPUT_SNAPSHOT.parse(JSON.parse(metadata.input_candidate_json))
    const original = project.candidates.find(value => value.id === previous?.id)
      ?? project.story_policy.input_candidates?.map(value => CANDIDATE_RECORD.parse(JSON.parse(value))).find(value => value
        .id === previous?.id)
    if (previous.id !== notes.input_candidate_id || previous.episode !== candidate.episode || original === undefined
      || JSON.stringify(previous) !== JSON.stringify(inputSnapshot(original))) {
      throw Error('story_input_digest: 实际修改输入快照或摘要已变更。')
    }
  } else if (notes.input_candidate_id !== undefined) throw Error('story_input_required: 修改已有稿须保留真实输入快照。')
  for (const change of notes.changes) {
    if (change.before === undefined && change.source === undefined) throw Error('story_change_source: 新作品使用真实source/fact定位，已有稿使用实际before，不能造逐字稿。')
    if (change.before !== undefined) {
      if (previous === undefined) throw Error('story_no_before: 没有真实输入剧本时不能填写before。')
      located(previous, change.before)
    }
    if (change.source !== undefined && (!unitIds.has(change.source.unit_id) || (change.source.fact_id !== undefined
      && !project.facts.some(fact => fact.id === change.source?.fact_id
        && fact.anchors.some(anchor => anchor.unit_id === change.source?.unit_id))))) {
      throw Error('story_change_source: 说明的源定位须对应本集真实来源和事实。')
    }
    if (change.after !== undefined) located(candidate, change.after)
  }
  if (previous !== undefined) for (const [sceneIndex, scene] of previous.scenes.entries()) for (const [beatIndex,
    beat] of scene.beats.entries()) {
    if (JSON.stringify(candidate.scenes[sceneIndex]?.beats[beatIndex]) !== JSON.stringify(beat)
      && !notes.changes.some(change => change.before?.scene === sceneIndex + 1 && change.before.beat === beatIndex + 1)) {
      throw Error('story_input_change_unhandled: 删除、替换或重排已有稿节拍须保留实际before定位。')
    }
  }
  if (notes.scene_changes.some(change => change.scene > candidate.scenes.length)
    || new Set(notes.scene_changes.map(change => change.scene)).size !== notes.scene_changes.length) throw Error('story_scene_notes: 场次说明不能越界或重复。')
  const priorFacts = new Set(project.candidates.filter(value => project.accepted.includes(value.id) && value.episode < candidate.episode)
    .flatMap(value => value.scenes.flatMap(scene => scene.beats.flatMap(beat => [...beat.fact_ids, ...beat.requires_knowledge]))))
  for (const comment of notes.editor_comments) {
    if (comment.change_indices.some(index => index > notes.changes.length)
      || new Set(comment.change_indices).size !== comment.change_indices.length
      || (['adopted', 'partial'].includes(comment.disposition) && comment.change_indices.length === 0)) throw Error('story_comment_location: 已采用批注须对应实际修改，未采用或待核实须保留理由。')
  }
  for (const [sceneIndex, scene] of candidate.scenes.entries()) {
    if (!notes.scene_changes.some(change => change.scene === sceneIndex + 1)) throw Error('story_scene_notes: 每个实际场次须说明镜头、拆合场或来源安排。')
    for (const [beatIndex, beat] of scene.beats.entries()) {
      if (!notes.changes.some(change => change.after?.scene === sceneIndex + 1 && change.after.beat === beatIndex + 1)) {
        throw Error(`story_change_unhandled: 第${sceneIndex + 1}场第${beatIndex + 1}拍缺少 changes.after；`
          + '须保留来源或真实修改前定位。')
      }
      for (const id of [...beat.fact_ids, ...beat.requires_knowledge]) {
        const fact = project.facts.find(fact => fact.id === id)
        const priorKnowledge = !beat.fact_ids.includes(id) && priorFacts.has(id)
        if (!priorKnowledge && (fact === undefined || !fact.anchors.some(anchor => unitIds.has(anchor.unit_id)))) throw Error('story_fact_scope: 正文事实须属于本集真实范围；知情前提只能引用本集或已验收前情，不能借未来来源。')
        if (priorKnowledge) continue
        if (fact?.origin === 'source' && beat.fact_ids.includes(id)) {
          if (beat.kind === 'action' && (fact.actor !== beat.actor || !fact.anchors.some(anchor => unitIds.has(anchor.unit_id)
            && project.sources.some(source => source.units.some(unit => unit.id === anchor.unit_id && unit.image !== undefined))))) {
            throw Error('story_visual_fact_evidence: 来源动作须保留实际行动者和本集已观察画面证据，不能由ASR猜动作。')
          }
          if (beat.kind !== 'action' && !fact.anchors.some(anchor => unitIds.has(anchor.unit_id)
            && project.sources.some(source => source.units.some(unit => unit.id === anchor.unit_id && unit.image === undefined)))) {
            throw Error('story_voice_source_evidence: 来源发声/心理须有实际文本依据，不由图片冒称原声。')
          }
        }
        if (fact?.origin === 'adaptation') {
          validateStorySupplement(project, fact)
          if (fact.story_supplement === undefined || fact.anchors.some(anchor => !unitIds.has(anchor.unit_id))) {
            throw Error('story_supplement_scope: 新增演绎不能由mode/reason自开或引用未来集。')
          }
        }
      }
    }
  }
  if (candidate.review?.semantic_report !== undefined) {
    validateSemanticReport(project, candidate, candidate.review.semantic_report, candidate.review.decision === 'approve')
    if (candidate.review.decision === 'approve') validateStoryAcceptance(project, candidate)
  }
  else if (requireReady && candidate.review?.decision === 'approve') throw Error('story_semantic_required: approve须保存真实C轮语义复原报告。')
}
/**
 * Derive immutable report bindings after successful C-step evidence validation.
 * @param project - Current work policy and inventory.
 * @param candidate - Exact reviewed version.
 * @param input - Model's scoped semantic judgments.
 * @returns Digest-bound persisted report.
 */
export function buildSemanticReport(project: ProjectFile, candidate: Candidate, input: z.input<typeof SEMANTIC_INPUT>): NonNullable<NonNullable<Candidate['review']>['semantic_report']> {
  const inventory = inventoryFor(project, candidate)
  const report = { ...SEMANTIC_INPUT.parse(input), protocol: 'story-faithful-semantic-v2' as const, sha256: '',
    policy_sha256: project.story_policy?.sha256 ?? '', inventory_sha256: inventory.sha256, scope_sha256: inventory.scope_sha256,
    candidate_id: candidate.id, candidate_sha256: candidate.sha256 }
  const { sha256: _hash, ...content } = report
  report.sha256 = sha256(JSON.stringify(content))
  return report
}
/**
 * Validate semantic report identities, exact locations, complete item scope and declared deviations.
 * @param project - Immutable work evidence.
 * @param candidate - Candidate referenced by the report.
 * @param report - Persisted C-step judgments.
 * @param approving - Whether all declared deviations and unknowns must block acceptance.
 */
export function validateSemanticReport(project: ProjectFile, candidate: Candidate,
  report: NonNullable<NonNullable<Candidate['review']>['semantic_report']>, approving: boolean): void {
  const inventory = inventoryFor(project, candidate), metadata = candidate.story_adaptation
  const { sha256: hash, ...content } = report
  if (metadata === undefined || hash !== sha256(JSON.stringify(content)) || report.candidate_id !== candidate.id
    || report.candidate_sha256 !== candidate.sha256 || report.policy_sha256 !== project.story_policy?.sha256
    || report.inventory_sha256 !== inventory.sha256 || report.scope_sha256 !== inventory.scope_sha256
    || report.checks.length !== inventory.items.length
      || new Set(report.checks.map(check => check.item_id)).size !== report.checks.length) {
    throw Error('story_semantic_digest: 语义报告须完整绑定当前策略、清单、正文及本集范围。')
  }
  for (const item of inventory.items) {
    const check = report.checks.find(check => check.item_id === item.id)
    const mapping = metadata.notes.mapping.find(value => value.item_id === item.id)
    if (check === undefined || check.source_units.length !== item.source_units.length
      || item.source_units.some(id => !check.source_units.includes(id))
        || JSON.stringify(check.outputs) !== JSON.stringify(mapping?.outputs)) {
      throw Error(`story_semantic_scope: ${item.id} 的 source_units 须完整复制清单本项来源，`
        + 'outputs 须按顺序完整复制当前候选 story_adaptation.notes.mapping 中本项定位和全文；不能只取首拍或摘句。')
    }
    for (const output of check.outputs) located(candidate, output)
  }
  if (approving && (report.deviations.length > 0 || report.unverified.length > 0
    || report.checks.some(check => check.status !== 'preserved'))) {
    throw Error('story_semantic_deviation: 已声明关系、立场、因果、条件、关键动作或揭晓偏差/未核实项不能批准，须修订或用户明确新范围。')
  }
}
/**
 * Render separate final-version explanation without contaminating the screenplay body.
 * @param project - Current work scope.
 * @param candidate - Actual output candidate.
 * @returns Chinese notes with source/output references and bounded judgments.
 */
export function renderStoryNotes(project: ProjectFile, candidate: Candidate): string {
  if (candidate.story_adaptation === undefined) return ''
  validateStoryCandidate(project, candidate)
  const metadata = candidate.story_adaptation, notes = metadata.notes, inventory = inventoryFor(project, candidate)
  const at = (value: Location) => `场${value.scene}/节拍${value.beat}：${value.text}`
  const report = candidate.review?.semantic_report
  const input = metadata.input_candidate_json === undefined ? undefined : INPUT_SNAPSHOT.parse(JSON.parse(metadata.input_candidate_json))
  const factIds = new Set(candidate.scenes.flatMap(scene => scene.beats.flatMap(beat => [...beat.fact_ids, ...beat.requires_knowledge])))
  const supplements = project.facts.filter(fact => factIds.has(fact.id) && fact.story_supplement !== undefined)
  const rows = ['《修改说明》', `策略：story-faithful-v2；第${candidate.episode}集；${project.story_policy?.scope.instructions}`,
    `输出：${candidate.id} / ${candidate.sha256}；正文摘要：${metadata.output_content_sha256}`,
    `清单：${inventory.id} / ${inventory.sha256}；本集范围：${inventory.scope_sha256}`,
    metadata.input_candidate_json === undefined ? '输入：原视频、已审校事实及故事清单；没有逐字剧本基线。'
      : `输入：真实候选 ${input?.id} / ${input?.sha256}；正文摘要 ${input?.content_sha256}；输入快照已保留。`,
    ...notes.changes.map((change, index) => `${index + 1}. ${change.before === undefined ? `来源 ${change.source?.unit_id}${change.source?.fact_id === undefined ? '' : ` / ${change.source.fact_id}`}` : at(change.before)} → ${change.after === undefined ? '省略或合并' : at(change.after)}；${change.reason}`),
    ...notes.editor_comments.map(comment => `编辑意见 ${comment.disposition}：${comment.comment}；修改条目 ${comment.change_indices.join('、') || '无'}；${comment.reason}`),
    ...notes.scene_changes.map(change => `场${change.scene}安排：${change.reason}`),
    ...notes.dispositions.map(value => `${value.fact_id}：${value.disposition}；${value.reason}`),
    `未解决：${notes.unresolved.join('；') || '未列出；不等同于全局通过。'}`,
    '补充演绎：', ...supplements.map(fact => `${fact.id}：adaptation / ${fact.story_supplement?.category}；来源 ${fact.anchors.map(anchor => anchor.unit_id).join('、')}；策略 ${fact.story_supplement?.policy_sha256}；用户授权摘要 ${fact.story_supplement?.authorization_sha256}；${fact.adaptation_reason}`),
    ...(supplements.length === 0 ? ['无本候选新增演绎事实。'] : []),
    `实际机械定位范围：场${candidate.scenes.map((_, index) => index + 1).join('、')}；来源${inventoryReads(project, inventory).filter(read => read.kind === 'source').map(read => read.id).join('、')}。仅核对引用、位置、摘要、真实分轮及声明偏差，艺术语义是模型判断。`,
    '实际采样图像：', ...inventory.coverage.windows.flatMap((window) => { const source = project.sources.find(value => value.id === window.source_id); return source?.video === undefined ? [] : [`${source.id} / ${source.video.path} / ${source.video.source_version}：${source.video.samples.slice(window.start - 1, window.start - 1 + window.count).map(sample => `${sample.timestamp_seconds}s`).join('、')}；范围 ${window.interval?.start_seconds ?? source.video.interval?.start_seconds ?? 0}–${window.interval?.end_seconds ?? source.video.interval?.end_seconds ?? source.video.duration_seconds}s；采样不等于连续观看。`] }),
    `证据待核范围：${storyEvidencePending(project, inventory).join('；') || '声明范围内计划窗口均有实际采样；不代表未采样帧或全局视觉通过。'}`,
    '原始来源/实际观察索引保留；文字来源不自动证明真实原音，新增内容维持adaptation归属。',
    report === undefined ? '语义复原：尚未运行C轮报告。' : `语义复原：${report.protocol} / ${report.sha256}；${candidate.review?.decision}；事件链：${report.event_chain}；情绪冲突：${report.emotion_conflict}；关系立场：${report.relationship_stance}；因果揭晓：${report.causality_reveal}`,
    ...(report?.checks.map(check => `${check.item_id}：${check.status}；${check.explanation}`) ?? []),
    `偏差：${report?.deviations.join('；') || '未列出' }；未核实：${report?.unverified.join('；') || '未列出'}`]
  return `${rows.join('\n')}\n`
}

/**
 * Bind final C-step semantic judgments to actual source inspection receipts.
 * @param project - Actual policy and source evidence.
 * @param candidate - Reviewed candidate after its semantic report and A/B/C evidence exist.
 * @returns Host-derived final approval identity.
 */
export function buildStoryAcceptance(project: ProjectFile, candidate: Candidate): NonNullable<NonNullable<Candidate['review']>['story_acceptance']> {
  const review = candidate.review, report = review?.semantic_report, evidence = review?.evidence
  if (review === undefined || report === undefined || evidence === undefined) throw Error('story_acceptance_evidence: 最终绑定需要实际C报告与真实分轮证据。')
  const sources = [...new Set(candidate.coverage?.windows.map(window => window.source_id) ?? [])].flatMap((id) => {
    const source = project.sources.find(value => value.id === id)
    return source?.video === undefined ? [] : [{ source_id: id, manifest_sha256: source.trusted_video_receipt?.manifest_sha256 ?? '', receipt_sha256: sha256(JSON.stringify(source.trusted_video_receipt)) }]
  })
  const proof = { protocol: 'story-faithful-acceptance-v2' as const, sha256: '', session_id: review.actor,
    review_step: evidence.review_step, candidate_id: candidate.id, candidate_sha256: candidate.sha256,
    policy_sha256: report.policy_sha256, inventory_sha256: report.inventory_sha256, scope_sha256: report.scope_sha256,
    semantic_report_sha256: report.sha256, sources }
  const { sha256: _hash, ...content } = proof
  proof.sha256 = sha256(JSON.stringify(content))
  return proof
}
/**
 * Check final Host-generated approval bindings on every synchronous replay path.
 * @param project - Exact source receipts and policy.
 * @param candidate - Final reviewed output.
 */
export function validateStoryAcceptance(project: ProjectFile, candidate: Candidate): void {
  if (candidate.review?.story_acceptance === undefined
    || JSON.stringify(candidate.review.story_acceptance) !== JSON.stringify(buildStoryAcceptance(project, candidate))) {
    throw Error('story_acceptance_digest: 最终C验收绑定缺失或版本/来源/报告摘要已变更。')
  }
}
const REVIEW_RECEIPT = z.object({
  revision: z.number().int().nonnegative(),
  review_receipt: z.object({
    protocol: z.literal('story-faithful-review-result-v2'),
    candidate_id: CANDIDATE_RECORD.shape.id, candidate_sha256: CANDIDATE_RECORD.shape.sha256,
    review_sha256: CANDIDATE_RECORD.shape.sha256, acceptance_sha256: CANDIDATE_RECORD.shape.sha256,
    decision: z.literal('approve'),
  }).strict(),
}).strict()

/**
 * Project a successful V2 review as a bounded logged receipt; its PTC value retains the full candidate.
 * @param value - Canonical JSON result returned by the review command.
 * @returns Exact review receipt, or undefined for reviews without a V2 approval.
 */
export function storyReviewResultReceipt(value: unknown): z.infer<typeof REVIEW_RECEIPT> | undefined {
  const result = z.object({ revision: z.number().int().nonnegative(), candidate: CANDIDATE_RECORD }).parse(value)
  const review = result.candidate.review, acceptance = review?.story_acceptance
  if (review?.decision !== 'approve' || acceptance === undefined) return undefined
  return { revision: result.revision, review_receipt: { protocol: 'story-faithful-review-result-v2',
    candidate_id: result.candidate.id, candidate_sha256: result.candidate.sha256,
    review_sha256: sha256(JSON.stringify(review)), acceptance_sha256: acceptance.sha256, decision: 'approve' } }
}
function loggedCandidate(content: readonly { type: string; text?: string }[], candidate: Candidate): boolean {
  for (const block of content) if (block.type === 'text' && block.text !== undefined) {
    let parsed: unknown
    try { parsed = JSON.parse(block.text) } catch (error) { if (!(error instanceof SyntaxError)) throw error; continue }
    const receipt = REVIEW_RECEIPT.safeParse(parsed)
    if (receipt.success) {
      const review = candidate.review, evidence = review?.evidence, acceptance = review?.story_acceptance
      const recorded = receipt.data.review_receipt
      if (review?.decision === 'approve' && evidence !== undefined && acceptance !== undefined
        && receipt.data.revision === evidence.project_revision + 1
        && recorded.candidate_id === candidate.id && recorded.candidate_sha256 === candidate.sha256
        && recorded.review_sha256 === sha256(JSON.stringify(review)) && recorded.acceptance_sha256 === acceptance.sha256) return true
      continue
    }
    const value = z.object({ candidate: CANDIDATE_RECORD }).safeParse(parsed)
    if (!value.success) continue
    const { committed_at: _committed, ...current } = candidate
    const { committed_at: _oldCommitted, ...recorded } = value.data.candidate
    if (JSON.stringify(current) === JSON.stringify(recorded)) return true
  }
  return false
}
/**
 * Verify final C approval against its original successful screenplay tool and every outer PTC result.
 * @param ctx - Host Session query access; reads the original durable or live Session.
 * @param project - Authoritative accepted content.
 * @param candidate - Exact candidate with final C binding.
 * @param signal - Cancels log observation.
 */
export async function validateStoryApprovalLog(ctx: Context, project: ProjectFile, candidate: Candidate,
  signal: AbortSignal): Promise<void> {
  validateStoryCandidate(project, candidate, true)
  const proof = candidate.review?.story_acceptance
  if (proof === undefined) return
  const query = ctx.get('sessionQuery')
  if (query === undefined) throw Error('story_approval_log_pending: 正式验收需原会话成功工具日志，当前Session query不可用。')
  using observation = await query.observeSession(SessionId(proof.session_id), { signal, projectionMode: 'none' })
  const events = observation.events, start = events[proof.review_step]
  if (start?.type !== 'step/start') throw Error('story_approval_log_pending: C轮实际step记录不可用。')
  const end = events.find(event => event.seq > proof.review_step && (event.type === 'step/end' || event.type === 'step/start'))?.seq ?? events.length
  const matchesRequest = (input: unknown): boolean => {
    const request = z.object({ request: z.object({ method: z.literal('review'), candidate_id: z.literal(candidate.id),
      candidate_sha256: z.literal(candidate.sha256), decision: z.literal('approve'), semantic_report: SEMANTIC_INPUT }) }).safeParse(input)
    return request.success
      && JSON.stringify(request.data.request.semantic_report) === JSON.stringify(SEMANTIC_INPUT.strip().parse(candidate
        .review?.semantic_report))
  }
  const own = events.find(event => event.seq > proof.review_step && event.seq < end && (
    event.type === 'tool/ptc-dispatch' && !event.data.isError && event.data.name === 'screenplay_project'
      && matchesRequest(event.data.arguments) && loggedCandidate(event.data.content, candidate)
    || event.type === 'tool/result' && event.data.message.isError !== true && loggedCandidate(event.data.message.content, candidate)
      && events.some(call => call.type === 'tool/call' && call.seq > proof.review_step && call.seq < event.seq && call.data.callId === event.data.message.toolCallId && call.data.name === 'screenplay_project'
        && matchesRequest(JSON.parse(call.data.arguments))) ))
  if (own === undefined) throw Error('story_approval_log_pending: 最终候选未匹配实际成功C轮review工具结果。')
  let current: SessionEvent = own
  while (current.type === 'tool/ptc-dispatch') {
    const parentCall = current.data.parentCallId
    const childSeq = current.seq
    const parent = events.find(event => event.seq > childSeq && event.seq < end && (
      event.type === 'tool/ptc-dispatch' && event.data.subCallId === parentCall
      || event.type === 'tool/result' && event.data.message.toolCallId === parentCall))
    if (parent === undefined || parent.type === 'tool/ptc-dispatch' && parent.data.isError
      || parent.type === 'tool/result' && parent.data.message.isError === true) throw Error('story_approval_log_pending: C轮外层程序尚未成功，失败或被取消不能批准正式验收。')
    current = parent
  }
  signal.throwIfAborted()
}
/**
 * Recheck final C approval and original video evidence before accepted exports, Word or presentation.
 * @param project - Parsed accepted project with Host-issued records.
 * @param verify - Host resolver for original Session inspection events and current source bytes.
 * @param approvalVerifier - Host validator for exact successful C review and outer execution.
 */
export async function validateAcceptedStoryEvidence(project: ProjectFile, verify: (input: unknown,
  persistedReceipt?: unknown) => Promise<unknown>,
approvalVerifier?: (candidate: Candidate) => Promise<void>): Promise<void> {
  validateStoryPolicy(project)
  if (project.story_policy === undefined) return
  if (approvalVerifier === undefined) throw Error('story_approval_log_pending: V2正式交付须核实际成功C轮日志。')
  const candidates = project.candidates.filter(candidate => project.accepted.includes(candidate.id)
    && candidate.story_adaptation !== undefined)
  for (const candidate of candidates) { validateStoryCandidate(project, candidate, true); await approvalVerifier(candidate) }
  const sources = new Set(candidates.flatMap(candidate => candidate.coverage?.windows.map(window => window.source_id) ?? []))
  for (const source of project.sources) if (sources.has(source.id) && source.video !== undefined) {
    if (source.trusted_video_receipt === undefined || source.trusted_video_manifest === undefined) throw Error('story_video_evidence_pending: 本集缺少真实probe/sample日志证据，不能正式交付。')
    await verify(source.trusted_video_manifest, source.trusted_video_receipt)
  }
}
