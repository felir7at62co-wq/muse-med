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
 * Semantic entailment of paraphrases remains the independent reviewer's responsibility.
 * @param project - Validated immutable facts and accepted episodes.
 * @param scenes - Ordered scenes to render.
 * @param previous - Character knowledge derived from preceding accepted episodes.
 * @param episode - Application-issued episode number used in scene headings.
 * @returns Generated script lines, their source references, and resulting knowledge.
 */
export function renderEpisode(project: ProjectFile, scenes: ProjectFile['candidates'][number]['scenes'], previous: Record<string, string[]>, episode: number): EpisodeRender {
  const knowledge = structuredClone(previous)
  const facts = new Map(project.facts.filter(fact => fact.review?.decision === 'approve').map(fact => [fact.id, fact]))
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
    output.push(`${episode}-${sceneIndex + 1} ${scene.location} ${scene.time} ${scene.setting ?? '内外待核实'}【${layer}】`, `人物：${scene.characters.join('、')}`)
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
