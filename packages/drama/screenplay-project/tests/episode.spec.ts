/** Narrative layers, audible attribution, continuity, and immutable accepted histories. */
import { expect, it } from 'vitest'
import { FACT_RECORD, PROJECT_FILE, VIDEO_SOURCE } from '../src/schema.ts'
import type { ProjectFile } from '../src/schema.ts'
import type { FactId, UnitId } from '../src/ids.ts'
import { brandString } from '@deepseek-ai/dsh-brand'
import { acceptedKnowledge, acceptedScripts, candidateDigest, checkVideoCoverage, renderEpisode, sha256 } from '../src/episode.ts'

const thought = FACT_RECORD.parse({ id: 'f:thought', kind: 'thought', origin: 'source', actor: '甲', layer: 'present',
  summary: '甲知道钥匙的位置。', anchors: [{ unit_id: 'unit:1', quote: '钥匙' }], proposer: 'writer', created_at: '2026-10-07T00:00:00.000Z',
  review: { actor: 'reviewer', time: '2026-10-07T00:01:00.000Z', decision: 'approve', reason: '原文心理归属为甲。' } })
const speech = FACT_RECORD.parse({ ...thought, id: 'f:speech', kind: 'speech', actor: '乙', summary: '乙说门开了。' })
const action = FACT_RECORD.parse({ ...thought, id: 'f:action', kind: 'action', summary: '甲推开门。' })
const comment = FACT_RECORD.parse({ ...thought, id: 'f:comment', kind: 'author_analysis', actor: undefined, layer: 'commentary', summary: '作者分析乙的贪心。' })
const project = PROJECT_FILE.parse({ format_version: 1, id: 'project', revision: 0, mode: 'faithful', instructions: '保留因果。',
  created_at: '2026-10-07T00:00:00.000Z', updated_at: '2026-10-07T00:00:00.000Z', sources: [],
  facts: [thought, speech, action, comment], candidates: [], accepted: [] })
type Scene = ProjectFile['candidates'][number]['scenes'][number]
type Beat = Scene['beats'][number]
function scene(overrides: Partial<Scene> = {}): Scene {
  return { location: '门前', time: '日', layer: 'present', transition: 'opening', characters: ['甲', '乙'],
    beats: [{ kind: 'os', actor: '甲', text: '钥匙在我手里。', fact_ids: [thought.id], witnesses: [], requires_knowledge: [] }], ...overrides }
}
function beat(overrides: Partial<Beat> = {}): Scene {
  const base = scene()
  return { ...base, beats: [{ ...base.beats[0]!, ...overrides }] }
}

it('renders actions, dialogue, private voiceovers, and author narration with exact source lines', () => {
  const scenes = [scene({ beats: [
    { kind: 'action', text: '甲推开门。', fact_ids: [action.id], witnesses: ['甲'], requires_knowledge: [] },
    { kind: 'dialogue', actor: '乙', text: '门开了。', fact_ids: [speech.id], witnesses: ['甲'], requires_knowledge: [] },
    { kind: 'os', actor: '甲', text: '我知道钥匙。', fact_ids: [thought.id], witnesses: [], requires_knowledge: [speech.id] },
    { kind: 'vo', actor: '甲', text: '钥匙在我手里。', fact_ids: [thought.id], witnesses: [], requires_knowledge: [] },
    { kind: 'vo', actor: '乙', text: '门开了。', fact_ids: [speech.id], witnesses: [], requires_knowledge: [] },
    { kind: 'vo', text: '乙想得到更多。', fact_ids: [comment.id], witnesses: [], requires_knowledge: [] },
  ] })]
  const rendered = renderEpisode(project, scenes, {}, 1)
  expect(rendered.lines.map(line => line.line)).toEqual([4, 5, 6, 7, 8, 9])
  expect(rendered.script.split('\n').slice(3, 9)).toEqual(['▲甲推开门。', '乙：门开了。', '甲（OS）：我知道钥匙。', '甲（VO）：钥匙在我手里。', '乙（VO）：门开了。', '旁白（VO）：乙想得到更多。'])
  expect(rendered.knowledge['present:甲']).toEqual([action.id, speech.id, thought.id].sort())
  expect(rendered.knowledge['present:乙']).toEqual([speech.id])
})

