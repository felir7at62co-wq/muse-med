/** Original synthetic simultaneous display fixtures preserve typed evidence and knowledge timing. */
import { expect, it } from 'vitest'
import { CANDIDATE_RECORD, FACT_RECORD, PROJECT_FILE } from '../src/schema.ts'
import type { ProjectFile } from '../src/schema.ts'
import { acceptedKnowledge, acceptedScripts, candidateDigest, checkVideoCoverage, renderEpisode, sha256 } from '../src/episode.ts'
import { buildRefinement, refinementPolicyDigest } from '../src/refinement.ts'
import { factDigest } from '../src/review.ts'

type Candidate = ProjectFile['candidates'][number]
type Scene = Candidate['scenes'][number]
type Beat = Scene['beats'][number]
const time = '2026-10-10T00:00:00.000Z'
const actionText = '抚平桌上的纸角。'
const voiceText = '我把这一页读完。'
const reason = '来源中人物朗读这一句时持续抚平纸角，动作与这一句同属一个连续时刻。'

function fixture(channel: 'dialogue' | 'os' | 'vo' = 'dialogue', after = false) {
  const action = FACT_RECORD.parse({ id: 'f:paper', kind: 'action', origin: 'source', actor: '林澄', layer: 'present',
    summary: actionText, anchors: [{ unit_id: 'u:frame', quote: '纸角' }], proposer: 'writer', created_at: time,
    review: { actor: 'reviewer', time, decision: 'approve', reason: '原始合成帧中的人物与动作一致。' } })
  const voice = FACT_RECORD.parse({ ...action, id: 'f:voice', kind: channel === 'os' ? 'thought' : 'speech', summary: voiceText,
    anchors: [{ unit_id: 'u:voice', quote: voiceText }] })
  const actionBeat: Beat = { kind: 'action', actor: '林澄', text: actionText, fact_ids: [action.id],
    witnesses: ['周宁'], requires_knowledge: [] }
  const voiceBeat: Beat = { kind: channel, actor: '林澄', text: voiceText, fact_ids: [voice.id],
    witnesses: channel === 'dialogue' ? ['周宁'] : [], requires_knowledge: [] }
  const scenes: Scene[] = [{ location: '阅览室', time: '日', setting: '内', layer: 'present', transition: 'opening',
    characters: ['林澄', '周宁'], beats: after ? [voiceBeat, actionBeat] : [actionBeat, voiceBeat] }]
  const baseline = CANDIDATE_RECORD.parse({ id: 'c:00000000-0000-4000-8000-000000000101', sha256: sha256('pending'),
    episode: 1, base_episode: 0, author: 'writer', created_at: time, scenes,
    coverage: { windows: [{ source_id: 's:frame', start: 1, count: 1 }, { source_id: 's:voice', start: 1, count: 1 }],
      required_beats: [{ fact_id: action.id, kind: 'action' }, { fact_id: voice.id, kind: channel }] },
    review: { actor: 'reviewer', time, decision: 'approve', reason: '原始合成事实与正文一致。' }, committed_at: time })
  baseline.sha256 = candidateDigest(baseline)
  const project = PROJECT_FILE.parse({ format_version: 1, id: 'p:synthetic-refinement', revision: 0, mode: 'adaptation',
    instructions: '保留原始合成内容，只作明确授权的保源精修。', created_at: time, updated_at: time,
    workflow: 'video_to_screenplay', facts: [action, voice], candidates: [], accepted: [],
    sources: [{ id: 's:frame', kind: 'video_inspection', path: '/synthetic/frame.json', sha256: sha256('original synthetic frame'),
      units: [{ id: 'u:frame', ordinal: 1, text: '纸角',
        image: { attachmentId: 'synthetic-paper-frame', mediaType: 'image/png', bytes: 1, width: 1, height: 1 } }] },
    { id: 's:voice', kind: 'text', path: '/synthetic/voice.txt', sha256: sha256(voiceText),
      units: [{ id: 'u:voice', ordinal: 1, text: voiceText }] }],
    refinement: { version: 'source-preserving-v1', sha256: sha256('pending'),
      source_project: { id: 'p:synthetic-original', path: '/synthetic/original.json', revision: 3, sha256: sha256('original synthetic project') },
      baselines: [baseline], retained_candidates: [], original_facts: [], original_sources: [],
      scope: { episodes: [1], instructions: '保留人物、因果和发声渠道，核对真正同时发生的动作。' }, allowed_categories: [],
      authorization: { source: 'user', session_id: 'writer', message_id: 'synthetic-visible-message', seq: 2,
        message_sha256: sha256('请在这份原稿上做保源精修。'), quote: '请在这份原稿上做保源精修。', consent_assessment: '用户明确授权当前原稿的保源精修。' } } })
  const policy = project.refinement!
  policy.original_facts = project.facts.map(fact => ({ id: fact.id, sha256: factDigest(fact) }))
  policy.original_sources = project.sources.map(source => ({ id: source.id, sha256: sha256(JSON.stringify(source)) }))
  policy.sha256 = refinementPolicyDigest(policy)
  const candidate = CANDIDATE_RECORD.parse({ ...baseline, id: 'c:00000000-0000-4000-8000-000000000102', review: undefined, committed_at: undefined })
  const actionIndex = after ? 1 : 0
  candidate.scenes[0]!.beats[actionIndex]!.sync_with = after ? 1 : 2
  candidate.scenes[0]!.beats[actionIndex]!.synchrony_reason = reason
  return { project, candidate, action, voice, actionIndex }
}

