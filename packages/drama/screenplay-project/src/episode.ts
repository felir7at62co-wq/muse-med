/** Episode attribution, character knowledge, and deterministic screenplay rendering. @module screenplay-project/episode */

import { createHash } from 'node:crypto'
import { assertNever } from '@deepseek-ai/dsh-util-values'
import type { ProjectFile } from './schema.ts'

/**
 * SHA-256 of exact UTF-8 text or original file bytes.
 * @param value - Input bytes or text.
 * @returns Lowercase digest.
 */
export function sha256(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex')
}

/** One source-backed rendered line, numbered by the renderer. */
export interface ScriptLine {
  line: number
  scene: number
  fact_ids: string[]
  source_units: string[]
}

/** Canonical rendered screenplay and independently recomputable character state. */
export interface EpisodeRender {
  script: string
  lines: ScriptLine[]
  knowledge: Record<string, string[]>
}

/**
 * Validate attribution and fold an episode's public observations and private thoughts.
 * Audible VO requires reviewed speech; only its declared listeners acquire it.
 * Voice-only character labels decorate the script without changing stored identities.
 * Semantic entailment of paraphrases remains the independent reviewer's responsibility.
 * @param project - Validated immutable facts and accepted episodes.
 * @param scenes - Ordered scenes to render.
 * @param previous - Character knowledge derived from preceding accepted episodes.
 * @param episode - Application-issued episode number used in scene headings.
 * @returns Generated script lines, their source references, and resulting knowledge.
 */