it.each([
  ['empty_scene', scene({ beats: [] })],
  ['scene_transition', scene({ transition: 'cut' })],
  ['beat_text', beat({ text: '第一行\n第二行' })],
  ['beat_text', beat({ text: '第一行\r第二行' })],
  ['missing_evidence', beat({ fact_ids: [] })],
  ['unapproved_fact', beat({ fact_ids: [FACT_RECORD.parse({ ...thought, id: 'missing' }).id] })],
  ['missing_actor', beat({ actor: undefined })],
  ['missing_actor', beat({ actor: '丙' })],
  ['speech_attribution', beat({ kind: 'dialogue', fact_ids: [thought.id] })],
  ['speech_attribution', beat({ kind: 'dialogue', fact_ids: [speech.id], actor: '甲' })],
  ['action_attribution', beat({ kind: 'action', fact_ids: [thought.id] })],
  ['vo_attribution', beat({ kind: 'vo', actor: '乙' })],
  ['vo_attribution', beat({ kind: 'vo', actor: '甲', fact_ids: [speech.id] })],
  ['vo_attribution', beat({ kind: 'vo', fact_ids: [comment.id] })],
  ['private_knowledge', beat({ kind: 'vo', witnesses: ['乙'] })],
  ['knowledge_actor', beat({ kind: 'vo', actor: undefined, fact_ids: [comment.id], requires_knowledge: [thought.id] })],
  ['witness_outside_scene', beat({ kind: 'action', fact_ids: [action.id], witnesses: ['丙'] })],
])('rejects %s before generating a script', (message, invalid) => {
  expect(() => renderEpisode(project, [invalid], {}, 1)).toThrow(message)
})

it.each([
  ['scene_transition', scene()],
  ['scene_continuity', scene({ transition: 'continuous', time: '夜' })],
  ['scene_continuity', scene({ transition: 'continuous', layer: 'dream' })],
  ['flashback_entry', scene({ transition: 'enter_flashback' })],
  ['flashback_return', scene({ transition: 'return_present' })],
])('rejects %s after the opening scene', (message, later) => {
  expect(() => renderEpisode(project, [scene(), later], {}, 1)).toThrow(message)
})

it('allows continuous scenes and keeps acquired knowledge available without inventing knowledge for others', () => {
  const next = scene({ transition: 'continuous' })
  next.beats[0]!.requires_knowledge = [thought.id]
  expect(renderEpisode(project, [scene(), next], {}, 1).knowledge).toEqual({ 'present:甲': [thought.id] })
})

it('acquires offscreen speech through a declared audible source without sharing private thoughts', () => {
  const phone = scene({ voice_only_characters: ['乙'], beats: [{ kind: 'vo', actor: '乙', text: '门开了。', fact_ids: [speech.id],
    requires_knowledge: [], witnesses: ['甲'], audible_in_scene: true }] })
  const reply = scene({ transition: 'continuous' })
  reply.beats[0]!.requires_knowledge = [speech.id]
  const result = renderEpisode(project, [phone, reply], {}, 1)
  expect(result.knowledge).toEqual({ 'present:甲': [speech.id, thought.id], 'present:乙': [speech.id] })
  expect(result.script).toContain('乙（VO）：门开了。')
  expect(result.script).toContain('人物：甲、乙（VO）')
  const unheard = scene({ beats: [{ ...phone.beats[0]!, audible_in_scene: false, witnesses: [] }] })
  expect(() => renderEpisode(project, [unheard, reply], {}, 1)).toThrow('knowledge_not_acquired')
})

it.each([
  scene({ voice_only_characters: ['乙', '乙'] }),
  scene({ voice_only_characters: ['丙'] }),
  scene({ voice_only_characters: ['乙'] }),
  scene({ voice_only_characters: ['甲'], beats: [
    { kind: 'vo', actor: '甲', text: '钥匙在我手里。', fact_ids: [thought.id], requires_knowledge: [], witnesses: [] },
    { kind: 'os', actor: '甲', text: '我知道钥匙。', fact_ids: [thought.id], requires_knowledge: [], witnesses: [] },
  ] }),
])('rejects repeated, absent, silent or visibly participating voice-only characters (%#)', (invalid) => {
  expect(() => renderEpisode(project, [invalid], {}, 1)).toThrow('voice_characters')
})

