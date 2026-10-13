/** Guarded project publication and independently reviewed episode commands. @module screenplay-project/project */

import { z } from 'zod'
import { TRUSTED_VIDEO_INSPECTION_RECEIPT } from '@deepseek-ai/dsh-tool-video-inspect'
import { randomUUID } from 'node:crypto'
import type { FileSystem, FsTarget, FsVersion } from '@deepseek-ai/dsh-fs'
import { FsError } from '@deepseek-ai/dsh-fs'
import type { SandboxExecutionPolicy } from '@deepseek-ai/dsh-sandbox'
import type { SessionSeq } from '@deepseek-ai/dsh-session'
import type { AttachmentStore } from '@deepseek-ai/dsh-attachment'
import { assertNever } from '@deepseek-ai/dsh-util-values'
import { PROJECT_FILE, TRANSCRIPT, VIDEO_INSPECTION, VIDEO_SOURCE, FACT_RECORD, CANDIDATE_RECORD, SCENE_RECORD, REFINEMENT_POLICY, HUMAN_AUTHORIZATION, STORY_POLICY, STORY_INVENTORY } from './schema.ts'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { ActorId, FactId, SourceId, UnitId } from './ids.ts'
import type { ProjectFile, ProjectRequest, ProjectSource } from './schema.ts'
import { candidateFacts, factDigest, requiredReads, selfCheckEvidence, sourceRead, validReview, validWithdrawal } from './review.ts'
import type { ProjectReadReceipt } from './review.ts'
import { buildRefinement, refinementPolicyDigest, validateRefinement, validateRefinementPolicy, validateSupplement } from './refinement.ts'
import type { HumanAuthorization } from './refinement.ts'
import { buildStoryAdaptation, buildSemanticReport, buildStoryAcceptance, inventoryDigest, inventoryEvidence, inventoryReads, storyPolicyDigest, storyScopeDigest, storyEvidencePending, validateInventory, validateSemanticReport, validateStoryCandidate, validateStoryPolicy, validateStorySupplement, validInventoryReview, validateAcceptedStoryEvidence } from './story.ts'
import { acceptedCandidates, acceptedKnowledge, candidateDigest, checkVideoCoverage, renderEpisode, sha256 } from './episode.ts'

/** Validated allocation and source-read budgets. */
export interface ProjectLimits {
  /** Maximum bytes read from each original source file. */
  maxSourceBytes: number
  /** Maximum encoded bytes loaded or published for a project artifact. */
  maxProjectBytes: number
  /** Maximum original units, facts, or drafted scene files in one operation. */
  maxReadUnits: number
  /** Maximum encoded bytes returned by a source or fact window. */
  maxReadBytes: number
  /** Maximum facts proposed or independently reviewed by one atomic mutation. */
  maxFactBatch: number
}

/** Per-call cancellation and standing filesystem policy. */
export interface ProjectExecution {
  actor: ActorId
  /** Live host step/start sequence; absent outside a running model step. */
  step?: SessionSeq
  /** Successfully delivered current model-history read receipts. */
  receipts?: readonly ProjectReadReceipt[]
  /** Capture a read for the host to publish only after final tool success. */
  observeRead?: (receipt: ProjectReadReceipt) => void
  /** Host-verified currently visible source:user evidence, never supplied by tool JSON. */
  authorization?: HumanAuthorization
  /** Current user-message sequence enforced by the Host for a new bounded story grant. */
  latestUserSeq?: SessionSeq
  /** Trusted inspection resolver bound to the actual session, never a tool JSON proof. */
  verifyStoryVideo?: (input: unknown, persistedReceipt?: unknown) => Promise<unknown>
  /** Final approval log validator bound to the Host Session query. */
  verifyStoryApproval?: (project: ProjectFile, candidate: ProjectFile['candidates'][number]) => Promise<void>
  cwd?: string
  signal: AbortSignal
  policy?: SandboxExecutionPolicy
}

interface Loaded {
  target: FsTarget
  version: FsVersion
  sha256: string
  project: ProjectFile
  knowledge: Record<string, string[]>
  validated?: boolean
}

function referencesFact(candidate: ProjectFile['candidates'][number], id: FactId): boolean {
  return candidate.scenes.some(scene => scene.beats.some(beat => beat.fact_ids.includes(id) || beat.requires_knowledge.includes(id)))
    || candidate.story_adaptation?.notes.dispositions.some(disposition => disposition.fact_id === id) === true
    || candidate.story_adaptation?.notes.changes.some(change => change.source?.fact_id === id) === true
}

/** Project operations using the mounted filesystem; each mutation publishes one guarded JSON file. */
export class ProjectCommands {
  private cached: { hash: string; project: ProjectFile; knowledge: Record<string, string[]> } | undefined

  constructor(private readonly fs: FileSystem, private readonly limits: ProjectLimits, private readonly attachments: AttachmentStore,
    private readonly reviewMode: 'independent' | 'self-check' = 'independent',
    private readonly refinementMode: 'disabled' | 'source-preserving-v1' = 'disabled',
    private readonly storyFaithfulMode: 'disabled' | 'story-faithful-v2' = 'disabled') {}

  private async target(path: string, exec: ProjectExecution): Promise<FsTarget> {
    return this.fs.resolve(path, { ...(exec.cwd === undefined ? {} : { cwd: exec.cwd }), signal: exec.signal })
  }