function bind(project: ProjectFile, candidate: Candidate): Candidate {
  const baseline = project.refinement!.baselines[0]!
  candidate.refinement = buildRefinement(project, candidate, {
    changes: candidate.scenes.flatMap((scene, sceneIndex) => scene.beats.flatMap((beat, beatIndex) => {
      const before = baseline.scenes[sceneIndex]?.beats[beatIndex]
      if (JSON.stringify(before) === JSON.stringify(beat)) return []
      return [{ ...(before === undefined ? {} : {
        before: { scene: sceneIndex + 1, beat: beatIndex + 1, text: before.text },
      }), after: { scene: sceneIndex + 1, beat: beatIndex + 1, text: beat.text }, reason: '原始合成动作与发声按明确关联作一次展示。' }]
    })),
    editor_comments: [], unresolved: [], unhandled: [],
    validation: { semantic: { status: 'not_run', scenes: [], reason: '本测试只检查结构，不声称已验证真实同时发生。' },
      visual: { status: 'not_run', source_units: [], reason: '测试中使用原始合成帧引用，不声称观察真实视频。' } },
  })
  candidate.sha256 = candidateDigest(candidate)
  return candidate
}

function addPerformanceDetail(project: ProjectFile, candidate: Candidate, bound = true) {
  const policy = project.refinement!
  policy.allowed_categories = ['performance_detail']
  policy.sha256 = refinementPolicyDigest(policy)
  const detail = FACT_RECORD.parse({ ...project.facts[0]!, id: 'f:detail', kind: 'action', origin: 'adaptation', summary: '捏住纸页边缘。',
    anchors: [{ unit_id: 'u:voice', quote: voiceText }], adaptation_reason: '明确授权的最小表演细节补充。',
    ...(bound ? { supplemental: { policy_sha256: policy.sha256, category: 'performance_detail',
      authorization_sha256: sha256(JSON.stringify(policy.authorization)) } } : {}),
  })
  project.facts.push(detail)
  candidate.scenes[0]!.beats.push({ kind: 'action', actor: detail.actor, text: detail.summary,
    fact_ids: [detail.id], requires_knowledge: [], witnesses: [] })
  return detail
}