export function renderEpisode(project: ProjectFile, scenes: ProjectFile['candidates'][number]['scenes'], previous: Record<string, string[]>, episode: number): EpisodeRender {
  const knowledge = structuredClone(previous)
  const facts = new Map(project.facts.filter(fact => fact.review?.decision === 'approve' && fact.withdrawal === undefined).map(fact => [fact.id, fact]))
  const withdrawn = new Set(project.facts.filter(fact => fact.withdrawal !== undefined).map(fact => fact.id))
  const output: string[] = [`第${episode}集`]
  const lines: ScriptLine[] = []
  let prior: ProjectFile['candidates'][number]['scenes'][number] | undefined
  let hookSeen = false
  for (const [sceneIndex, scene] of scenes.entries()) {
    if (scene.beats.length === 0) throw Error('empty_scene: 场次必须有正文。')
    if (prior === undefined && scene.transition !== 'opening') throw Error('scene_transition: 首场须明确 opening。')
    if (prior !== undefined) {
      if (scene.transition === 'opening') throw Error('scene_transition: opening 仅用于首场。')
      if (scene.transition === 'continuous' && (scene.location !== prior.location || scene.time !== prior.time || scene.layer !== prior.layer)) {
        throw Error('scene_continuity: 连续场次不能悄然更换地点、时间或叙述层。')
      }
      if (scene.layer === 'flashback' && prior.layer !== 'flashback' && scene.transition !== 'enter_flashback') {
        throw Error('flashback_entry: 进入闪回须标记 enter_flashback。')
      }
      if (prior.layer === 'flashback' && scene.layer === 'present' && scene.transition !== 'return_present') {
        throw Error('flashback_return: 闪回回到现实须标记 return_present。')
      }
      if (scene.transition === 'enter_flashback' && (scene.layer !== 'flashback' || prior.layer === 'flashback')) {
        throw Error('flashback_entry: enter_flashback 必须进入闪回层。')
      }
      if (scene.transition === 'return_present' && (prior.layer === 'present' || scene.layer !== 'present')) {
        throw Error('flashback_return: return_present 必须从闪回、梦境或想象回到现实。')
      }
    }
    const layer = { present: '现实', flashback: '闪回', dream: '梦境', imagined: '想象' }[scene.layer]
    const voiceOnly = new Set(scene.voice_only_characters ?? [])
    if (voiceOnly.size !== (scene.voice_only_characters?.length ?? 0)) throw Error('voice_characters: 画外人物不能重复。')
    for (const character of voiceOnly) {
      if (!scene.characters.includes(character)
        || !scene.beats.some(beat => beat.kind === 'vo' && beat.actor === character)
        || scene.beats.some(beat => beat.kind !== 'vo' && beat.actor === character)) {
        throw Error(`voice_characters: ${character} 须为本场仅以 VO 发声的人物。`)
      }
    }
    const characters = scene.characters.map(character => voiceOnly.has(character) ? `${character}（VO）` : character)
    output.push(`${episode}-${sceneIndex + 1} ${scene.location} ${scene.time} ${scene.setting ?? '内外待核实'}【${layer}】`, `人物：${characters.join('、')}`)
    for (const beat of scene.beats) {
      if (beat.hook === true) {
        if (hookSeen || sceneIndex !== scenes.length - 1) throw Error('episode_hook: 集尾悬念仅可在最后场次标记一次。')
        output.push('【下集钩子】')
        hookSeen = true
      }
      if (beat.text.includes('\n') || beat.text.includes('\r')) throw Error('beat_text: 每条动作或发声须为一个段落。')
      if (beat.fact_ids.length === 0) throw Error('missing_evidence: 每条正文须引用已审校事实。')
      const referenced = beat.fact_ids.map((id) => {
        const fact = facts.get(id)
        if (withdrawn.has(id)) throw Error(`withdrawn_fact: ${id} 已撤销，请读取更正事实。`)
        if (fact === undefined) throw Error(`unapproved_fact: ${id}`)
        if (fact.layer !== scene.layer && !(beat.kind === 'vo' && fact.layer === 'commentary')) {
          throw Error(`narrative_layer: ${id} 属于 ${fact.layer}，当前场次为 ${scene.layer}。`)
        }
        return fact
      })
      if (beat.kind === 'dialogue' || beat.kind === 'os') {
        if (beat.actor === undefined || !scene.characters.includes(beat.actor)) throw Error('missing_actor: 对白和 OS 必须指向本场人物。')
      }
      for (const fact of referenced) {
        switch (beat.kind) {
          case 'os':
            if (fact.kind !== 'thought' || fact.actor !== beat.actor) throw Error('os_attribution: OS 只能使用该人物自己的心理事实，不能使用作者分析或其他人的心理。')
            break
          case 'dialogue':
            if (fact.kind !== 'speech' || fact.actor !== beat.actor) throw Error('speech_attribution: 对白须引用对应人物的发声事实。')
            break
          case 'action':
            if (fact.kind !== 'action') throw Error('action_attribution: 动作须引用可拍行动事实；心理视觉化需单独审核改编事实。')
            break
          case 'vo':
            if ((fact.kind === 'thought' || fact.kind === 'speech') && fact.actor !== beat.actor) throw Error('vo_attribution: 心理及发声画外音须保留原人物。')
            if (fact.kind === 'author_analysis' && beat.actor !== undefined) throw Error('vo_attribution: 作者分析须标为无角色的旁白。')
            break
          /* v8 ignore next -- the durable parser and tool registry admit only the handled beat kinds */
          default: assertNever(beat.kind)
        }
      }
      if (beat.audible_in_scene !== undefined && beat.kind !== 'vo') throw Error('voice_audibility: 仅 VO 可声明场内是否可闻。')
      if (beat.audible_in_scene === true && (beat.actor === undefined
        || referenced.some(fact => fact.kind !== 'speech'))) {
        throw Error('voice_audibility: 场内可闻 VO 须有发声人物并引用其已批准的发声事实。')
      }
      if ((beat.kind === 'os' || (beat.kind === 'vo' && beat.audible_in_scene !== true)) && beat.witnesses.length > 0) {
        throw Error('private_knowledge: OS 与仅观众可闻的 VO 不能让场内人物获知。')
      }
      if (beat.actor === undefined && beat.requires_knowledge.length > 0) throw Error('knowledge_actor: 知情要求须指定人物。')
      for (const id of beat.requires_knowledge) {
        if (!knowledge[`${scene.layer}:${beat.actor}`]?.includes(id)) throw Error(`knowledge_not_acquired: ${beat.actor} 尚未在 ${scene.layer} 剧情中获知 ${id}。`)
      }
      const recipients = new Set(beat.witnesses)
      if (beat.actor !== undefined) recipients.add(beat.actor)
      for (const recipient of recipients) {
        if (!scene.characters.includes(recipient)) throw Error(`witness_outside_scene: ${recipient}`)
        const key = `${scene.layer}:${recipient}`
        const known = new Set(knowledge[key] ?? [])
        for (const fact of referenced) known.add(fact.id)
        knowledge[key] = [...known].sort()
      }
      const prefix = beat.kind === 'action' ? '▲' : beat.kind === 'dialogue' ? `${beat.actor}：`
        : beat.kind === 'os' ? `${beat.actor}（OS）：` : `${beat.actor ?? '旁白'}（VO）：`
      output.push(`${prefix}${beat.text}`)
      lines.push({ line: output.length, scene: sceneIndex + 1, fact_ids: [...beat.fact_ids],
        source_units: [...new Set(referenced.flatMap(fact => fact.anchors.map(anchor => anchor.unit_id)))].sort() })
    }
    output.push('')
    prior = scene
  }
  return { script: `${output.join('\n').trimEnd()}\n`, lines, knowledge }
}

