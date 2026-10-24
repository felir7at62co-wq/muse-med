import { describe, expect, it } from 'vitest'
import { VideoReviewId, type VideoSourceTimeline } from '@deepseek-ai/dsh-tool-video-inspect'
import { manuscriptScenes } from '../src/manuscript-scenes.ts'
import { manuscriptVideoPacketContent, planManuscriptVideoPackets, type ManuscriptSourceLocation } from '../src/manuscript-video-packets.ts'

type Frame = VideoSourceTimeline['windows'][number]['frames'][number]

function frame(id: string, time: number, change = false): Frame {
  return { frame_id: id, time, reasons: change ? ['cut'] : ['coverage'], exposed: true, image_available: true,
    observation_source: 'model_authored_observation', observation: { visible: '实际缓存图中的人物与道具记录。',
      change: '已记录的画面变化。', uncertainty: '' } }
}

function fixture() {
  const scene = manuscriptScenes('第1集\n1-1 餐厅 日 内\n人物：甲、乙\n甲（转头）：你这是什么意思？\n乙（停下）：什么？')[0]!
  const windows: VideoSourceTimeline['windows'] = [
    { window_id: 'W1', start_seconds: 0, end_seconds: 8, frames: [frame('A', 3.3), frame('B', 3.5, true), frame('C', 3.7)],
      event_notes: [], speech_segment_ids: ['short'], continuous_speech_candidate_indexes: [] },
    { window_id: 'W2', start_seconds: 8, end_seconds: 16, frames: [frame('D', 11.7), frame('E', 12, true), frame('F', 12.3)],
      event_notes: [], speech_segment_ids: ['whole'], continuous_speech_candidate_indexes: [] },
    { window_id: 'W3', start_seconds: 16, end_seconds: 24, frames: [frame('G', 19.7), frame('H', 20, true), frame('I', 20.3)],
      event_notes: [], speech_segment_ids: [], continuous_speech_candidate_indexes: [] },
  ]
  const line = scene.startLine + scene.text.split('\n').findIndex(quote => quote.startsWith('甲（'))
  const nextLine = scene.startLine + scene.text.split('\n').findIndex(quote => quote.startsWith('乙（'))
  const location: ManuscriptSourceLocation = { windows, window_seconds: 8, anchors: [], between_dialogue_lines: [],
    line_candidates: [
      { line, quote: '甲（转头）：你这是什么意思？', candidates: [
        { segment_id: 'short', start_seconds: 3.4, end_seconds: 3.8, literal_match: 'draft_contains_source', matched_characters: 2 },
        { segment_id: 'whole', start_seconds: 10, end_seconds: 14, literal_match: 'exact', matched_characters: 8 }] },
      { line: nextLine, quote: '乙（停下）：什么？', candidates: [
        { segment_id: 'short', start_seconds: 3.4, end_seconds: 3.8, literal_match: 'exact', matched_characters: 2 }] },
    ], visual_queries: [
      { line, quote: '甲（转头）：你这是什么意思？', kind: 'dialogue_parenthetical', time_candidates: [
        { start_seconds: 3.4, end_seconds: 3.8, relation: 'within_speech_candidate', segment_ids: ['short'] },
        { start_seconds: 10, end_seconds: 14, relation: 'within_speech_candidate', segment_ids: ['whole'] }] },
      { line: nextLine, quote: '乙（停下）：什么？', kind: 'dialogue_parenthetical', time_candidates: [
        { start_seconds: 3.4, end_seconds: 3.8, relation: 'within_speech_candidate', segment_ids: ['short'] }] },
    ] }
  return { scene, windows, location }
}