it.each([
  scene({ beats: [{ kind: 'os', actor: '甲', text: '钥匙在我手里。', fact_ids: [thought.id], requires_knowledge: [], witnesses: [], audible_in_scene: false }] }),
  scene({ beats: [{ kind: 'vo', actor: '甲', text: '钥匙在我手里。', fact_ids: [thought.id], requires_knowledge: [], witnesses: ['乙'], audible_in_scene: true }] }),
  scene({ beats: [{ kind: 'vo', text: '作者认为乙有些贪心。', fact_ids: [comment.id], requires_knowledge: [], witnesses: ['甲'], audible_in_scene: true }] }),
  scene({ beats: [{ kind: 'vo', text: '门开了。', fact_ids: [speech.id], requires_knowledge: [], witnesses: [], audible_in_scene: true }] }),
])('refuses to turn private thoughts, author analysis or unattributed narration into audible scene speech (%#)', (invalid) => {
  const scoped = { ...project, facts: project.facts.map(fact => fact.id === speech.id ? { ...fact, actor: undefined } : fact) }
  expect(() => renderEpisode(scoped, [invalid], {}, 1)).toThrow('voice_audibility')
})

it('refuses invalid flashback transitions within the flashback layer', () => {
  const past = { ...thought, layer: 'flashback' as const }
  const scoped = { ...project, facts: [past] }
  const first = scene({ layer: 'flashback' })
  expect(() => renderEpisode(scoped, [first, scene({ layer: 'flashback', transition: 'enter_flashback' })], {}, 1)).toThrow('flashback_entry')
  expect(() => renderEpisode(scoped, [first, scene({ layer: 'dream', transition: 'return_present' })], {}, 1)).toThrow('flashback_return')
})

it.each(['dream', 'imagined'] as const)('returns from %s to the present without sharing private knowledge across layers', (layer) => {
  const recalled = FACT_RECORD.parse({ ...thought, id: `f:${layer}`, layer })
  const scoped = { ...project, facts: [...project.facts, recalled] }
  const other = scene({ layer, transition: 'cut' })
  other.beats[0]!.fact_ids = [recalled.id]
  const result = renderEpisode(scoped, [scene(), other, scene({ transition: 'return_present' })], {}, 1)
  expect(result.knowledge['present:甲']).toEqual([thought.id])
  expect(result.knowledge[`${layer}:甲`]).toEqual([recalled.id])
  expect(result.lines.map(line => line.scene)).toEqual([1, 2, 3])
})

it.each(['missing', 'episode', 'base', 'uncommitted', 'unreviewed', 'rejected', 'self-reviewed'] as const)
('refuses %s entries in persisted accepted history', (failure) => {
  const scenes = [scene()]
  const id = 'c:00000000-0000-4000-8000-000000000001'
  const candidate = { id, episode: 1, base_episode: 0, sha256: sha256(JSON.stringify({ episode: 1, scenes })),
    author: 'writer', created_at: thought.created_at, scenes, committed_at: thought.created_at,
    review: { actor: 'reviewer', decision: 'approve', reason: '核对通过', time: thought.created_at } }
  const changed = failure === 'episode' ? { ...candidate, episode: 2 } : failure === 'base' ? { ...candidate, base_episode: 1 }
    : failure === 'uncommitted' ? { ...candidate, committed_at: undefined }
      : failure === 'unreviewed' ? { ...candidate, review: undefined }
        : failure === 'rejected' ? { ...candidate, review: { ...candidate.review, decision: 'reject' } }
          : failure === 'self-reviewed' ? { ...candidate, review: { ...candidate.review, actor: 'writer' } } : candidate
  const loaded = PROJECT_FILE.parse({ ...project, candidates: failure === 'missing' ? [] : [changed], accepted: [id] })
  expect(() => acceptedKnowledge(loaded)).toThrow('invalid_history')
})