/**
 * Bind the source coverage plan to the same immutable version as the scenes.
 * @param candidate - Episode content and optional managed-video coverage.
 * @returns Candidate SHA-256; legacy candidates retain their original digest.
 */
export function candidateDigest(candidate: Pick<ProjectFile['candidates'][number], 'episode' | 'scenes' | 'coverage'>): string {
  return sha256(JSON.stringify({ episode: candidate.episode, scenes: candidate.scenes,
    ...(candidate.coverage === undefined ? {} : { coverage: candidate.coverage }) }))
}

/**
 * Check a managed video's prepared source inventory against the actual beats.
 * @param project - Original sources and independently reviewed facts.
 * @param candidate - Candidate with declared complete episode source windows.
 * @returns Whether the episode requires an independent zero-action recheck.
 */
export function checkVideoCoverage(project: ProjectFile, candidate: ProjectFile['candidates'][number]): boolean {
  if (project.workflow !== 'video_to_screenplay') return false
  const coverage = candidate.coverage
  if (coverage === undefined) throw Error('visual_preparation_required: 视频候选须先整理实际画面与来源事实，提交本集 coverage。')
  const units = new Map<string, ProjectFile['sources'][number]['units'][number]>()
  for (const window of coverage.windows) {
    const source = project.sources.find(value => value.id === window.source_id)
    if (source === undefined || window.start + window.count - 1 > source.units.length) {
      throw Error('source_window: 本集来源范围必须对应已导入片段。')
    }
    for (const unit of source.units.slice(window.start - 1, window.start - 1 + window.count)) units.set(unit.id, unit)
  }
  if (![...units.values()].some(unit => unit.image !== undefined)) {
    throw Error('visual_preparation_required: 本集来源范围必须包含实际视频帧。')
  }
  const required = new Map(coverage.required_beats.map(value => [value.fact_id, value]))
  if (required.size !== coverage.required_beats.length) throw Error('source_coverage: 必保留事实不能重复。')
  // A later episode's newly proposed facts do not alter an earlier accepted inventory.
  const scoped = project.facts.filter(fact => fact.origin === 'source' && fact.created_at <= candidate.created_at
    && fact.withdrawal === undefined && fact.anchors.some(anchor => units.has(anchor.unit_id)))
  for (const fact of scoped) {
    if (fact.review === undefined) throw Error(`unreviewed_source_fact: ${fact.id} 尚未独立审校，不能先写全稿。`)
    if (fact.review.decision === 'approve' && !required.has(fact.id)) {
      throw Error(`source_coverage: ${fact.id} 尚未列入本集必保留事实。`)
    }
  }
  const beats = candidate.scenes.flatMap(scene => scene.beats)
  for (const entry of required.values()) {
    const fact = scoped.find(value => value.id === entry.fact_id && value.review?.decision === 'approve')
    if (fact === undefined) throw Error(`source_coverage: ${entry.fact_id} 须为本集范围内已批准的来源事实。`)
    if (fact.kind === 'action' && entry.kind !== 'action') {
      throw Error(`source_coverage: ${entry.fact_id} 的画面动作必须按动作保留，不能改列为对白或 OS/VO。`)
    }
    if (fact.kind === 'action' && !fact.anchors.some(anchor => units.get(anchor.unit_id)?.image !== undefined)) {
      throw Error(`visual_fact_evidence: ${fact.id} 的画面动作须有本集实际帧依据，不能由台词推断。`)
    }
    if (!beats.some(beat => beat.kind === entry.kind && beat.fact_ids.includes(entry.fact_id))) {
      throw Error(`source_coverage: ${entry.fact_id} 未在正文中按 ${entry.kind} 保留。`)
    }
  }
  for (const beat of beats) {
    for (const id of beat.fact_ids) {
      const fact = project.facts.find(value => value.id === id)
      if (fact?.origin === 'adaptation') {
        const code = beat.kind === 'action' ? 'visual_fact_evidence' : 'video_source_fact_required'
        throw Error(`${code}: ${id} 的新增内容不是视频来源事实。`)
      }
      if (beat.kind !== 'action') {
        if (fact?.kind === 'action') throw Error(`voice_source_evidence: ${id} 的动作事实不能改写为无来源发声。`)
        if (!fact?.anchors.some(anchor => units.has(anchor.unit_id) && units.get(anchor.unit_id)?.image === undefined)) {
          throw Error(`voice_source_evidence: ${id} 的对白或 OS/VO 须有本集核对文字，不能仅凭画面推断。`)
        }
        continue
      }
      if (fact?.origin === 'source' && !fact.anchors.some(anchor => units.get(anchor.unit_id)?.image !== undefined)) {
        throw Error(`visual_fact_evidence: ${id} 的动作没有本集画面依据。`)
      }
      if (beat.actor !== undefined && beat.actor !== fact?.actor) {
        throw Error(`action_attribution: ${id} 的行动人物与正文不一致。`)
      }
    }
  }
  const zeroAction = !beats.some(beat => beat.kind === 'action')
  if (zeroAction && candidate.review?.decision === 'approve' && !candidate.review.zero_action_reason?.trim()) {
    throw Error('zero_action_review_required: 零动作集须记录独立画面复核依据，不得补造动作。')
  }
  return zeroAction
}