describe('saved manuscript temporal packets', () => {
  it('keeps weak shared-word candidates while selecting the complete literal correspondence', () => {
    const { scene, location } = fixture()
    const plan = planManuscriptVideoPackets(scene, location, 4, new Set())
    const current = plan.selected.find(packet => packet.origin === 'draft_candidates')
    expect(current?.interval.segment_ids).toEqual(['whole'])
    expect(plan.candidates.find(packet => packet.interval.segment_ids[0] === 'short')?.lines).toHaveLength(2)
    expect(current?.sampling_lines?.map(line => line.quote)).toEqual(['甲（转头）：你这是什么意思？'])
    expect(plan.selected.flatMap(packet => packet.images)).toHaveLength(4)
  })

  it('retains a source-led range even when no current manuscript action or speech aligns', () => {
    const { scene, location } = fixture()
    const unaligned = { ...location, line_candidates: [], visual_queries: [] }
    const plan = planManuscriptVideoPackets(scene, unaligned, 4, new Set())
    expect(plan.selected).toHaveLength(1)
    expect(plan.selected[0]?.origin).toBe('source_timeline')
    expect(plan.selected[0]?.lines).toEqual([])
    expect(plan.selected[0]?.interval.relation).toBe('source_window_not_draft_alignment')
    expect(plan.selected[0]?.images.length).toBeGreaterThan(0)
    expect(plan.selected[0]?.images.length).toBeLessThanOrEqual(4)
  })

  it('does not exchange a silent-range left and right speech anchor to manufacture a strong match', () => {
    const { scene, location } = fixture()
    const actionLine = 10, before = { line: 9, quote: '甲：我告诉你', candidates: [
      { segment_id: 'short', start_seconds: 0, end_seconds: 1, literal_match: 'draft_contains_source', matched_characters: 1 },
      { segment_id: 'whole', start_seconds: 10, end_seconds: 14, literal_match: 'exact', matched_characters: 4 }] }
    const after = { line: 11, quote: '乙：你', candidates: [
      { segment_id: 'short', start_seconds: 0, end_seconds: 1, literal_match: 'exact', matched_characters: 1 },
      { segment_id: 'whole', start_seconds: 10, end_seconds: 14, literal_match: 'source_contains_draft', matched_characters: 1 }] }
    const plan = planManuscriptVideoPackets(scene, { ...location, line_candidates: [before, after], visual_queries: [{
      line: actionLine, quote: '▲甲拍桌。', kind: 'action_line', time_candidates: [{ start_seconds: 1, end_seconds: 10,
        relation: 'between_speech_candidates_not_an_event', segment_ids: ['short', 'whole'] }],
    }] }, 4, new Set())
    const range = plan.candidates.find(packet => packet.origin === 'draft_candidates')
    expect(range?.literal_selection?.preferred).toBe(false)
    expect(range?.literal_selection?.tier).toBe(2)
    expect(range?.interval.segment_ids).toEqual(['short', 'whole'])
  })

  it.each([0, 1, 2, 3, 4])('shares the exact image allowance %s across source-led and current-line packets', (count) => {
    const { scene, location } = fixture()
    const plan = planManuscriptVideoPackets(scene, location, count, new Set())
    const ids = plan.selected.flatMap(packet => packet.images.map(image => image.frame_id))
    expect(ids.length).toBeLessThanOrEqual(count)
    expect(new Set(ids).size).toBe(ids.length)
    if (count === 0) expect(plan.selected).toEqual([])
  })

  it('returns independent detector anchors and identifies their interpretations as unverified', () => {
    const { scene, location, windows } = fixture()
    const timeline: VideoSourceTimeline = { advisory: true, semantic_assessment: 'not_performed',
      source: { review_id: VideoReviewId('review-test'), episode: '1', path: '/source.mp4', source_version: 'v1', duration_seconds: 24,
        scan_complete: true, scanned_until: 24 }, scope: { start_seconds: 0, end_seconds: 24, full_episode: true, window_seconds: 8 },
      material_sha256: 'material', windows, notice: '候选材料。' }
    const plan = planManuscriptVideoPackets(scene, { ...location, visual_queries: [], line_candidates: [] }, 0, new Set())
    const blocks = manuscriptVideoPacketContent({ timeline, documentSha256: 'document-hash', plans: [plan], images: new Map(), indexRows: 9 })
    const raw: unknown = JSON.parse(blocks[0]?.type === 'text' ? blocks[0].text : '{}')
    expect(raw).toMatchObject({ manuscript_video_source: { document_sha256: 'document-hash',
      source_change_timeline: { total_anchors: 3, omitted_for_budget: 0,
        interpretation_source: 'unverified_prior_model_observations', rows: [['B', 3.5, ['cut']], ['E', 12, ['cut']], ['H', 20, ['cut']]] } } })
    expect(blocks.some(block => block.type === 'image')).toBe(false)
  })
})