it.each([false, true])('renders a source action once with both fact and source references when it follows speech: %s', (after) => {
  const { project, candidate, action, voice } = fixture('dialogue', after)
  bind(project, candidate)
  const rendered = renderEpisode(project, candidate.scenes, {}, 1, candidate)
  expect(rendered.script).toContain(`林澄（${actionText}）：${voiceText}`)
  expect(rendered.script.split(actionText).length - 1).toBe(1)
  expect(rendered.script).not.toContain('《修改说明》')
  expect(rendered.modification_notes).toContain('《修改说明》')
  expect(rendered.script).not.toContain(`▲${actionText}`)
  expect(rendered.lines).toEqual([{ line: 4, scene: 1, fact_ids: after ? [voice.id, action.id] : [action.id, voice.id],
    source_units: ['u:frame', 'u:voice'] }])
  expect(candidate.scenes[0]!.beats.map(beat => beat.kind)).toEqual(after ? ['dialogue', 'action'] : ['action', 'dialogue'])
  expect(checkVideoCoverage(project, candidate)).toBe(false)
})

it.each(['os', 'vo'] as const)('keeps %s private while action witnesses acquire only the original action', (channel) => {
  const { project, candidate, action, voice } = fixture(channel)
  bind(project, candidate)
  const rendered = renderEpisode(project, candidate.scenes, {}, 1, candidate)
  expect(rendered.script).toContain(`林澄（${channel.toUpperCase()}，${actionText}）：${voiceText}`)
  expect(rendered.knowledge['present:周宁']).toEqual([action.id])
  expect(rendered.knowledge['present:林澄']).toEqual([action.id, voice.id].sort())
})

it('keeps knowledge folding in original beat order rather than advancing it for a combined display', () => {
  const { project, candidate, action } = fixture('dialogue', true)
  const policy = project.refinement!
  policy.allowed_categories = ['minimal_os']
  policy.sha256 = refinementPolicyDigest(policy)
  const thought = FACT_RECORD.parse({ ...project.facts[1]!, id: 'f:new-thought', kind: 'thought', origin: 'adaptation',
    summary: '我得把这张纸留好。', adaptation_reason: '在明确授权范围内补充最小本人心理。',
    supplemental: { policy_sha256: policy.sha256, category: 'minimal_os',
      authorization_sha256: sha256(JSON.stringify(policy.authorization)) } })
  project.facts.push(thought)
  candidate.scenes[0]!.beats.splice(1, 0, { kind: 'os', actor: thought.actor, text: thought.summary,
    fact_ids: [thought.id], requires_knowledge: [action.id], witnesses: [] })
  candidate.scenes[0]!.beats[2]!.sync_with = 2
  bind(project, candidate)
  expect(() => renderEpisode(project, candidate.scenes, {}, 1, candidate)).toThrow('knowledge_not_acquired')
})

it('retains typed action coverage and actual frame evidence for source-backed parentheses', () => {
  const { project, candidate } = fixture()
  bind(project, candidate)
  candidate.coverage!.required_beats[0]!.kind = 'dialogue'
  expect(() => bind(project, candidate)).toThrow('refinement_source_scope')
  candidate.coverage!.required_beats[0]!.kind = 'action'
  project.facts[0]!.anchors = [...project.facts[1]!.anchors]
  project.refinement!.original_facts = project.facts.map(fact => ({ id: fact.id, sha256: factDigest(fact) }))
  project.refinement!.sha256 = refinementPolicyDigest(project.refinement!)
  bind(project, candidate)
  expect(() => checkVideoCoverage(project, candidate)).toThrow('visual_fact_evidence')
})

it('admits only a separately bound authorized supplement while retaining every source action and its coverage', () => {
  const { project, candidate, action } = fixture()
  const detail = addPerformanceDetail(project, candidate)
  bind(project, candidate)
  expect(checkVideoCoverage(project, candidate)).toBe(false)
  expect(renderEpisode(project, candidate.scenes, {}, 1, candidate).script).toContain(`▲${detail.summary}`)
  expect(candidate.coverage!.required_beats).toContainEqual({ fact_id: action.id, kind: 'action' })
  expect(candidate.scenes[0]!.beats[0]!.kind).toBe('action')
  expect(detail.origin).toBe('adaptation')
  detail.supplemental!.authorization_sha256 = sha256('a different user message')
  expect(() => checkVideoCoverage(project, candidate)).toThrow('refinement_authorization')
})