/**
 * Reconstruct accepted scripts for formal delivery without trusting sidecar claims.
 * @param project - Parsed authoritative project file.
 * @returns Ordered candidate identities, digests and exact accepted Markdown.
 */
export function acceptedScripts(project: ProjectFile): { id: string; sha256: string; script: string }[] {
  return acceptedCandidates(project).map((candidate, index) => {
    if (candidate.sha256 !== candidateDigest(candidate)) throw Error('invalid_candidate_digest: 候选内容已变更。')
    checkVideoCoverage(project, candidate)
    const knowledge = acceptedKnowledge({ ...project, accepted: project.accepted.slice(0, index) })
    return { id: candidate.id, sha256: candidate.sha256,
      script: renderEpisode(project, candidate.scenes, knowledge, candidate.episode).script }
  })
}

/**
 * Resolve approved, sequential episode records from persisted history.
 * @param project - Parsed project history.
 * @returns Accepted candidate records in episode order.
 */
export function acceptedCandidates(project: ProjectFile): ProjectFile['candidates'] {
  return project.accepted.map((id, index) => {
    const candidate = project.candidates.find(item => item.id === id)
    if (candidate === undefined || candidate.episode !== index + 1 || candidate.base_episode !== index
      || candidate.committed_at === undefined
      || candidate.review?.decision !== 'approve' || candidate.review.actor === candidate.author) {
      throw Error('invalid_history: 验收记录缺失、集号不连续或审校无效。')
    }
    return candidate
  })
}

/**
 * Recompute character knowledge exclusively from accepted episode events.
 * @param project - Validated project history.
 * @returns Knowledge before the next episode, without model-written negative claims.
 */
export function acceptedKnowledge(project: ProjectFile): Record<string, string[]> {
  let knowledge: Record<string, string[]> = {}
  for (const candidate of acceptedCandidates(project)) {
    knowledge = renderEpisode(project, candidate.scenes, knowledge, candidate.episode).knowledge
  }
  return knowledge
}