it('renders episode and scene numbers, verified settings and hook markers without exposing workflow metadata', () => {
  const opening = scene({ setting: '外' })
  const ending = scene({ setting: '内', location: '屋内', transition: 'cut' })
  ending.beats[0]!.hook = true
  const result = renderEpisode(project, [opening, ending], {}, 12)
  expect(result.script).toBe('第12集\n12-1 门前 日 外【现实】\n人物：甲、乙\n甲（OS）：钥匙在我手里。\n\n12-2 屋内 日 内【现实】\n人物：甲、乙\n【下集钩子】\n甲（OS）：钥匙在我手里。\n')
  expect(result.lines.map(line => line.line)).toEqual([4, 9])
  expect(renderEpisode(project, [scene()], {}, 1).script).toContain('内外待核实')
})

it('refuses premature and duplicate hook markers instead of manufacturing an episode-end event', () => {
  const first = scene()
  first.beats[0]!.hook = true
  expect(() => renderEpisode(project, [first, scene({ transition: 'continuous' })], {}, 1)).toThrow('episode_hook')
  const duplicate = scene({ beats: [first.beats[0]!, first.beats[0]!] })
  expect(() => renderEpisode(project, [duplicate], {}, 1)).toThrow('episode_hook')
})


function videoCoverageFixture() {
  const scenes = [beat({ kind: 'dialogue', actor: '乙', fact_ids: [speech.id] })]
  const scoped = PROJECT_FILE.parse({ ...project, workflow: 'video_to_screenplay', facts: [speech],
    sources: [{ id: 's:text', kind: 'text', path: '/source.txt', sha256: sha256('text'), units: [{ id: 'unit:1', ordinal: 1, text: '钥匙' }] },
      { id: 's:frames', kind: 'video_inspection', path: '/frames.json', sha256: sha256('frames'), units: [{ id: 'unit:image', ordinal: 1, text: '帧',
        image: { attachmentId: 'fixed-frame', mediaType: 'image/png', bytes: 1, width: 1, height: 1 } }] }],
    candidates: [{ id: 'c:00000000-0000-4000-8000-000000000001', episode: 1, base_episode: 0, author: 'writer',
      created_at: speech.created_at, committed_at: speech.created_at, sha256: sha256('pending'), scenes,
      coverage: { windows: [{ source_id: 's:text', start: 1, count: 1 }, { source_id: 's:frames', start: 1, count: 1 }],
        required_beats: [{ fact_id: speech.id, kind: 'dialogue' }] },
      review: { actor: 'reviewer', decision: 'approve', reason: '核对通过', time: speech.created_at, zero_action_reason: '确认无动作' } }],
    accepted: ['c:00000000-0000-4000-8000-000000000001'] })
  const candidate = scoped.candidates[0]!
  candidate.sha256 = candidateDigest(candidate)
  return { project: scoped, candidate }
}

it('uses the video duration when a candidate scopes samples from a manifest without an inspection interval', () => {
  const { project: scoped, candidate } = videoCoverageFixture()
  scoped.sources[1]!.video = VIDEO_SOURCE.parse({ path: '/original.mp4', source_version: 'original-version',
    inspection: 'sampled_frames', duration_seconds: 30, samples: [{ requested_seconds: 1, timestamp_seconds: 1 }] })
  candidate.coverage!.windows[1]!.interval = { start_seconds: 0, end_seconds: 2 }
  expect(checkVideoCoverage(scoped, candidate)).toBe(true)
  candidate.coverage!.windows[1]!.interval.end_seconds = 31
  expect(() => checkVideoCoverage(scoped, candidate)).toThrow('video_episode_interval')
})