it.each(['default-video', 'adaptation-mode', 'arbitrary-reason', 'unbound-refinement'] as const)
('keeps the video source gate closed for %s without a per-fact authorized category', (failure) => {
  const { project, candidate } = fixture()
  addPerformanceDetail(project, candidate, false)
  if (failure === 'unbound-refinement') {
    expect(() => bind(project, candidate)).toThrow('refinement_authorization')
    return
  }
  project.refinement = undefined
  candidate.refinement = undefined
  project.mode = failure === 'default-video' ? 'faithful' : 'adaptation'
  if (failure !== 'arbitrary-reason') project.facts[2]!.adaptation_reason = undefined
  candidate.sha256 = candidateDigest(candidate)
  expect(() => checkVideoCoverage(project, candidate)).toThrow('visual_fact_evidence')
})

it.each(['missing-context', 'missing-policy', 'wrong-scenes', 'wrong-episode'] as const)('refuses %s as synchronous display authority', (failure) => {
  const { project, candidate } = fixture()
  bind(project, candidate)
  if (failure === 'missing-context') {
    expect(() => renderEpisode(project, candidate.scenes, {}, 1)).toThrow('synchronous_action_policy')
  } else if (failure === 'missing-policy') {
    project.refinement = undefined
    expect(() => renderEpisode(project, candidate.scenes, {}, 1, candidate)).toThrow('refinement_policy_required')
  } else if (failure === 'wrong-scenes') {
    const scenes = structuredClone(candidate.scenes)
    scenes[0]!.beats[0]!.text = '把另一张纸折起。'
    expect(() => renderEpisode(project, scenes, {}, 1, candidate)).toThrow('synchronous_action_context')
  } else {
    expect(() => renderEpisode(project, candidate.scenes, {}, 2, candidate)).toThrow('synchronous_action_context')
  }
})

it.each(['self', 'out-of-range', 'nonvoice', 'nonadjacent', 'actor-mismatch', 'nonaction', 'reason-only', 'missing-reason', 'blank-reason'] as const)
('rejects an invalid declared synchronous relation: %s', (failure) => {
  const { project, candidate, actionIndex } = fixture()
  const scene = candidate.scenes[0]!, action = scene.beats[actionIndex]!, speech = scene.beats[1]!
  switch (failure) {
    case 'self': action.sync_with = 1; break
    case 'out-of-range': action.sync_with = 9; break
    case 'nonvoice': speech.kind = 'action'; break
    case 'nonadjacent': scene.beats.splice(1, 0, { ...speech }); action.sync_with = 3; break
    case 'actor-mismatch': speech.actor = '周宁'; break
    case 'nonaction': speech.sync_with = 1; speech.synchrony_reason = reason; break
    case 'reason-only': action.sync_with = undefined; break
    case 'missing-reason': action.synchrony_reason = undefined; break
    case 'blank-reason': action.synchrony_reason = '  '; break
  }
  if (failure === 'nonvoice' || failure === 'actor-mismatch') {
    expect(() => bind(project, candidate)).toThrow('refinement_source_channel')
    return
  }
  bind(project, candidate)
  expect(() => renderEpisode(project, candidate.scenes, {}, 1, candidate)).toThrow('synchronous_action_relation')
})

it('requires an explicit body actor even when the original standalone action omitted its actor label', () => {
  const { project, candidate } = fixture()
  const baseline = project.refinement!.baselines[0]!
  baseline.scenes[0]!.beats[0]!.actor = undefined
  baseline.sha256 = candidateDigest(baseline)
  project.refinement!.sha256 = refinementPolicyDigest(project.refinement!)
  candidate.scenes[0]!.beats[0]!.actor = undefined
  bind(project, candidate)
  expect(() => renderEpisode(project, candidate.scenes, {}, 1, candidate)).toThrow('synchronous_action_actor')
})

