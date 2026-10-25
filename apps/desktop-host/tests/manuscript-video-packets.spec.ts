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

function changedActionsFixture() {
  const scene = manuscriptScenes('第1集\n1-1 餐厅 日 内\n人物：甲、乙\n甲：等一下。\n▲乙把碗往桌边推。\n乙：这一大段没有改过的台词仍然按原稿写在这里。\n▲甲走到乙身边，把手搭在乙肩上。')[0]!
  const windows: VideoSourceTimeline['windows'] = [
    { window_id: 'early', start_seconds: 0, end_seconds: 8, frames: [frame('early-before', 3.8), frame('early-anchor', 4, true), frame('early-after', 4.2)],
      event_notes: [], speech_segment_ids: [], continuous_speech_candidate_indexes: [] },
    { window_id: 'middle', start_seconds: 40, end_seconds: 48, frames: [frame('middle-before', 43.8), frame('middle-anchor', 44, true), frame('middle-after', 44.2)],
      event_notes: [], speech_segment_ids: ['previous'], continuous_speech_candidate_indexes: [] },
    { window_id: 'end', start_seconds: 48, end_seconds: 54,
      frames: [frame('long-before', 50.3), frame('long-anchor', 50.5, true), frame('long-after', 50.7),
        frame('end-before', 52.6), frame('end-anchor', 52.8, true), frame('end-after', 53)],
      event_notes: [], speech_segment_ids: ['long'], continuous_speech_candidate_indexes: [] },
  ]
  const lines = scene.text.split('\n'), previousLine = scene.startLine + lines.findIndex(line => line.startsWith('甲：'))
  const middleLine = scene.startLine + lines.findIndex(line => line.startsWith('▲乙'))
  const longLine = scene.startLine + lines.findIndex(line => line.startsWith('乙：'))
  const endLine = scene.startLine + lines.findIndex(line => line.startsWith('▲甲'))
  const location: ManuscriptSourceLocation = { windows, window_seconds: 2, anchors: [], between_dialogue_lines: [],
    line_candidates: [
      { line: previousLine, quote: '甲：等一下。', candidates: [
        { segment_id: 'previous', start_seconds: 40, end_seconds: 41, literal_match: 'exact', matched_characters: 3 }] },
      { line: longLine, quote: '乙：这一大段没有改过的台词仍然按原稿写在这里。', candidates: [
        { segment_id: 'long', start_seconds: 50, end_seconds: 51, literal_match: 'exact', matched_characters: 22 }] },
    ], visual_queries: [
      { line: middleLine, quote: '▲乙把碗往桌边推。', kind: 'action_line', time_candidates: [
        { start_seconds: 41, end_seconds: 50, relation: 'between_speech_candidates_not_an_event', segment_ids: ['previous', 'long'] }] },
      { line: longLine, quote: '乙：这一大段没有改过的台词仍然按原稿写在这里。', kind: 'dialogue_parenthetical', time_candidates: [
        { start_seconds: 50, end_seconds: 51, relation: 'within_speech_candidate', segment_ids: ['long'] }] },
      { line: endLine, quote: '▲甲走到乙身边，把手搭在乙肩上。', kind: 'action_line', time_candidates: [
        { start_seconds: 51, end_seconds: 54, relation: 'after_speech_candidate', segment_ids: ['long'] }] },
    ] }
  return { scene, location, windows, middleLine, longLine, endLine }
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

  it('samples two changed visual ranges before an unchanged long dialogue and keeps terminal after-speech timing', () => {
    const { scene, location, middleLine, longLine, endLine } = changedActionsFixture()
    const plan = planManuscriptVideoPackets(scene, location, 4, new Set(), new Set([middleLine, endLine]))
    expect(plan.selected.map(packet => packet.changed_visual_lines?.map(line => line.line))).toEqual([[endLine], [middleLine]])
    expect(plan.selected.map(packet => packet.images.map(image => image.frame_id))).toEqual([
      ['end-before', 'end-after'], ['middle-before', 'middle-after'],
    ])
    expect(plan.selected[0]?.interval.relation).toBe('after_speech_candidate')
    expect(plan.candidates.some(packet => packet.lines.some(line => line.line === longLine))).toBe(true)
    expect(plan.candidates.some(packet => packet.origin === 'source_timeline')).toBe(true)
    expect(plan.selected.some(packet => packet.origin === 'source_timeline')).toBe(false)
  })

  it.each([0, 1, 2, 4])('prioritizes changed visual candidates without exceeding the shared allowance %s', (count) => {
    const { scene, location, middleLine, endLine } = changedActionsFixture()
    const plan = planManuscriptVideoPackets(scene, location, count, new Set(), new Set([middleLine, endLine]))
    const selected = plan.selected.flatMap(packet => packet.images)
    expect(selected.length).toBeLessThanOrEqual(count)
    expect(new Set(selected.map(image => image.frame_id)).size).toBe(selected.length)
    if (count === 0) expect(plan.selected).toEqual([])
    else expect(plan.selected.every(packet => packet.changed_visual_lines?.length)).toBe(true)
    if (count === 2) expect(selected.map(image => image.role)).toEqual(['before', 'after'])
  })

  it('retains source-first fallback when no changes or no literal action timing are available', () => {
    const { scene, location, middleLine } = changedActionsFixture()
    const unchanged = planManuscriptVideoPackets(scene, location, 4, new Set())
    expect(unchanged.changed_visual_lines).toEqual([])
    expect(unchanged.selected[0]?.origin).toBe('source_timeline')
    const unaligned = { ...location, line_candidates: [], visual_queries: [{
      line: middleLine, quote: '▲乙把碗往桌边推。', kind: 'action_line', time_candidates: [],
    }] }
    const changed = planManuscriptVideoPackets(scene, unaligned, 4, new Set(), new Set([middleLine]))
    expect(changed.changed_visual_lines.map(line => line.line)).toEqual([middleLine])
    expect(changed.selected[0]?.origin).toBe('source_timeline')
    expect(changed.selected[0]?.lines).toEqual([])
  })

  it('keeps shared weak neighboring candidates distinct from the line that supplied a preferred sample', () => {
    const { scene, location } = fixture()
    const firstLine = location.visual_queries[0]!.line, secondLine = location.visual_queries[1]!.line
    const plan = planManuscriptVideoPackets(scene, location, 2, new Set(), new Set([firstLine, secondLine]))
    const sampled = plan.selected[0]!
    expect(sampled.interval.segment_ids).toEqual(['whole'])
    expect(sampled.changed_visual_lines?.map(line => line.line)).toEqual([firstLine])
    const shared = plan.candidates.find(packet => packet.interval.segment_ids[0] === 'short')!
    expect(shared.changed_visual_lines?.map(line => line.line)).toEqual([firstLine, secondLine])
    expect(shared.sampling_lines?.map(line => line.line)).toEqual([secondLine])
    const timeline: VideoSourceTimeline = { advisory: true, semantic_assessment: 'not_performed',
      source: { review_id: VideoReviewId('review-test'), episode: '1', path: '/source.mp4', source_version: 'v1', duration_seconds: 24,
        scan_complete: true, scanned_until: 24 }, scope: { start_seconds: 0, end_seconds: 24, full_episode: true, window_seconds: 8 },
      material_sha256: 'material', windows: location.windows, notice: '候选材料。' }
    const blocks = manuscriptVideoPacketContent({ timeline, documentSha256: 'document-hash', plans: [plan], images: new Map(), indexRows: 9 })
    const raw: unknown = JSON.parse(blocks[0]?.type === 'text' ? blocks[0].text : '{}')
    expect(raw).toMatchObject({ manuscript_video_source: { changed_visual_line_sampling: [
      { actual_current_line: { line: firstLine }, selected_ranges: 1, sampling_status: 'temporal_samples_not_action_verification' },
      { actual_current_line: { line: secondLine }, selected_ranges: 0, sampling_status: 'not_selected_within_shared_image_allowance' },
    ] } })
  })

  it('does not let a shared weak line suppress that changed line’s own preferred temporal range', () => {
    const { location } = fixture()
    const scene = manuscriptScenes('第1集\n1-1 餐厅 日 内\n人物：甲、乙、丙\n甲（抬眼）：你说什么？\n乙（放杯）：你刚才说什么？\n丙（回头）：别吵。')[0]!
    const lines = scene.text.split('\n'), first = scene.startLine + lines.findIndex(line => line.startsWith('甲（'))
    const second = first + 1, third = second + 1
    const row = (line: number, segment_id: string, start_seconds: number, end_seconds: number,
      literal_match: string, matched_characters: number) => ({ line, quote: lines[line - scene.startLine]!,
      candidates: [{ segment_id, start_seconds, end_seconds, literal_match, matched_characters }] })
    const firstRow = row(first, 'whole', 10, 14, 'exact', 4)
    firstRow.candidates.push({ segment_id: 'short', start_seconds: 3.4, end_seconds: 3.8,
      literal_match: 'draft_contains_source', matched_characters: 2 })
    const rows = [firstRow, row(second, 'short', 3.4, 3.8, 'exact', 6), row(third, 'third', 19, 21, 'exact', 2)]
    const plan = planManuscriptVideoPackets(scene, { ...location, line_candidates: rows,
      visual_queries: rows.map(row => ({ line: row.line, quote: row.quote, kind: 'dialogue_parenthetical',
        time_candidates: row.candidates.map(candidate => ({ start_seconds: candidate.start_seconds,
          end_seconds: candidate.end_seconds, relation: 'within_speech_candidate', segment_ids: [candidate.segment_id] })) })),
    }, 4, new Set(), new Set([first, second, third]))
    expect(plan.selected.map(packet => packet.interval.segment_ids)).toEqual([['short'], ['whole']])
    expect(plan.selected[0]?.sampling_lines?.map(line => line.line)).toEqual([second])
    expect(plan.selected[1]?.sampling_lines?.map(line => line.line)).toEqual([first])
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