it.each(['missing-source', 'overflow', 'no-frame', 'duplicate', 'missing-fact', 'rejected-fact', 'unscoped-action', 'zero-action-review', 'digest'] as const)
('refuses %s during accepted video delivery revalidation', (failure) => {
  const { project: scoped, candidate } = videoCoverageFixture(), coverage = candidate.coverage!
  let code: string
  switch (failure) {
    case 'missing-source': coverage.windows[0]!.source_id = 'absent'; code = 'source_window'; break
    case 'overflow': coverage.windows[0]!.count = 2; code = 'source_window'; break
    case 'no-frame': coverage.windows.pop(); code = 'visual_preparation_required'; break
    case 'duplicate': coverage.required_beats.push(coverage.required_beats[0]!); code = 'source_coverage'; break
    case 'missing-fact': coverage.required_beats.push({ fact_id: brandString<FactId>('absent'), kind: 'dialogue' }); code = 'source_coverage'; break
    case 'rejected-fact': scoped.facts[0]!.review!.decision = 'reject'; code = 'source_coverage'; break
    case 'unscoped-action': {
      scoped.facts.push({ ...action, anchors: [{ unit_id: brandString<UnitId>('outside'), quote: '动作' }] })
      candidate.scenes[0]!.beats.push({ kind: 'action', actor: '甲', text: '甲推门。', fact_ids: [action.id], witnesses: [], requires_knowledge: [] })
      code = 'visual_fact_evidence'; break
    }
    case 'zero-action-review': delete candidate.review!.zero_action_reason; code = 'zero_action_review_required'; break
    case 'digest': candidate.scenes[0]!.beats[0]!.text = '修改后的台词'; code = 'invalid_candidate_digest'; break
  }
  if (failure !== 'digest') {
    expect(() => checkVideoCoverage(scoped, candidate)).toThrow(code)
    candidate.sha256 = candidateDigest(candidate)
  }
  expect(() => acceptedScripts(scoped)).toThrow(code)
})


it.each(['original', 'version', 'excluded-window', 'outside-interval'] as const)(
  'refuses unresolved deferred observations with a supplemental %s mismatch', (mismatch) => {
    const { project: scoped, candidate } = videoCoverageFixture()
    const source = scoped.sources[1]!
    source.video = VIDEO_SOURCE.parse({ path: '/original.mp4', source_version: 'original-version', inspection: 'sampled_frames',
      duration_seconds: 30, interval: { start_seconds: 0, end_seconds: 30 },
      samples: [{ requested_seconds: 1, timestamp_seconds: 1 }],
      sampling_plan: { strategy: 'scene_dialogue', selected: [], deferred: [{ time: 8, reasons: ['scene'] }] } })
    const supplemental = { ...source, id: brandString<typeof source.id>('s:supplemental'), video: VIDEO_SOURCE.parse({
      ...source.video, sampling_plan: undefined, samples: [{ requested_seconds: 8, timestamp_seconds: 7.98 }],
      path: mismatch === 'original' ? '/different.mp4' : source.video.path,
      source_version: mismatch === 'version' ? 'different-version' : source.video.source_version,
    }) }
    scoped.sources.push(supplemental)
    if (mismatch !== 'excluded-window') candidate.coverage!.windows.push({ source_id: supplemental.id, start: 1, count: 1 })
    if (mismatch === 'outside-interval') candidate.coverage!.windows[1]!.interval = { start_seconds: 2, end_seconds: 10 }
    candidate.sha256 = candidateDigest(candidate)
    expect(() => acceptedScripts(scoped)).toThrow(mismatch === 'outside-interval' ? 'video_episode_interval' : 'video_observation_deferred')
  },
)

it('indexes facts once while exporting a long accepted history instead of replaying every prefix', () => {
  const candidates = Array.from({ length: 64 }, (_, index) => ({
    id: `c:00000000-0000-4000-8000-${(index + 1).toString(16).padStart(12, '0')}`,
    episode: index + 1, base_episode: index, author: 'writer', scenes: [scene()],
    created_at: thought.created_at, committed_at: thought.created_at,
    sha256: candidateDigest({ episode: index + 1, scenes: [scene()] }),
    review: { actor: 'reviewer', decision: 'approve', reason: '核对通过', time: thought.created_at },
  }))
  const scoped = PROJECT_FILE.parse({ ...project, candidates, accepted: candidates.map(candidate => candidate.id) })
  for (const candidate of scoped.candidates) candidate.sha256 = candidateDigest(candidate)
  const facts = scoped.facts
  let reads = 0
  Object.defineProperty(scoped, 'facts', { get() { reads += 1; return facts } })
  const scripts = acceptedScripts(scoped)
  expect(scripts).toHaveLength(64)
  expect(scripts[63]!.script).toContain('第64集')
  expect(reads).toBeLessThanOrEqual(2)
})