  private async load(path: string, exec: ProjectExecution): Promise<Loaded> {
    const target = await this.target(path, exec)
    const before = await this.fs.stat(target, exec.signal)
    if (before?.type !== 'file') throw Error('missing_project: 请先 init 项目文件。')
    const bytes = await this.fs.readBytes(target, exec.signal, this.limits.maxProjectBytes)
    const after = await this.fs.stat(target, exec.signal)
    if (after?.version !== before.version) throw Error('stale_read: 项目读取期间发生变更，请重读 status。')
    const hash = sha256(bytes)
    if (this.cached?.hash === hash) {
      return { target, version: before.version, sha256: hash, project: structuredClone(this.cached.project),
        knowledge: structuredClone(this.cached.knowledge), validated: true }
    }
    const project = PROJECT_FILE.parse(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)))
    const allIds = [project.id, ...project.sources.flatMap(source => [source.id, ...source.units.map(unit => unit.id)]),
      ...project.facts.map(fact => fact.id), ...project.candidates.map(candidate => candidate.id),
      ...(project.story_inventories ?? []).map(inventory => inventory.id)]
    if (new Set(allIds).size !== allIds.length) throw Error('invalid_project: 重复的来源、事实或版本编号。')
    validateRefinementPolicy(project)
    validateStoryPolicy(project)
    for (const inventory of project.story_inventories ?? []) {
      validateInventory(project, inventory, 'history')
      if (inventory.review !== undefined && !validInventoryReview(project, inventory)) throw Error('story_inventory_review: 清单真实分轮证据无效。')
    }
    const units = new Map(project.sources.flatMap(source => source.units.map(unit => [unit.id, unit] as const)))
    for (const fact of project.facts) {
      this.validateFact(project, fact, units)
      if (fact.review !== undefined && !validReview(project, fact, 'fact')) throw Error('invalid_project: 事实审校身份或自检证据无效。')
      if (fact.withdrawal !== undefined && (!validWithdrawal(project, fact)
        || project.candidates.some(candidate => referencesFact(candidate, fact.id)))) {
        throw Error('invalid_withdrawal: 撤销须独立进行，保留原批准记录且不能更改已有候选的事实。')
      }
    }
    for (const candidate of project.candidates) {
      validateRefinement(project, candidate)
      validateStoryCandidate(project, candidate, candidate.committed_at !== undefined)
      if (candidate.review !== undefined && !validReview(project, candidate, 'candidate')) throw Error('invalid_project: 候选审校身份或自检证据无效。')
      if (candidate.source_ids !== undefined && (new Set(candidate.source_ids).size !== candidate.source_ids.length
        || candidate.source_ids.some(id => !project.sources.some(source => source.id === id)))) {
        throw Error('invalid_candidate_sources: 候选来源绑定缺失或重复。')
      }
      if (candidate.sha256 !== candidateDigest(candidate)) {
        throw Error('invalid_candidate_digest: 正文结构和版本摘要不一致。')
      }
    }
    const knowledge = acceptedKnowledge(project)
    for (const candidate of acceptedCandidates(project)) checkVideoCoverage(project, candidate)
    return { target, version: before.version, sha256: hash, project, knowledge }
  }

  private validateFact(project: ProjectFile, fact: ProjectFile['facts'][number] | Extract<ProjectRequest, { method: 'propose_fact' }>['fact'],
    units: Map<string, ProjectSource['units'][number]>): void {
    if (fact.summary.trim().length === 0) throw Error('empty_fact: 事实摘要不可为空。')
    if ((fact.kind === 'speech' || fact.kind === 'thought') && !fact.actor?.trim()) throw Error('fact_actor: 发声与心理必须保留人物，未识别的人物使用稳定声音编号。')
    if (fact.kind === 'author_analysis' && (fact.actor !== undefined || fact.layer !== 'commentary')) {
      throw Error('author_attribution: 作者分析属于 commentary，不能指定为角色心理。')
    }
    const supplemental = 'supplemental' in fact ? fact.supplemental : undefined
    const storySupplement = 'story_supplement' in fact ? fact.story_supplement : undefined
    validateStorySupplement(project, { ...fact, story_supplement: storySupplement })
    validateSupplement(project, { ...fact, supplemental })
    if (fact.origin === 'adaptation') {
      const inherited = 'id' in fact && project.refinement?.original_facts.some(original => original.id === fact.id)
      if (project.refinement !== undefined && !inherited && supplemental === undefined) {
        throw Error('refinement_authorization: 精修新增事实须使用明确获准的补充类别；重大剧情变更须另行确认。')
      }
      const inheritedStoryFact = 'id' in fact && project.story_policy?.original_facts?.some(original => original.id === fact.id && original.sha256 === factDigest(fact))
      if (project.story_policy !== undefined && storySupplement === undefined && !inheritedStoryFact) throw Error('story_supplement_authorization: 新增演绎须绑定当前实际作品授权，mode/reason不能自行许可。')
      if ((project.mode !== 'adaptation' && supplemental === undefined && storySupplement === undefined && !inheritedStoryFact) || !fact.adaptation_reason?.trim()) throw Error('adaptation_direction: 新增事实须在已确定改编模式或授权精修范围下说明理由。')
    } else if (fact.anchors.length === 0) throw Error('missing_source: 来源事实须包含原文引用。')
    for (const anchor of fact.anchors) {
      const unit = units.get(anchor.unit_id)
      if (unit === undefined || anchor.quote.trim().length === 0 || !unit.text.includes(anchor.quote)) {
        throw Error(`source_quote_mismatch: ${anchor.unit_id} 的原文不包含引用；请 read_source 后重提。`)
      }
    }
  }

  private async verifySources(project: ProjectFile, exec: ProjectExecution, validated = false): Promise<void> {
    for (const source of project.sources) {
      const bytes = await this.fs.readBytes(await this.target(source.path, exec), exec.signal, this.limits.maxSourceBytes)
      if (sha256(bytes) !== source.sha256) throw Error(`source_changed: ${source.path} 已变更；旧来源不能继续用于新验收。`)
      if (!validated) {
        const expected = this.units(bytes, source.id, source.kind)
        if (JSON.stringify(expected) !== JSON.stringify(source.units)) throw Error('source_index_changed: 来源索引与原文件不一致。')
      }
      if (source.kind === 'video_inspection') {
        const input = await this.verifyVideo(bytes, exec)
        const video = VIDEO_SOURCE.strip().parse({ ...input, samples: input.frames.map(
          ({ requested_seconds, timestamp_seconds }) => ({ requested_seconds, timestamp_seconds })) })
        if (source.video !== undefined && JSON.stringify(source.video) !== JSON.stringify(video)) throw Error('source_index_changed: 视频检查范围与原文件不一致。')
        source.video = video
      }
    }
  }

  private units(bytes: Uint8Array, sourceId: SourceId, kind: ProjectSource['kind']): ProjectSource['units'] {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    if (kind === 'text') {
      return text.split(/\r?\n/).map((text, index) => ({ id: brandString<UnitId>(`${sourceId}:u${index + 1}`), ordinal: index + 1, text }))
    }
    if (kind === 'video_inspection') {
      const input = VIDEO_INSPECTION.parse(JSON.parse(text))
      return input.frames.map((frame, index) => {
        if (frame.timestamp_seconds >= input.duration_seconds || frame.requested_seconds >= input.duration_seconds) throw Error('frame_time: 视频帧时间码超出原件范围。')
        return { id: brandString<UnitId>(`${sourceId}:u${index + 1}`), ordinal: index + 1,
          text: `视频帧 ${frame.timestamp_seconds}s；图像引用 ${frame.image.attachmentId}。画面内容与人物身份须实际查看核对。`,
          start: frame.timestamp_seconds, end: frame.timestamp_seconds, image: frame.image }
      })
    }
    const input = TRANSCRIPT.parse(JSON.parse(text))
    return input.map((segment, index) => {
      if (segment.end < segment.start) throw Error('transcript_time: 语音片段结束早于开始。')
      return { id: brandString<UnitId>(`${sourceId}:u${index + 1}`), ordinal: index + 1, text: segment.text,
        start: segment.start, end: segment.end,
        ...(segment.speaker_id === undefined ? {} : { speaker_id: segment.speaker_id }) }
    })
  }

  private async verifyVideo(bytes: Uint8Array, exec: ProjectExecution) {
    const input = VIDEO_INSPECTION.parse(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)))
    const info = await this.fs.stat(await this.target(input.path, exec), exec.signal)
    if (info?.type !== 'file' || info.version !== input.source_version) throw Error('video_changed: 帧清单绑定的视频原件已变更，需重新检查画面。')
    if (input.interval !== undefined && (input.interval.end_seconds <= input.interval.start_seconds
      || input.interval.end_seconds > input.duration_seconds)) throw Error('video_interval: 检查区间超出视频范围。')
    const interval = input.interval
    if (interval !== undefined && input.frames.some(frame => frame.requested_seconds < interval.start_seconds
      || frame.requested_seconds >= interval.end_seconds)) throw Error('video_interval: 采样帧超出声明检查区间。')
    for (const point of [...(input.sampling_plan?.selected ?? []), ...(input.sampling_plan?.deferred ?? [])]) {
      if (point.time >= input.duration_seconds || (input.interval !== undefined
        && (point.time < input.interval.start_seconds || point.time >= input.interval.end_seconds))) {
        throw Error('video_interval: 检查点超出声明区间。')
      }
    }
    return input
  }

  private async save(loaded: Loaded, exec: ProjectExecution): Promise<void> {
    const project = loaded.project
    project.revision += 1
    project.updated_at = new Date().toISOString()
    const text = this.serialize(project)
    await this.fs.writeText(loaded.target, text, { kind: 'replaceIfVersion', version: loaded.version }, exec.signal, exec.policy)
  }

  private serialize(project: ProjectFile): string {
    const text = `${JSON.stringify(PROJECT_FILE.parse(project), null, 2)}\n`
    if (Buffer.byteLength(text, 'utf8') > this.limits.maxProjectBytes) throw Error('project_size: 超过配置的项目文件预算。')
    return text
  }

  private status(project: ProjectFile, knowledge = acceptedKnowledge(project)): object {
    return { project_id: project.id, revision: project.revision, mode: project.mode, instructions: project.instructions,
      ...(project.workflow === undefined ? {} : { workflow: project.workflow }),
      ...(project.review_mode === undefined ? {} : { review_mode: project.review_mode }),
      ...(project.parent === undefined ? {} : { parent: project.parent }),
      ...(project.story_policy === undefined ? {} : { story_policy: { ...project.story_policy,
        authorization_sha256: sha256(JSON.stringify(project.story_policy.authorization)) },
      story_inventories: (project.story_inventories ?? []).map(inventory => ({ id: inventory.id, sha256: inventory.sha256,
        episode: inventory.episode, review: inventory.review, superseded_at_revision: inventory.superseded_at_revision })) }),
      ...(project.refinement === undefined ? {} : { refinement: { version: project.refinement.version, sha256: project.refinement.sha256,
        source_project: project.refinement.source_project, scope: project.refinement.scope,
        allowed_categories: project.refinement.allowed_categories,
        authorization: project.refinement.authorization,
        authorization_sha256: sha256(JSON.stringify(project.refinement.authorization)),
        baselines: project.refinement.baselines.map(candidate => ({
          id: candidate.id, sha256: candidate.sha256, episode: candidate.episode })) } }),
      next_episode: project.accepted.length + 1,
      sources: project.sources.map(source => ({
        id: source.id, path: source.path, sha256: source.sha256, kind: source.kind, units: source.units.length,
      })),
      accepted: acceptedCandidates(project).map(candidate => ({
        id: candidate.id, episode: candidate.episode, sha256: candidate.sha256, committed_at: candidate.committed_at,
        ...(candidate.review?.kind === 'self-check' ? { review_kind: 'self-check' } : {}),
      })),
      fact_count: project.facts.length,
      pending: project.candidates.filter(candidate => candidate.committed_at === undefined)
        .slice(-this.limits.maxReadUnits).map(candidate => ({
          id: candidate.id, episode: candidate.episode, sha256: candidate.sha256, author: candidate.author, review: candidate.review,
        })), knowledge }
  }

  /**
   * Execute one validated model command; identity and timestamps come from the host.
   * @param request - Registry-validated operation and data.
   * @param exec - Runtime actor, cancellation, cwd, and filesystem policy.
   * @returns Canonical operation result, logged by the tool registry.
   */
  async execute(request: ProjectRequest, exec: ProjectExecution): Promise<object> {
    exec.signal.throwIfAborted()
    if (request.method === 'init_story_faithful' || request.method === 'fork_story_faithful') {
      if (this.storyFaithfulMode === 'disabled' || this.reviewMode !== 'self-check') throw Error('story_mode_disabled: 故事忠实视频创作须由显式启用的creation自检部署执行。')
      const authorization = HUMAN_AUTHORIZATION.parse(exec.authorization)
      if (authorization.session_id !== exec.actor || authorization.quote !== request.authorization_quote
        || authorization.consent_assessment !== request.consent_assessment || authorization.seq !== exec.latestUserSeq) {
        throw Error('story_human_authorization: 新作品须绑定当前真实用户本人请求；研发讨论或历史作品授权不能授予未来作品。')
      }
      const videos = []
      for (const video of request.videos) {
        const target = await this.target(video.path, exec)
        const info = await this.fs.stat(target, exec.signal)
        if (info?.type !== 'file' || info.version !== video.source_version) throw Error('story_video_version: 作品须绑定当前实际视频原件版本。')
        const episode = video.episode ?? (request.videos.length === 1 && request.episodes.length === 1 ? request.episodes[0] : undefined)
        if (episode === undefined || !request.episodes.includes(episode)) throw Error('story_video_episode: 多视频或多集作品须明确每个原视频对应的获授权集号，本轮不支持同片跨集裁剪。')
        videos.push({ path: this.fs.processPath(target), source_version: info.version, episode })
      }
      let original: Loaded | undefined
      if (request.method === 'fork_story_faithful') {
        original = await this.load(request.project, exec)
        await this.verifySources(original.project, exec, original.validated)
        if (request.expected_revision !== original.project.revision) throw Error('stale_revision: 原项目已经变更，请读回实际版本。')
        if (original.project.refinement !== undefined || original.project.story_policy !== undefined) throw Error('story_fork_original: 变更目标须从保留的原始项目建立新授权分支，不能把旧精修策略静默降级。')
        if (request.before_episode < 1 || request.before_episode > original.project.accepted.length + 1) throw Error('revision_episode: 只能从已验收集或下一集建立修订分支。')
      }
      const policy = STORY_POLICY.parse({ version: 'story-faithful-v2', sha256: '0'.repeat(64), work_title: request.work_title,
        videos, scope: { episodes: request.episodes, instructions: request.scope_instructions },
        allowed_categories: request.allowed_categories, authorization })
      if (original !== undefined && request.method === 'fork_story_faithful') {
        const inputs = request.baseline_candidate_ids.map((id) => {
          const candidate = original.project.candidates.find(value => value.id === id)
          if (candidate === undefined || !request.episodes.includes(candidate.episode)) throw Error('story_input_candidate: 输入须为实际存在且在授权范围的候选，不要求完整逐字稿。')
          return JSON.stringify(candidate)
        })
        if (original.project.workflow !== undefined) policy.legacy_workflow = original.project.workflow
        policy.legacy_context_sha256 = sha256(JSON.stringify({ mode: original.project.mode, instructions: original.project.instructions,
          ...(original.project.workflow === undefined ? {} : { workflow: original.project.workflow }),
          ...(original.project.review_mode === undefined ? {} : { review_mode: original.project.review_mode }) }))
        policy.original_facts = original.project.facts.map(fact => ({ id: fact.id, sha256: factDigest(fact) }))
        policy.original_sources = original.project.sources.map(source => ({ id: source.id, sha256: source.sha256,
          index_sha256: sha256(JSON.stringify({ units: source.units, video: source.video })) }))
        policy.retained_candidates = acceptedCandidates(original.project).slice(0,
          request.before_episode - 1).map(candidate => ({ id: candidate.id, sha256: candidate.sha256 }))
        policy.input_candidates = inputs
      }
      policy.sha256 = storyPolicyDigest(STORY_POLICY.parse(policy))
      const now = new Date().toISOString()
      const project = PROJECT_FILE.parse({ format_version: 1, id: `p:${randomUUID()}`, revision: 0, mode: 'faithful',
        instructions: request.scope_instructions, workflow: 'video_to_screenplay', review_mode: 'self-check', story_policy: policy, story_inventories: [],
        created_at: now, updated_at: now, sources: [], facts: [], candidates: [], accepted: [] })
      if (original !== undefined && request.method === 'fork_story_faithful') {
        project.sources = structuredClone(original.project.sources)
        for (const source of project.sources) {
          const link = request.source_links.find(value => value.source_id === source.id)
          const path = source.video?.path ?? link?.video_path
          if (path === undefined) throw Error('story_source_scope: 旧ASR/文字来源须明确关联获授权原视频。')
          source.story_video_path = this.fs.processPath(await this.target(path, exec))
        }
        project.facts = structuredClone(original.project.facts)
        project.candidates = acceptedCandidates(original.project).slice(0, request.before_episode - 1)
        project.accepted = project.candidates.map(candidate => candidate.id)
        project.parent = { id: original.project.id, path: original.target.displayPath, revision: original.project.revision,
          before_episode: request.before_episode, sha256: original.sha256 }
      }
      validateStoryPolicy(project)
      await this.fs.writeText(await this.target(request.method === 'fork_story_faithful' ? request.destination : request.project, exec), this.serialize(project), { kind: 'createIfAbsent' }, exec.signal, exec.policy)
      return this.status(project)
    }
    if (request.method === 'init') {
      if (!request.instructions.trim()) throw Error('missing_direction: 请先记录用户的改编方向和交付标准。')
      const now = new Date().toISOString()
      const project = PROJECT_FILE.parse({ format_version: 1, id: `p:${randomUUID()}`, revision: 0, mode: request.mode,
        instructions: request.instructions, ...(request.workflow === undefined ? {} : { workflow: request.workflow }),
        ...(this.reviewMode === 'self-check' ? { review_mode: 'self-check' } : {}),
        created_at: now, updated_at: now, sources: [], facts: [], candidates: [], accepted: [] })
      await this.fs.writeText(await this.target(request.project, exec), this.serialize(project), { kind: 'createIfAbsent' }, exec.signal, exec.policy)
      return this.status(project)
    }
    const loaded = await this.load(request.project, exec)
    const project = loaded.project
    if ((request.method === 'propose_story_inventory' || request.method === 'review_story_inventory'
      || (project.story_policy !== undefined && 'expected_revision' in request)) && this.storyFaithfulMode === 'disabled') {
      throw Error('story_mode_disabled: 故事忠实写入须明确启用story-faithful-v2。')
    }
    if (request.method === 'fork_refinement' && project.story_policy !== undefined) throw Error('story_policy_exclusive: 故事忠实与保源V1策略不可混合。')
    if (request.method === 'fork_refinement' && this.refinementMode === 'disabled') throw Error('refinement_disabled: 当前部署未启用精修分支。')
    if (project.refinement !== undefined && 'expected_revision' in request && this.refinementMode === 'disabled') {
      throw Error('refinement_disabled: 精修写入须由明确启用精修的创作部署执行。')
    }
    await this.verifySources(project, exec, loaded.validated)
    if (!loaded.validated) {
      if (project.candidates.some(candidate => project.accepted.includes(candidate.id) && candidate.story_adaptation !== undefined)) {
        const verifyStoryApproval = exec.verifyStoryApproval
        if (exec.verifyStoryVideo === undefined || verifyStoryApproval === undefined) throw Error('story_accepted_evidence_pending: 读取已验收故事作品须核原检查与成功C轮日志。')
        await validateAcceptedStoryEvidence(project, exec.verifyStoryVideo, candidate => verifyStoryApproval(project, candidate))
      }
      this.cached = { hash: loaded.sha256, project: structuredClone(project), knowledge: structuredClone(loaded.knowledge) }
    }
    if ('expected_revision' in request && request.expected_revision !== project.revision) {
      throw Error(`stale_revision: 预期 ${request.expected_revision}，实际 ${project.revision}；重读 status 后重新决定。`)
    }
    const observe = (reads: ProjectReadReceipt['reads']): void => {
      if (project.review_mode === 'self-check' && exec.step !== undefined) exec.observeRead?.({ project_id: project.id,
        project_sha256: loaded.sha256, revision: project.revision, actor: exec.actor, step: exec.step, reads })
    }
    const creation = (): { created_step?: SessionSeq } => {
      if (project.review_mode !== 'self-check') return {}
      if (this.reviewMode !== 'self-check') throw Error('self_check_mode: 此项目须由明确启用自检的创作模式编写；不能用项目字段降低当前模式要求。')
      if (exec.step === undefined) throw Error('self_check_step: 自检项目编写须来自正在执行的真实模型轮。')
      return { created_step: exec.step }
    }
    const reviewEvidence = (subject: ProjectFile['facts'][number] | ProjectFile['candidates'][number], kind: 'fact' | 'candidate') => {
      if (project.review_mode !== 'self-check') return {}
      if (this.reviewMode !== 'self-check') throw Error('self_check_mode: 当前工具未启用自检，不能写入自检审批。')
      return { kind: 'self-check' as const, evidence: selfCheckEvidence(project, loaded.sha256, subject, kind, exec.actor, exec.step, exec.receipts ?? []) }
    }
    if (project.story_policy !== undefined && ['review_story_inventory', 'stage', 'stage_files', 'review', 'commit', 'export'].includes(request.method)) {
      const inventoryId = 'inventory_id' in request ? request.inventory_id
        : 'candidate_id' in request ? project.candidates.find(candidate => candidate.id === request.candidate_id)?.story_adaptation?.inventory_id
          : 'story_notes' in request ? request.story_notes.inventory_id : undefined
      const inventory = project.story_inventories?.find(value => value.id === inventoryId)
      const ids = new Set(inventory?.coverage.windows.map(window => window.source_id) ?? [])
      for (const source of project.sources) if (ids.has(source.id) && source.video !== undefined) {
        if (exec.verifyStoryVideo === undefined || source.trusted_video_manifest === undefined || source.trusted_video_receipt === undefined) throw Error('story_video_evidence_pending: 本集真实检查尚未恢复，继续probe/抽帧/实际读图后重试。')
        await exec.verifyStoryVideo(source.trusted_video_manifest, source.trusted_video_receipt)
      }
    }
    switch (request.method) {
      case 'status': {
        const evidencePending: string[] = []
        const active = (project.story_inventories ?? []).filter(inventory => inventory.episode >= project.accepted.length + 1
          && !project.candidates.some(candidate => project.accepted.includes(candidate.id)
          && candidate.story_adaptation?.inventory_id === inventory.id))
        const sourceIds = new Set(active.flatMap(inventory => inventory.coverage.windows.map(window => window.source_id)))
        for (const inventory of active) {
          evidencePending.push(...storyEvidencePending(project, inventory))
          if (inventory.superseded_at_revision !== undefined) evidencePending.push(`${inventory.id} 补帧/来源更正后已失效，须新清单。`)
          for (const item of inventory.items) if (item.critical && item.evidence === 'unverified') evidencePending.push(`${inventory.id}/${item.id} 关键证据尚未核实。`)
        }
        for (const source of project.sources) if (sourceIds.has(source.id) && source.video !== undefined) {
          if (exec.verifyStoryVideo === undefined || source.trusted_video_manifest === undefined) evidencePending.push(`${source.id} 当前实际检查未恢复，须重新inspect与实际读图。`)
          else {
            try { await exec.verifyStoryVideo(source.trusted_video_manifest, source.trusted_video_receipt) } catch (error) {
              if (!(error instanceof Error) || !error.message.includes('video_evidence_pending')) throw error
              evidencePending.push(`${source.id} 当前实际检查未恢复，须重新inspect与实际读图。`)
            }
          }
        }
        return { ...this.status(project, loaded.knowledge),
          ...(project.story_policy === undefined ? {} : { evidence_pending: [...new Set(evidencePending)] }) }
      }
      case 'propose_story_inventory': {
        if (project.story_policy === undefined || request.episode !== project.accepted.length + 1) throw Error('story_inventory_scope: 仅准备已授权作品的当前下一集。')
        const created = creation()
        const inventory = STORY_INVENTORY.parse({ id: `i:${randomUUID()}`, sha256: '0'.repeat(64), policy_sha256: project.story_policy.sha256,
          scope_sha256: '0'.repeat(64), episode: request.episode, coverage: request.coverage, items: request.items, not_applicable: request.not_applicable,
          author: exec.actor, created_at: new Date().toISOString(), created_step: created.created_step })
        inventory.scope_sha256 = storyScopeDigest(project, inventory)
        inventory.sha256 = inventoryDigest(inventory)
        validateInventory(project, inventory)
        project.story_inventories ??= []
        project.story_inventories.push(inventory)
        await this.save(loaded, exec)
        return { revision: project.revision, inventory }
      }
      case 'read_story_inventory': {
        const inventory = project.story_inventories?.find(value => value.id === request.inventory_id)
        if (inventory === undefined) throw Error('story_inventory_required: 清单不存在。')
        observe(inventoryReads(project, inventory).filter(read => read.kind !== 'source'))
        return { revision: project.revision, story_policy: project.story_policy, inventory,
          facts: project.facts.filter(fact => inventoryReads(project, inventory).some(read => read.kind === 'fact' && read.id === fact.id)) }
      }
      case 'review_story_inventory': {
        const inventory = project.story_inventories?.find(value => value.id === request.inventory_id)
        if (inventory === undefined || inventory.sha256 !== request.inventory_sha256 || inventory.review !== undefined
          || inventory.superseded_at_revision !== undefined) throw Error('story_inventory_review_state: 清单不存在、摘要不符、已审校或补帧后已失效。')
        validateInventory(project, inventory)
        if (!request.reason.trim()) throw Error('review_reason: 清单审校须核对实际故事事件、来源与未知项。')
        if (request.decision === 'approve' && (inventory.items.some(item => item.critical && item.evidence !== 'confirmed') || storyEvidencePending(project, inventory).length > 0)) throw Error('story_evidence_pending: 关键来源尚未核实，保留pending并继续复看。')
        inventory.review = { actor: exec.actor, time: new Date().toISOString(), decision: request.decision, reason: request.reason,
          kind: 'self-check', evidence: inventoryEvidence(project, loaded.sha256, inventory, exec.actor, exec.step, exec.receipts ?? []) }
        await this.save(loaded, exec)
        return { revision: project.revision, inventory }
      }
      case 'fork_refinement': {
        if (project.refinement !== undefined) throw Error('refinement_original_project: 请从保留的原项目建立新授权分支；同一分支可继续提交候选。')
        if (!request.scope_instructions.trim() || !request.consent_assessment.trim()) throw Error('refinement_scope: 请记录明确范围及每个获准类别的用户授权语义判断。')
        if (exec.authorization === undefined) throw Error('refinement_human_authorization: 需要当前可见真实用户消息的 Host 授权证据。')
        const authorization = HUMAN_AUTHORIZATION.parse(exec.authorization)
        if (authorization.session_id !== exec.actor || authorization.quote !== request.authorization_quote
          || authorization.consent_assessment !== request.consent_assessment) throw Error('refinement_human_authorization: 须引用当前可见的真实用户指令，附件、工具与模型声明不能授权。')
        const baselines = request.baseline_candidate_ids.map((id) => {
          const candidate = project.candidates.find(candidate => candidate.id === id)
          if (candidate === undefined) throw Error('refinement_baseline: 精修须绑定项目中实际存在的候选版本。')
          return candidate
        }).sort((a, b) => a.episode - b.episode)
        const first = baselines[0]
        if (first === undefined || baselines.some((candidate, index) => candidate.episode !== first.episode + index)
          || first.episode > project.accepted.length + 1) throw Error('refinement_scope: 使用非空、连续的实际基线集号。')
        const beforeEpisode = first.episode
        const candidates = acceptedCandidates(project).slice(0, beforeEpisode - 1)
        const policy = REFINEMENT_POLICY.parse({ version: 'source-preserving-v1', sha256: '0'.repeat(64),
          source_project: { id: project.id, path: loaded.target.displayPath, revision: project.revision, sha256: loaded.sha256 },
          baselines, retained_candidates: candidates.map(candidate => ({ id: candidate.id, sha256: candidate.sha256 })),
          original_facts: project.facts.map(fact => ({ id: fact.id, sha256: factDigest(fact) })),
          original_sources: project.sources.map(source => ({ id: source.id, sha256: sha256(JSON.stringify(source)) })),
          scope: { episodes: baselines.map(candidate => candidate.episode), instructions: request.scope_instructions },
          allowed_categories: request.allowed_categories, authorization })
        policy.sha256 = refinementPolicyDigest(policy)
        const now = new Date().toISOString()
        const branch = PROJECT_FILE.parse({ ...project, id: `p:${randomUUID()}`, revision: 0, created_at: now, updated_at: now,
          parent: { id: project.id, path: loaded.target.displayPath, revision: project.revision,
            before_episode: beforeEpisode, sha256: loaded.sha256 }, refinement: policy,
          candidates, accepted: candidates.map(candidate => candidate.id) })
        validateRefinementPolicy(branch)
        await this.fs.writeText(await this.target(request.destination, exec), this.serialize(branch), { kind: 'createIfAbsent' }, exec.signal, exec.policy)
        return this.status(branch)
      }
      case 'fork_project': {
        if (request.before_episode < 1 || request.before_episode > project.accepted.length + 1) {
          throw Error('revision_episode: 修订从已验收集号或下一集开始，不能跳过未写集数。')
        }
        const candidates = acceptedCandidates(project).slice(0, request.before_episode - 1)
        const now = new Date().toISOString()
        const branch = PROJECT_FILE.parse({ ...project, id: `p:${randomUUID()}`, revision: 0, created_at: now, updated_at: now,
          parent: { id: project.id, path: loaded.target.displayPath, revision: project.revision,
            before_episode: request.before_episode, sha256: loaded.sha256 },
          candidates, accepted: candidates.map(candidate => candidate.id) })
        await this.fs.writeText(await this.target(request.destination, exec), this.serialize(branch), { kind: 'createIfAbsent' }, exec.signal, exec.policy)
        return this.status(branch)
      }
      case 'read_fact': {
        const fact = project.facts.find(fact => fact.id === request.fact_id)
        if (fact === undefined) throw Error('missing_fact: 事实编号不存在。')
        observe([{ kind: 'fact', id: fact.id, sha256: factDigest(fact) }])
        return { revision: project.revision, fact }
      }
      case 'list_facts': {
        if (request.start < 1 || request.count < 1 || request.count > this.limits.maxReadUnits
          || request.start > Math.max(1, project.facts.length)) {
          throw Error('fact_window: 使用 1 起始编号及配置预算内的读取数量。')
        }
        const facts: ProjectFile['facts'] = []
        let bytes = 2
        if (bytes > this.limits.maxReadBytes) throw Error('fact_window_bytes: 内容超过读取预算，请缩小窗口。')
        for (const fact of project.facts.slice(request.start - 1, request.start - 1 + request.count)) {
          const encodedBytes = Buffer.byteLength(JSON.stringify(fact), 'utf8') + (facts.length === 0 ? 0 : 1)
          if (bytes + encodedBytes > this.limits.maxReadBytes) {
            if (facts.length === 0) throw Error('fact_window_bytes: 单条事实超过读取预算，请调整配置后重试。')
            break
          }
          facts.push(fact)
          bytes += encodedBytes
        }
        observe(facts.map(fact => ({ kind: 'fact', id: fact.id, sha256: factDigest(fact) })))
        return { revision: project.revision, facts,
          next: request.start - 1 + facts.length < project.facts.length ? request.start + facts.length : null }
      }
      case 'read_candidate': {
        const candidate = project.candidates.find(candidate => candidate.id === request.candidate_id)
        if (candidate === undefined) throw Error('missing_candidate: 候选版本编号不存在。')
        const preceding = { ...project, accepted: project.accepted.slice(0, candidate.base_episode) }
        observe(requiredReads(project, candidate, 'candidate').filter(read => read.kind !== 'source'))
        return { revision: project.revision, candidate,
          ...(candidate.story_adaptation === undefined ? {} : { story_policy: project.story_policy,
            inventory: project.story_inventories?.find(value => value.id === candidate.story_adaptation?.inventory_id),
            input: candidate.story_adaptation.input_candidate_json }),
          ...(candidate.refinement === undefined ? {} : { baseline: project.refinement?.baselines
            .find(value => value.id === candidate.refinement?.baseline_candidate_id) }),
          facts: project.review_mode === 'self-check' ? candidateFacts(project, candidate)
            : project.facts.filter(fact => candidate.scenes.some(scene => scene.beats.some(beat => beat.fact_ids.includes(fact.id)))),
          rendered: renderEpisode(project, candidate.scenes, acceptedKnowledge(preceding), candidate.episode, candidate) }
      }
      case 'read_source': {
        const source = project.sources.find(source => source.id === request.source_id)
        if (source === undefined) {
          const complete = project.sources.filter(value => value.id === `${request.source_id}:${value.kind}`).map(value => value.id)
          throw Error('missing_source: 请使用 status 返回的来源编号。' + (complete.length === 0 ? ''
            : `编号须保留类型后缀；从 status.sources 选择完整 id：${complete.join('、')}。未读取来源。`))
        }
        if (request.start < 1 || request.count < 1 || request.count > this.limits.maxReadUnits || request.start > source.units.length) {
          throw Error('source_window: 使用 1 起始编号及配置预算内的读取数量。')
        }
        const units = source.units.slice(request.start - 1, request.start - 1 + request.count)
        if (Buffer.byteLength(JSON.stringify({ units, ...(source.video === undefined ? {} : { video: source.video }) }), 'utf8')
          > this.limits.maxReadBytes) throw Error('source_window_bytes: 内容超过读取预算，请缩小窗口。')
        const images = units.flatMap(unit => unit.image === undefined ? [] : [unit.image])
        if (images.length > this.attachments.imageLimits.maxImagesPerMessage
          || images.reduce((total, image) => total + image.bytes, 0) > this.attachments.imageLimits.maxMessageImageBytes) {
          throw Error('frame_window: 图像数量或字节超过附件提供方预算，请缩小读取窗口。')
        }
        for (const unit of units) if (unit.image !== undefined) await this.attachments.readImage(unit.image, exec.signal)
        observe(units.map(unit => sourceRead(source, unit)))
        return { revision: project.revision, source_id: source.id, source_sha256: source.sha256, units,
          ...(source.video === undefined ? {} : { video: source.video }),
          next: request.start - 1 + units.length < source.units.length ? request.start + units.length : null }
      }
      case 'import_source': {
        if (project.refinement !== undefined) throw Error('refinement_original_source: 精修仅使用已绑定的原来源；新来源需要新的范围授权。')
        const target = await this.target(request.path, exec)
        const bytes = await this.fs.readBytes(target, exec.signal, this.limits.maxSourceBytes)
        const hash = sha256(bytes)
        const id = brandString<SourceId>(`s:${hash}:${request.source_kind}`)
        if (project.sources.some(source => source.id === id)) throw Error('duplicate_source: 此文件已导入；使用已有来源编号。')
        const source: ProjectSource = { id, sha256: hash, path: this.fs.processPath(target), kind: request.source_kind,
          units: this.units(bytes, id, request.source_kind) }
        if (source.kind === 'video_inspection') {
          const input = await this.verifyVideo(bytes, exec)
          if (project.story_policy !== undefined) {
            if (exec.verifyStoryVideo === undefined) throw Error('story_video_evidence_pending: 先完成实际probe与图像模型观察，不能用JSON verified声明替代。')
            const manifest = z.json().parse(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)))
            source.trusted_video_manifest = manifest
            source.trusted_video_receipt = TRUSTED_VIDEO_INSPECTION_RECEIPT.parse(await exec.verifyStoryVideo(manifest))
          }
          source.video = VIDEO_SOURCE.strip().parse({ ...input, samples: input.frames.map(
            ({ requested_seconds, timestamp_seconds }) => ({ requested_seconds, timestamp_seconds })) })
          for (const frame of input.frames) await this.attachments.readImage(frame.image, exec.signal)
        }
        if (project.story_policy !== undefined) {
          const path = source.video?.path ?? ('story_video_path' in request ? request.story_video_path : undefined)
          if (path === undefined) throw Error('story_source_scope: ASR或文字来源须明确关联获授权原视频；帧清单由真实视频identity关联。')
          source.story_video_path = this.fs.processPath(await this.target(path, exec))
        }
        project.sources.push(source)
        validateStoryPolicy(project)
        for (const inventory of project.story_inventories ?? []) {
          const accepted = project.candidates.some(candidate => project.accepted.includes(candidate.id)
            && candidate.story_adaptation?.inventory_id === inventory.id)
          if (accepted) continue
          const overlap = inventory.coverage.windows.some((window) => {
            const old = project.sources.find(value => value.id === window.source_id)
            if ((old?.story_video_path ?? old?.video?.path) !== source.story_video_path) return false
            const range = window.interval ?? old?.video?.interval
            const added = source.video?.interval
            return range === undefined || added === undefined || range.start_seconds < added.end_seconds
              && added.start_seconds < range.end_seconds
          })
          if (overlap) inventory.superseded_at_revision = project.revision + 1
        }
        await this.save(loaded, exec)
        return { revision: project.revision, source: { ...source, units: source.units.length } }
      }
      case 'propose_fact':
      case 'propose_facts': {
        const inputs = request.method === 'propose_fact' ? [request.fact] : request.facts
        if (inputs.length < 1 || inputs.length > this.limits.maxFactBatch) {
          throw Error(`fact_batch: 本次批量事实 ${inputs.length} 条，允许 1–${this.limits.maxFactBatch} 条。`)
        }
        const units = new Map(project.sources.flatMap(source => source.units.map(unit => [unit.id, unit] as const)))
        const facts = inputs.map((input) => {
          this.validateFact(project, input, units)
          return FACT_RECORD.parse({ ...input, id: `f:${randomUUID()}`, proposer: exec.actor, created_at: new Date().toISOString(), ...creation() })
        })
        project.facts.push(...facts)
        for (const inventory of project.story_inventories ?? []) {
          const accepted = project.candidates.some(candidate => project.accepted.includes(candidate.id)
            && candidate.story_adaptation?.inventory_id === inventory.id)
          const sourceUnits = new Set(inventoryReads(project, inventory).filter(read => read.kind === 'source').map(read => read.id))
          if (!accepted && facts.some(fact => fact.origin === 'source' && fact.anchors.some(anchor => sourceUnits.has(anchor.unit_id)))) inventory.superseded_at_revision = project.revision + 1
        }
        await this.save(loaded, exec)
        return request.method === 'propose_fact' ? { revision: project.revision, fact: facts[0] } : { revision: project.revision, facts }
      }
      case 'review_fact':
      case 'review_facts': {
        const reviews = request.method === 'review_fact' ? [request] : request.reviews
        if (reviews.length < 1 || reviews.length > this.limits.maxFactBatch) {
          throw Error(`fact_batch: 本次批量审校 ${reviews.length} 条，允许 1–${this.limits.maxFactBatch} 条。`)
        }
        if (new Set(reviews.map(review => review.fact_id)).size !== reviews.length) throw Error('duplicate_review: 同一批次不可重复审校事实。')
        const facts = reviews.map((review) => {
          const fact = project.facts.find(fact => fact.id === review.fact_id)
          if (fact === undefined || fact.review !== undefined) throw Error('fact_review_state: 事实不存在或已审校，请提交新的修订事实。')
          if (project.review_mode !== 'self-check' && fact.proposer === exec.actor) throw Error('self_review: 事实提交者不能自行批准，交由主会话或独立审校会话核对原文。')
          if (!review.reason.trim()) throw Error('review_reason: 审校须说明来源归属、语义和人物身份的核对结果。')
          fact.review = { actor: exec.actor, time: new Date().toISOString(), decision: review.decision, reason: review.reason,
            ...reviewEvidence(fact, 'fact') }
          return fact
        })
        await this.save(loaded, exec)
        return request.method === 'review_fact' ? { revision: project.revision, fact: facts[0] } : { revision: project.revision, facts }
      }
      case 'withdraw_fact': {
        const fact = project.facts.find(item => item.id === request.fact_id)
        if (fact === undefined || fact.review?.decision !== 'approve') throw Error('fact_approval: 仅可撤销已批准的事实。')
        if (fact.withdrawal !== undefined) throw Error('fact_withdrawn: 该事实已经撤销。')
        if ((project.review_mode !== 'self-check' || fact.review.kind !== 'self-check') && fact.proposer === exec.actor) {
          throw Error('self_review: 独立审校事实的提交者不能自行撤销审批。')
        }
        if (!request.reason.trim()) throw Error('review_reason: 请记录事实错误及其来源核对。')
        if (project.candidates.some(candidate => referencesFact(candidate, fact.id))) {
          throw Error('fact_in_history: 事实已被候选引用；先 fork_project 到最早受影响集之前，再撤销并重提事实。')
        }
        const selfCheck = project.review_mode === 'self-check' && fact.review.kind === 'self-check'
        if (selfCheck && this.reviewMode !== 'self-check') throw Error('self_check_mode: 当前工具未启用自检，不能写入自检撤销。')
        fact.withdrawal = { actor: exec.actor, time: new Date().toISOString(), reason: request.reason,
          ...(selfCheck ? { kind: 'self-check' as const, evidence: selfCheckEvidence(project, loaded.sha256, fact, 'fact', exec.actor,
            exec.step, exec.receipts ?? [], fact.review.evidence?.review_step) } : {}) }
        for (const inventory of project.story_inventories ?? []) {
          const units = new Set(inventoryReads(project, inventory).filter(read => read.kind === 'source').map(read => read.id))
          if (fact.origin === 'source' && fact.anchors.some(anchor => units.has(anchor.unit_id))) {
            inventory.superseded_at_revision ??= project.revision + 1
          }
        }
        await this.save(loaded, exec)
        return { revision: project.revision, fact }
      }
      case 'stage':
      case 'stage_files': {
        if (request.episode !== project.accepted.length + 1) throw Error('episode_order: 仅可起草下一集；前一集须先验收。')
        const scenes: ProjectFile['candidates'][number]['scenes'] = request.method === 'stage'
          ? SCENE_RECORD.array().parse(request.scenes) : []
        if (request.method === 'stage_files') {
          if (request.files.length === 0 || request.files.length > this.limits.maxReadUnits) {
            throw Error('scene_files: 按配置预算提供非空、有序的场次 JSON 文件列表。')
          }
          const inputs: { target: FsTarget; version: FsVersion }[] = []
          for (const path of request.files) {
            const target = await this.target(path, exec)
            if (inputs.some(input => input.target.displayPath === target.displayPath)) throw Error('duplicate_scene_file: 场次文件不可重复。')
            const info = await this.fs.stat(target, exec.signal)
            if (info?.type !== 'file') throw Error(`scene_file_missing: 场次 JSON 文件不可用：${target.displayPath}`)
            const bytes = await this.fs.readBytes(target, exec.signal, this.limits.maxReadBytes)
            let input: unknown
            try { input = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) }
            catch (error) {
              throw Error(`scene_file_json: 场次文件 ${target.displayPath} 须为有效 UTF-8 JSON：${String(error)}`, { cause: error })
            }
            const scene = SCENE_RECORD.safeParse(input)
            if (!scene.success) {
              const issues = scene.error.issues.map(issue => `${issue.path.length === 0 ? 'root' : issue.path.map(String).join('.')}: ${issue.message}`)
              throw Error(`scene_file_invalid: 场次文件 ${target.displayPath} 不符合完整场次字段要求：\n${issues.join('\n')}`)
            }
            scenes.push(scene.data)
            inputs.push({ target, version: info.version })
          }
          for (const input of inputs) {
            if ((await this.fs.stat(input.target, exec.signal))?.version !== input.version) {
              throw Error('scene_file_changed: 场次文件在组稿期间变更，请读回后重试。')
            }
          }
        }
        const candidate = CANDIDATE_RECORD.parse({ id: `c:${randomUUID()}`,
          sha256: sha256(JSON.stringify({ episode: request.episode, scenes })),
          episode: request.episode, base_episode: project.accepted.length, author: exec.actor,
          created_at: new Date().toISOString(), ...creation(), scenes, source_ids: project.sources.map(source => source.id),
          ...(request.coverage === undefined ? {} : { coverage: request.coverage }) })
        const storyNotes = 'story_notes' in request ? request.story_notes : undefined
        if (project.story_policy !== undefined) {
          if (storyNotes === undefined) throw Error('story_report_required: 故事忠实作品须实际source/scene/beat映射与独立说明。')
          candidate.source_ids = [...new Set(request.coverage?.windows.map(window => window.source_id) ?? [])]
          candidate.story_adaptation = buildStoryAdaptation(project, candidate, storyNotes)
        } else if (storyNotes !== undefined) throw Error('story_policy_required: mode/reason不能自行开启故事忠实策略。')
        const notes = 'modification_notes' in request ? request.modification_notes : undefined
        if (project.refinement !== undefined) {
          if (notes === undefined) throw Error('refinement_report_required: 精修候选须附实际修改说明。')
          const baseline = project.refinement.baselines.find(value => value.episode === candidate.episode)
          if (baseline === undefined) throw Error('refinement_scope: 本集不在实际获准基线范围内。')
          if (baseline.source_ids === undefined) delete candidate.source_ids
          else candidate.source_ids = [...baseline.source_ids]
          candidate.refinement = buildRefinement(project, candidate, notes)
        } else if (notes !== undefined) throw Error('refinement_policy_required: 先从实际基线建立获授权的精修分支。')
        candidate.sha256 = candidateDigest(candidate)
        checkVideoCoverage(project, candidate)
        const rendered = renderEpisode(project, candidate.scenes, loaded.knowledge, candidate.episode, candidate)
        project.candidates.push(candidate)
        await this.save(loaded, exec)
        return { revision: project.revision, candidate, rendered }
      }
      case 'review': {
        const candidate = project.candidates.find(candidate => candidate.id === request.candidate_id)
        if (candidate === undefined || candidate.review !== undefined || candidate.sha256 !== request.candidate_sha256) throw Error('candidate_review_state: 版本不存在、摘要不符或已审校；修订须新建版本。')
        if (candidate.base_episode !== project.accepted.length) throw Error('candidate_base_changed: 前集已经推进，须基于当前验收状态提交新版本。')
        if (project.review_mode !== 'self-check' && candidate.author === exec.actor) throw Error('self_review: 编写会话不能自行验收该版本。')
        if (!request.reason.trim()) throw Error('review_reason: 请记录来源、人物、时间、场次与改编语义的核对结果。')
        renderEpisode(project, candidate.scenes, loaded.knowledge, candidate.episode, candidate)
        if (checkVideoCoverage(project, candidate) && request.decision === 'approve' && !request.zero_action_reason?.trim()) {
          throw Error('zero_action_review_required: 请记录本集实际画面复核和确无关键动作遗漏的依据。')
        }
        const semanticInput = 'semantic_report' in request ? request.semantic_report : undefined
        if (project.story_policy !== undefined && semanticInput === undefined) throw Error('story_semantic_required: C轮须提交本集完整定位语义复原报告。')
        if (project.story_policy === undefined && semanticInput !== undefined) throw Error('story_policy_required: 旧项目不接受V2语义报告替代旧审批。')
        const semantic = semanticInput === undefined ? undefined : buildSemanticReport(project, candidate, semanticInput)
        if (semantic !== undefined) validateSemanticReport(project, candidate, semantic, request.decision === 'approve')
        validateStoryCandidate(project, candidate, request.decision === 'approve')
        candidate.review = { actor: exec.actor, time: new Date().toISOString(), decision: request.decision, reason: request.reason,
          ...reviewEvidence(candidate, 'candidate'), ...(semantic === undefined ? {} : { semantic_report: semantic }) }
        if (semantic !== undefined && request.decision === 'approve') candidate.review.story_acceptance = buildStoryAcceptance(project, candidate)
        if (request.zero_action_reason !== undefined) candidate.review.zero_action_reason = request.zero_action_reason.trim()
        await this.save(loaded, exec)
        return { revision: project.revision, candidate,
          rendered: renderEpisode(project, candidate.scenes, loaded.knowledge, candidate.episode, candidate) }
      }
      case 'commit': {
        const candidate = project.candidates.find(candidate => candidate.id === request.candidate_id)
        if (candidate === undefined || candidate.sha256 !== request.candidate_sha256) throw Error('candidate_digest: 请使用当前候选版本和摘要。')
        if (candidate.story_adaptation !== undefined) {
          if (exec.verifyStoryApproval === undefined) throw Error('story_approval_log_pending: commit须核C轮成功工具及outer日志。')
          await exec.verifyStoryApproval(project, candidate)
        }
        if (candidate.review?.decision !== 'approve' || !validReview(project, candidate, 'candidate')) throw Error('review_required: 有效审校通过后才可验收。')
        if (candidate.base_episode !== project.accepted.length || candidate.episode !== project.accepted.length + 1
          || candidate.committed_at !== undefined) {
          throw Error('episode_order: 版本已提交或基于过期前集，请从 status 恢复下一集。')
        }
        renderEpisode(project, candidate.scenes, loaded.knowledge, candidate.episode, candidate)
        checkVideoCoverage(project, candidate)
        candidate.committed_at = new Date().toISOString()
        project.accepted.push(candidate.id)
        await this.save(loaded, exec)
        return this.status(project)
      }
      case 'export': {
        const candidate = project.candidates.find(candidate => candidate.id === request.candidate_id)
        if (candidate === undefined || !project.accepted.includes(candidate.id)) throw Error('export_unaccepted: 只能交付已验收版本。')
        checkVideoCoverage(project, candidate)
        if (candidate.story_adaptation !== undefined) {
          if (exec.verifyStoryApproval === undefined) throw Error('story_approval_log_pending: 正式导出须核成功C轮原日志。')
          await exec.verifyStoryApproval(project, candidate)
        }
        const index = project.accepted.indexOf(candidate.id)
        const before = { ...project, accepted: project.accepted.slice(0, index) }
        const rendered = renderEpisode(project, candidate.scenes, acceptedKnowledge(before), candidate.episode, candidate)
        const basename = `episode-${candidate.episode}-${candidate.id.slice(2)}`
        const sourceRows = project.sources.filter(source => candidate.source_ids === undefined
          || candidate.source_ids.includes(source.id)).map(source => ({ id: source.id, path: source.path, sha256: source.sha256 }))
        const report = rendered.modification_notes
        const reportMetadata = report === undefined ? {} : { modification_notes: {
          file: `${basename}.modification-notes.md`, sha256: sha256(report) } }
        const sidecar = {
          candidate_id: candidate.id, candidate_sha256: candidate.sha256,
          created_at: candidate.created_at, committed_at: candidate.committed_at,
          review: candidate.review, lines: rendered.lines, knowledge: rendered.knowledge,
          ...(candidate.story_adaptation === undefined ? {} : { story_adaptation: candidate.story_adaptation,
            story_policy: project.story_policy, semantic_report: candidate.review?.semantic_report, ...reportMetadata }),
          ...(candidate.refinement === undefined ? {} : { refinement: candidate.refinement, ...reportMetadata }),
          ...(candidate.source_ids === undefined || candidate.coverage === undefined ? {} : {
            visual_coverage: candidate.coverage.windows.flatMap((window) => {
              const source = project.sources.find(source => source.id === window.source_id)
              return source?.video === undefined ? [] : [{ source_id: source.id, ...source.video }]
            }),
          }),
          sources: sourceRows,
        }
        const encodeSidecar = (sources: typeof sourceRows) => `${JSON.stringify({ ...sidecar, sources }, null, 2)}\n`
        const reportPath = `${request.directory}/${basename}.modification-notes.md`
        const files = [
          { path: `${request.directory}/${basename}.md`, content: rendered.script },
          ...(report === undefined ? [] : [{ path: reportPath, content: report }]),
          { path: `${request.directory}/${basename}.sources.json`, content: encodeSidecar(sourceRows) },
        ]
        for (const file of files) {
          const target = await this.target(file.path, exec)
          try {
            await this.fs.writeText(target, file.content, { kind: 'createIfAbsent' }, exec.signal, exec.policy)
          } catch (error) {
            if (!(error instanceof FsError) || error.code !== 'FS_NOT_OBSERVED') throw error
            const existing = await this.fs.readText(target, exec.signal)
            if (existing === file.content) continue
            if (candidate.source_ids === undefined && file.path.endsWith('.sources.json')) {
              let prior: unknown
              try { prior = JSON.parse(existing) } catch (error) {
                throw Error('export_changed: 导出文件已修改，请使用新的交付目录。', { cause: error })
              }
              if (typeof prior === 'object' && prior !== null && 'sources' in prior && Array.isArray(prior.sources)) {
                const prefix = sourceRows.slice(0, prior.sources.length)
                const retained = new Set(project.sources.slice(0, prior.sources.length)
                  .flatMap(source => source.units.map(unit => unit.id)))
                if (rendered.lines.every(line => line.source_units.every(id => retained.has(brandString<UnitId>(id))))
                  && existing === encodeSidecar(prefix)) continue
              }
            }
            throw Error('export_changed: 导出文件已修改，请使用新的交付目录。')
          }
        }
        return { revision: project.revision, candidate_id: candidate.id, ...(candidate.review?.kind === 'self-check' ? { review_kind: 'self-check' } : {}), files: files.map(file => file.path) }
      }
      /* v8 ignore next -- the registry validates the closed operation union before execution */
      default: return assertNever(request)
    }
  }
}
