/** Guarded project publication and independently reviewed episode commands. @module screenplay-project/project */

import { randomUUID } from 'node:crypto'
import type { FileSystem, FsTarget, FsVersion } from '@deepseek-ai/dsh-fs'
import { FsError } from '@deepseek-ai/dsh-fs'
import type { SandboxExecutionPolicy } from '@deepseek-ai/dsh-sandbox'
import type { AttachmentStore } from '@deepseek-ai/dsh-attachment'
import { assertNever } from '@deepseek-ai/dsh-util-values'
import { PROJECT_FILE, TRANSCRIPT, VIDEO_INSPECTION, FACT_RECORD, CANDIDATE_RECORD, SCENE_RECORD } from './schema.ts'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { ActorId, FactId, SourceId, UnitId } from './ids.ts'
import type { ProjectFile, ProjectRequest, ProjectSource } from './schema.ts'
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
  cwd?: string
  signal: AbortSignal
  policy?: SandboxExecutionPolicy
}

interface Loaded {
  target: FsTarget
  version: FsVersion
  sha256: string
  project: ProjectFile
}

function referencesFact(candidate: ProjectFile['candidates'][number], id: FactId): boolean {
  return candidate.scenes.some(scene => scene.beats.some(beat => beat.fact_ids.includes(id) || beat.requires_knowledge.includes(id)))
}

