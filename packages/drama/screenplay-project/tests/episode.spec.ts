/** Narrative layers, audible attribution, continuity, and immutable accepted histories. */
import { expect, it } from 'vitest'
import { FACT_RECORD, PROJECT_FILE } from '../src/schema.ts'
import type { ProjectFile } from '../src/schema.ts'
import { acceptedKnowledge, renderEpisode, sha256 } from '../src/episode.ts'

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

it('refuses invalid flashback transitions within the flashback layer', () => {
  const past = { ...thought, layer: 'flashback' as const }
  const scoped = { ...project, facts: [past] }
  const first = scene({ layer: 'flashback' })
  expect(() => renderEpisode(scoped, [first, scene({ layer: 'flashback', transition: 'enter_flashback' })], {}, 1)).toThrow('flashback_entry')
  expect(() => renderEpisode(scoped, [first, scene({ layer: 'dream', transition: 'return_present' })], {}, 1)).toThrow('flashback_return')
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