it('rejects an authorized body action attached to another actor’s unchanged original speech', () => {
  const { project, candidate } = fixture()
  const detail = addPerformanceDetail(project, candidate)
  detail.actor = '周宁'
  const action = candidate.scenes[0]!.beats[2]!
  action.actor = detail.actor
  action.sync_with = 2
  action.synchrony_reason = reason
  bind(project, candidate)
  expect(() => renderEpisode(project, candidate.scenes, {}, 1, candidate)).toThrow('synchronous_action_actor')
})

it('rejects an adjacent action as a display target while preserving original source channels', () => {
  const { project, candidate } = fixture()
  addPerformanceDetail(project, candidate)
  const scene = candidate.scenes[0]!
  scene.beats[0]!.sync_with = undefined
  scene.beats[0]!.synchrony_reason = undefined
  const detail = scene.beats.pop()!
  detail.sync_with = 1
  detail.synchrony_reason = reason
  scene.beats.splice(1, 0, detail)
  bind(project, candidate)
  expect(() => renderEpisode(project, candidate.scenes, {}, 1, candidate)).toThrow('synchronous_action_relation')
})

it('rejects body-action parentheses for an original voice-only actor even with a separately authorized supplement', () => {
  const { project, candidate } = fixture('vo')
  const baseline = project.refinement!.baselines[0]!
  baseline.scenes[0]!.beats.shift()
  baseline.scenes[0]!.voice_only_characters = ['林澄']
  baseline.coverage!.required_beats.shift()
  baseline.sha256 = candidateDigest(baseline)
  project.facts.shift()
  project.refinement!.original_facts = project.facts.map(fact => ({ id: fact.id, sha256: factDigest(fact) }))
  candidate.scenes = structuredClone(baseline.scenes)
  candidate.coverage = structuredClone(baseline.coverage)
  addPerformanceDetail(project, candidate)
  candidate.scenes[0]!.beats[1]!.sync_with = 1
  candidate.scenes[0]!.beats[1]!.synchrony_reason = reason
  bind(project, candidate)
  expect(() => renderEpisode(project, candidate.scenes, {}, 1, candidate)).toThrow('synchronous_action_actor')
})

it.each([false, true])('refuses repeated source action elsewhere in the same scene, even linked to another target: %s', (secondLinked) => {
  const { project, candidate } = fixture()
  const scene = candidate.scenes[0]!
  scene.beats.push({ ...scene.beats[0]!, sync_with: secondLinked ? 4 : undefined, synchrony_reason: secondLinked ? reason : undefined },
    { ...scene.beats[1]! })
  bind(project, candidate)
  expect(() => renderEpisode(project, candidate.scenes, {}, 1, candidate)).toThrow('synchronous_action_duplicate')
})

it('refuses two distinct actions sharing one speech display target', () => {
  const { project, candidate } = fixture()
  addPerformanceDetail(project, candidate)
  candidate.scenes[0]!.beats[2]!.sync_with = 2
  candidate.scenes[0]!.beats[2]!.synchrony_reason = reason
  bind(project, candidate)
  expect(() => renderEpisode(project, candidate.scenes, {}, 1, candidate)).toThrow('synchronous_action_target')
})

it('leaves an after-speech causative action separate without a supported explicit simultaneous relation', () => {
  const { project, candidate, actionIndex } = fixture('dialogue', true)
  candidate.scenes[0]!.beats[actionIndex]!.text = '听完这一句，才把纸页放下。'
  candidate.scenes[0]!.beats[actionIndex]!.synchrony_reason = undefined
  bind(project, candidate)
  // A reason must be structurally present; judging whether its timing is true remains semantic review.
  expect(() => renderEpisode(project, candidate.scenes, {}, 1, candidate)).toThrow('synchronous_action_relation')
})