/** Project operations using the mounted filesystem; each mutation publishes one guarded JSON file. */
export class ProjectCommands {
  constructor(private readonly fs: FileSystem, private readonly limits: ProjectLimits, private readonly attachments: AttachmentStore) {}

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
    const project = PROJECT_FILE.parse(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)))
    const allIds = [project.id, ...project.sources.flatMap(source => [source.id, ...source.units.map(unit => unit.id)]),
      ...project.facts.map(fact => fact.id), ...project.candidates.map(candidate => candidate.id)]
    if (new Set(allIds).size !== allIds.length) throw Error('invalid_project: 重复的来源、事实或版本编号。')
    const units = new Map(project.sources.flatMap(source => source.units.map(unit => [unit.id, unit] as const)))
    for (const fact of project.facts) {
      this.validateFact(project, fact, units)
      if (fact.review?.actor === fact.proposer) throw Error('invalid_project: 事实由提交者自行批准。')
      if (fact.withdrawal !== undefined && (fact.review?.decision !== 'approve' || fact.withdrawal.actor === fact.proposer
        || project.candidates.some(candidate => referencesFact(candidate, fact.id)))) {
        throw Error('invalid_withdrawal: 撤销须独立进行，保留原批准记录且不能更改已有候选的事实。')
      }
    }
    for (const candidate of project.candidates) {
      if (candidate.sha256 !== candidateDigest(candidate)) {
        throw Error('invalid_candidate_digest: 正文结构和版本摘要不一致。')
      }
    }
    acceptedKnowledge(project)
    for (const candidate of acceptedCandidates(project)) checkVideoCoverage(project, candidate)
    return { target, version: before.version, sha256: sha256(bytes), project }
  }

  private validateFact(project: ProjectFile, fact: ProjectFile['facts'][number] | Extract<ProjectRequest, { method: 'propose_fact' }>['fact'],
    units: Map<string, ProjectSource['units'][number]>): void {
    if (fact.summary.trim().length === 0) throw Error('empty_fact: 事实摘要不可为空。')
    if ((fact.kind === 'speech' || fact.kind === 'thought') && !fact.actor?.trim()) throw Error('fact_actor: 发声与心理必须保留人物，未识别的人物使用稳定声音编号。')
    if (fact.kind === 'author_analysis' && (fact.actor !== undefined || fact.layer !== 'commentary')) {
      throw Error('author_attribution: 作者分析属于 commentary，不能指定为角色心理。')
    }
    if (fact.origin === 'adaptation') {
      if (project.mode !== 'adaptation' || !fact.adaptation_reason?.trim()) throw Error('adaptation_direction: 新增事实须在已确定改编模式下说明改编理由。')
    } else if (fact.anchors.length === 0) throw Error('missing_source: 来源事实须包含原文引用。')
    for (const anchor of fact.anchors) {
      const unit = units.get(anchor.unit_id)
      if (unit === undefined || anchor.quote.trim().length === 0 || !unit.text.includes(anchor.quote)) {
        throw Error(`source_quote_mismatch: ${anchor.unit_id} 的原文不包含引用；请 read_source 后重提。`)
      }
    }
  }

  private async verifySources(project: ProjectFile, exec: ProjectExecution): Promise<void> {
    for (const source of project.sources) {
      const bytes = await this.fs.readBytes(await this.target(source.path, exec), exec.signal, this.limits.maxSourceBytes)
      if (sha256(bytes) !== source.sha256) throw Error(`source_changed: ${source.path} 已变更；旧来源不能继续用于新验收。`)
      const expected = this.units(bytes, source.id, source.kind)
      if (JSON.stringify(expected) !== JSON.stringify(source.units)) throw Error('source_index_changed: 来源索引与原文件不一致。')
      if (source.kind === 'video_inspection') await this.verifyVideo(bytes, exec)
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

  private status(project: ProjectFile): object {
    return { project_id: project.id, revision: project.revision, mode: project.mode, instructions: project.instructions,
      ...(project.workflow === undefined ? {} : { workflow: project.workflow }),
      ...(project.parent === undefined ? {} : { parent: project.parent }),
      next_episode: project.accepted.length + 1,
      sources: project.sources.map(source => ({
        id: source.id, path: source.path, sha256: source.sha256, kind: source.kind, units: source.units.length,
      })),
      accepted: acceptedCandidates(project).map(candidate => ({
        id: candidate.id, episode: candidate.episode, sha256: candidate.sha256, committed_at: candidate.committed_at,
      })),
      fact_count: project.facts.length,
      pending: project.candidates.filter(candidate => candidate.committed_at === undefined)
        .slice(-this.limits.maxReadUnits).map(candidate => ({
          id: candidate.id, episode: candidate.episode, sha256: candidate.sha256, author: candidate.author, review: candidate.review,
        })), knowledge: acceptedKnowledge(project) }
  }

  /**
   * Execute one validated model command; identity and timestamps come from the host.
   * @param request - Registry-validated operation and data.
   * @param exec - Runtime actor, cancellation, cwd, and filesystem policy.
   * @returns Canonical operation result, logged by the tool registry.
   */
  async execute(request: ProjectRequest, exec: ProjectExecution): Promise<object> {
    exec.signal.throwIfAborted()
    if (request.method === 'init') {
      if (!request.instructions.trim()) throw Error('missing_direction: 请先记录用户的改编方向和交付标准。')
      const now = new Date().toISOString()
      const project = PROJECT_FILE.parse({ format_version: 1, id: `p:${randomUUID()}`, revision: 0, mode: request.mode,
        instructions: request.instructions, ...(request.workflow === undefined ? {} : { workflow: request.workflow }),
        created_at: now, updated_at: now, sources: [], facts: [], candidates: [], accepted: [] })
      await this.fs.writeText(await this.target(request.project, exec), this.serialize(project), { kind: 'createIfAbsent' }, exec.signal, exec.policy)
      return this.status(project)
    }
    const loaded = await this.load(request.project, exec)
    const project = loaded.project
    await this.verifySources(project, exec)
    if ('expected_revision' in request && request.expected_revision !== project.revision) {
      throw Error(`stale_revision: 预期 ${request.expected_revision}，实际 ${project.revision}；重读 status 后重新决定。`)
    }
    switch (request.method) {
      case 'status': return this.status(project)
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
        return { revision: project.revision, facts,
          next: request.start - 1 + facts.length < project.facts.length ? request.start + facts.length : null }
      }
      case 'read_candidate': {
        const candidate = project.candidates.find(candidate => candidate.id === request.candidate_id)
        if (candidate === undefined) throw Error('missing_candidate: 候选版本编号不存在。')
        const preceding = { ...project, accepted: project.accepted.slice(0, candidate.base_episode) }
        return { revision: project.revision, candidate,
          facts: project.facts.filter(fact => candidate.scenes.some(scene => scene.beats.some(beat => beat.fact_ids.includes(fact.id)))),
          rendered: renderEpisode(project, candidate.scenes, acceptedKnowledge(preceding), candidate.episode) }
      }
      case 'read_source': {
        const source = project.sources.find(source => source.id === request.source_id)
        if (source === undefined) throw Error('missing_source: 请使用 status 返回的来源编号。')
        if (request.start < 1 || request.count < 1 || request.count > this.limits.maxReadUnits || request.start > source.units.length) {
          throw Error('source_window: 使用 1 起始编号及配置预算内的读取数量。')
        }
        const units = source.units.slice(request.start - 1, request.start - 1 + request.count)
        if (Buffer.byteLength(JSON.stringify(units), 'utf8') > this.limits.maxReadBytes) throw Error('source_window_bytes: 内容超过读取预算，请缩小窗口。')
        const images = units.flatMap(unit => unit.image === undefined ? [] : [unit.image])
        if (images.length > this.attachments.imageLimits.maxImagesPerMessage
          || images.reduce((total, image) => total + image.bytes, 0) > this.attachments.imageLimits.maxMessageImageBytes) {
          throw Error('frame_window: 图像数量或字节超过附件提供方预算，请缩小读取窗口。')
        }
        for (const unit of units) if (unit.image !== undefined) await this.attachments.readImage(unit.image, exec.signal)
        return { revision: project.revision, source_id: source.id, source_sha256: source.sha256, units,
          next: request.start - 1 + units.length < source.units.length ? request.start + units.length : null }
      }
      case 'import_source': {
        const target = await this.target(request.path, exec)
        const bytes = await this.fs.readBytes(target, exec.signal, this.limits.maxSourceBytes)
        const hash = sha256(bytes)
        const id = brandString<SourceId>(`s:${hash}:${request.source_kind}`)
        if (project.sources.some(source => source.id === id)) throw Error('duplicate_source: 此文件已导入；使用已有来源编号。')
        const source: ProjectSource = { id, sha256: hash, path: this.fs.processPath(target), kind: request.source_kind,
          units: this.units(bytes, id, request.source_kind) }
        if (source.kind === 'video_inspection') {
          const input = await this.verifyVideo(bytes, exec)
          for (const frame of input.frames) await this.attachments.readImage(frame.image, exec.signal)
        }
        project.sources.push(source)
        await this.save(loaded, exec)
        return { revision: project.revision, source: { ...source, units: source.units.length } }
      }
      case 'propose_fact':
      case 'propose_facts': {
        const inputs = request.method === 'propose_fact' ? [request.fact] : request.facts
        if (inputs.length < 1 || inputs.length > this.limits.maxFactBatch) throw Error('fact_batch: 批量事实须非空且不超过配置预算。')
        const units = new Map(project.sources.flatMap(source => source.units.map(unit => [unit.id, unit] as const)))
        const facts = inputs.map((input) => {
          this.validateFact(project, input, units)
          return FACT_RECORD.parse({ ...input, id: `f:${randomUUID()}`, proposer: exec.actor, created_at: new Date().toISOString() })
        })
        project.facts.push(...facts)
        await this.save(loaded, exec)
        return request.method === 'propose_fact' ? { revision: project.revision, fact: facts[0] } : { revision: project.revision, facts }
      }
      case 'review_fact':
      case 'review_facts': {
        const reviews = request.method === 'review_fact' ? [request] : request.reviews
        if (reviews.length < 1 || reviews.length > this.limits.maxFactBatch) throw Error('fact_batch: 批量审校须非空且不超过配置预算。')
        if (new Set(reviews.map(review => review.fact_id)).size !== reviews.length) throw Error('duplicate_review: 同一批次不可重复审校事实。')
        const facts = reviews.map((review) => {
          const fact = project.facts.find(fact => fact.id === review.fact_id)
          if (fact === undefined || fact.review !== undefined) throw Error('fact_review_state: 事实不存在或已审校，请提交新的修订事实。')
          if (fact.proposer === exec.actor) throw Error('self_review: 事实提交者不能自行批准，交由主会话或独立审校会话核对原文。')
          if (!review.reason.trim()) throw Error('review_reason: 审校须说明来源归属、语义和人物身份的核对结果。')
          fact.review = { actor: exec.actor, time: new Date().toISOString(), decision: review.decision, reason: review.reason }
          return fact
        })
        await this.save(loaded, exec)
        return request.method === 'review_fact' ? { revision: project.revision, fact: facts[0] } : { revision: project.revision, facts }
      }
      case 'withdraw_fact': {
        const fact = project.facts.find(item => item.id === request.fact_id)
        if (fact === undefined || fact.review?.decision !== 'approve') throw Error('fact_approval: 仅可撤销已批准的事实。')
        if (fact.withdrawal !== undefined) throw Error('fact_withdrawn: 该事实已经撤销。')
        if (fact.proposer === exec.actor) throw Error('self_review: 事实提交者不能自行撤销审批。')
        if (!request.reason.trim()) throw Error('review_reason: 请记录事实错误及其来源核对。')
        if (project.candidates.some(candidate => referencesFact(candidate, fact.id))) {
          throw Error('fact_in_history: 事实已被候选引用；先 fork_project 到最早受影响集之前，再撤销并重提事实。')
        }
        fact.withdrawal = { actor: exec.actor, time: new Date().toISOString(), reason: request.reason }
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
            if (info?.type !== 'file') throw Error('scene_file_missing: 场次 JSON 文件不可用。')
            const bytes = await this.fs.readBytes(target, exec.signal, this.limits.maxReadBytes)
            scenes.push(SCENE_RECORD.parse(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))))
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
          created_at: new Date().toISOString(), scenes,
          ...(request.coverage === undefined ? {} : { coverage: request.coverage }) })
        candidate.sha256 = candidateDigest(candidate)
        checkVideoCoverage(project, candidate)
        const rendered = renderEpisode(project, candidate.scenes, acceptedKnowledge(project), candidate.episode)
        project.candidates.push(candidate)
        await this.save(loaded, exec)
        return { revision: project.revision, candidate, rendered }
      }
      case 'review': {
        const candidate = project.candidates.find(candidate => candidate.id === request.candidate_id)
        if (candidate === undefined || candidate.review !== undefined || candidate.sha256 !== request.candidate_sha256) throw Error('candidate_review_state: 版本不存在、摘要不符或已审校；修订须新建版本。')
        if (candidate.base_episode !== project.accepted.length) throw Error('candidate_base_changed: 前集已经推进，须基于当前验收状态提交新版本。')
        if (candidate.author === exec.actor) throw Error('self_review: 编写会话不能自行验收该版本。')
        if (!request.reason.trim()) throw Error('review_reason: 请记录来源、人物、时间、场次与改编语义的核对结果。')
        const rendered = renderEpisode(project, candidate.scenes, acceptedKnowledge(project), candidate.episode)
        if (checkVideoCoverage(project, candidate) && request.decision === 'approve' && !request.zero_action_reason?.trim()) {
          throw Error('zero_action_review_required: 请记录本集实际画面复核和确无关键动作遗漏的依据。')
        }
        candidate.review = { actor: exec.actor, time: new Date().toISOString(), decision: request.decision, reason: request.reason }
        if (request.zero_action_reason !== undefined) candidate.review.zero_action_reason = request.zero_action_reason.trim()
        await this.save(loaded, exec)
        return { revision: project.revision, candidate, rendered }
      }
      case 'commit': {
        const candidate = project.candidates.find(candidate => candidate.id === request.candidate_id)
        if (candidate === undefined || candidate.sha256 !== request.candidate_sha256) throw Error('candidate_digest: 请使用当前候选版本和摘要。')
        if (candidate.review?.decision !== 'approve' || candidate.review.actor === candidate.author) throw Error('review_required: 独立审校通过后才可验收。')
        if (candidate.base_episode !== project.accepted.length || candidate.episode !== project.accepted.length + 1
          || candidate.committed_at !== undefined) {
          throw Error('episode_order: 版本已提交或基于过期前集，请从 status 恢复下一集。')
        }
        renderEpisode(project, candidate.scenes, acceptedKnowledge(project), candidate.episode)
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
        const index = project.accepted.indexOf(candidate.id)
        const before = { ...project, accepted: project.accepted.slice(0, index) }
        const rendered = renderEpisode(project, candidate.scenes, acceptedKnowledge(before), candidate.episode)
        const basename = `episode-${candidate.episode}-${candidate.id.slice(2)}`
        const files = [
          { path: `${request.directory}/${basename}.md`, content: rendered.script },
          { path: `${request.directory}/${basename}.sources.json`, content: `${JSON.stringify({
            candidate_id: candidate.id, candidate_sha256: candidate.sha256,
            created_at: candidate.created_at, committed_at: candidate.committed_at,
            review: candidate.review, lines: rendered.lines, knowledge: rendered.knowledge,
            sources: project.sources.map(source => ({ id: source.id, path: source.path, sha256: source.sha256 })),
          }, null, 2)}\n` },
        ]
        for (const file of files) {
          const target = await this.target(file.path, exec)
          try {
            await this.fs.writeText(target, file.content, { kind: 'createIfAbsent' }, exec.signal, exec.policy)
          } catch (error) {
            if (!(error instanceof FsError) || error.code !== 'FS_NOT_OBSERVED') throw error
            if (await this.fs.readText(target, exec.signal) !== file.content) throw Error('export_changed: 导出文件已修改，请使用新的交付目录。')
          }
        }
        return { revision: project.revision, candidate_id: candidate.id, files: files.map(file => file.path) }
      }
      /* v8 ignore next -- the registry validates the closed operation union before execution */
      default: return assertNever(request)
    }
  }
}