it.each([false, true])('attaches an action-owned hook to the combined display when action follows speech: %s', (after) => {
  const { project, candidate, actionIndex } = fixture('dialogue', after)
  candidate.scenes[0]!.beats[actionIndex]!.hook = true
  project.refinement!.baselines[0]!.scenes[0]!.beats[actionIndex]!.hook = true
  project.refinement!.baselines[0]!.sha256 = candidateDigest(project.refinement!.baselines[0]!)
  project.refinement!.sha256 = refinementPolicyDigest(project.refinement!)
  bind(project, candidate)
  const rendered = renderEpisode(project, candidate.scenes, {}, 1, candidate)
  expect(rendered.script).toContain(`【下集钩子】\n林澄（${actionText}）：${voiceText}`)
  expect(rendered.lines[0]!.line).toBe(5)
})

it('refuses simultaneous hook ownership instead of emitting the marker twice', () => {
  const { project, candidate } = fixture()
  candidate.scenes[0]!.beats[0]!.hook = true
  candidate.scenes[0]!.beats[1]!.hook = true
  expect(() => bind(project, candidate)).toThrow('refinement_source_channel')
})

it('rejects a second hook after a merged original source hook without emitting duplicate markers', () => {
  const { project, candidate } = fixture()
  const baseline = project.refinement!.baselines[0]!
  baseline.scenes[0]!.beats[0]!.hook = true
  baseline.sha256 = candidateDigest(baseline)
  candidate.scenes[0]!.beats[0]!.hook = true
  addPerformanceDetail(project, candidate)
  candidate.scenes[0]!.beats[2]!.hook = true
  bind(project, candidate)
  expect(() => renderEpisode(project, candidate.scenes, {}, 1, candidate)).toThrow('episode_hook')
})

it('retains exact legacy rendering and hashing when all refinement and display fields are omitted', () => {
  const { project } = fixture()
  const baseline = project.refinement!.baselines[0]!
  project.refinement = undefined
  const expected = `第1集\n1-1 阅览室 日 内【现实】\n人物：林澄、周宁\n▲${actionText}\n林澄：${voiceText}\n`
  expect(renderEpisode(project, baseline.scenes, {}, 1).script).toBe(expected)
  expect(candidateDigest(baseline)).toBe(sha256(JSON.stringify({ episode: baseline.episode,
    scenes: baseline.scenes, coverage: baseline.coverage })))
  project.candidates = [baseline]
  project.accepted = [baseline.id]
  expect(acceptedScripts(project)[0]!.script).toBe(expected)
})

it('binds synchronous scene fields and the independent modification report into the candidate digest', () => {
  const { project, candidate } = fixture()
  bind(project, candidate)
  const original = candidateDigest(candidate)
  candidate.refinement!.notes.changes[0]!.reason = '另一项明确且不同的展示说明。'
  expect(candidateDigest(candidate)).not.toBe(original)
  bind(project, candidate)
  const reportBound = candidateDigest(candidate)
  candidate.scenes[0]!.beats[0]!.synchrony_reason = '另一项待语义复核的同时发生依据。'
  expect(candidateDigest(candidate)).not.toBe(reportBound)
})

it('cold-replays accepted refinement with a pure screenplay body and separately verified report', () => {
  const { project, candidate } = fixture()
  bind(project, candidate)
  candidate.review = { actor: project.facts[0]!.review!.actor, time, decision: 'approve', reason: '独立检查合成示例。' }
  candidate.committed_at = time
  project.candidates = [candidate]
  project.accepted = [candidate.id]
  const cold = PROJECT_FILE.parse(JSON.parse(JSON.stringify(project)))
  const rendered = renderEpisode(cold, cold.candidates[0]!.scenes, {}, 1, cold.candidates[0])
  const delivered = acceptedScripts(cold)[0]!
  expect(delivered.script).toBe(rendered.script)
  expect(delivered.modification_notes).toBe(rendered.modification_notes)
  expect(delivered.script).not.toContain('《修改说明》')
  expect(delivered.modification_notes).toContain(candidate.sha256)
  expect(acceptedKnowledge(cold)).toEqual(rendered.knowledge)
})
