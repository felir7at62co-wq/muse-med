import { describe, expect, it } from 'vitest'
import { AttachmentId } from '@deepseek-ai/dsh-attachment'
import type { ImageBlock } from '@deepseek-ai/dsh-llm'
import { VideoReviewId, type VideoSourceTimeline } from '@deepseek-ai/dsh-tool-video-inspect'
import { manuscriptScenes } from '../src/manuscript-scenes.ts'
import { MANUSCRIPT_VIDEO_PRESENTATION, manuscriptPacketEventIds, manuscriptVideoPacketContent, planManuscriptSourceTail,
  planManuscriptVideoPackets, type ManuscriptSourceLocation, type PacketContext } from '../src/manuscript-video-packets.ts'

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

function sourceTailFixture() {
  const { scene } = fixture()
  const timeline: VideoSourceTimeline = { advisory: true, semantic_assessment: 'not_performed',
    source: { review_id: VideoReviewId('review-tail'), episode: '1', path: '/source.mp4', source_version: 'tail-v1',
      follow_up: { status: 'active' }, duration_seconds: 86, scan_complete: true, scanned_until: 86 },
    scope: { start_seconds: 0, end_seconds: 86, full_episode: true, window_seconds: 8 }, material_sha256: 'tail-material',
    windows: [{ window_id: 'tail', start_seconds: 80, end_seconds: 86,
      frames: [frame('cut-before', 80.88), frame('cut', 81, true), frame('cut-after', 81.12),
        frame('speech-end', 84), frame('tail-first', 84.2), frame('tail-last', 85.9)],
      speech_segment_ids: ['last'], event_notes: [], continuous_speech_candidate_indexes: [] }],
    speech: { source: { path: '/source.asr.json', version: 'asr-v1', sha256: 'asr-hash', time_unit: 'seconds' },
      association: 'caller_supplied_not_verified', segments: [{ segment_id: 'last', start_seconds: 82, end_seconds: 84,
        text: '最后一句原台词。', speaker_identity_unverified: true, raw: { start: 82, end: 84, text: '最后一句原台词。' } }],
      continuous_speech_candidates: [], notice: '原始音频转写。' }, notice: '候选材料。' }
  return { scene, timeline }
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
    expect(plan.selected).toHaveLength(2)
    expect(plan.selected[0]?.origin).toBe('source_timeline')
    expect(plan.selected[0]?.lines).toEqual([])
    expect(plan.selected[0]?.interval.relation).toBe('source_window_not_draft_alignment')
    expect(plan.selected[0]?.images.length).toBeGreaterThan(0)
    expect(plan.selected[0]?.images.length).toBeLessThanOrEqual(4)
    expect(plan.selected.every(packet => packet.origin === 'source_timeline')).toBe(true)
    expect(plan.selected.flatMap(packet => packet.images)).toHaveLength(4)
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

  it('keeps repeated before-speech ranges while sampling only the endpoint window rather than the whole-range midpoint', () => {
    const { scene, location } = fixture()
    const line = 10, words = { line: 11, quote: '甲 VO：你这是什么意思？', candidates: [
      { segment_id: 'early', start_seconds: 14.72, end_seconds: 16, literal_match: 'source_contains_draft', matched_characters: 8 },
      { segment_id: 'late', start_seconds: 82.48, end_seconds: 84.16, literal_match: 'exact', matched_characters: 8 },
    ] }
    const plan = planManuscriptVideoPackets(scene, { ...location, windows: [
      { window_id: 'middle', start_seconds: 40, end_seconds: 48,
        frames: [frame('middle-before', 41.25), frame('middle-cut', 41.366667, true), frame('middle-after', 41.486667)],
        event_notes: [], speech_segment_ids: [], continuous_speech_candidate_indexes: [] },
      { window_id: 'endpoint', start_seconds: 72, end_seconds: 86,
        frames: [frame('endpoint-before', 75.1), frame('endpoint-cut', 75.2, true), frame('endpoint-after', 75.3),
          frame('outside-interval', 84.2, true)],
        event_notes: [], speech_segment_ids: ['late'], continuous_speech_candidate_indexes: [] },
    ], line_candidates: [words], visual_queries: [{ line, quote: '▲手机里播出先前录下的视频。', kind: 'action_line',
      time_candidates: words.candidates.map(candidate => ({ start_seconds: 0, end_seconds: candidate.start_seconds,
        relation: 'before_speech_candidate', segment_ids: [candidate.segment_id] })) }] }, 2, new Set(), new Set([line]))
    expect(plan.candidates.filter(packet => packet.origin === 'draft_candidates').map(packet => packet.interval.end_seconds))
      .toEqual([14.72, 82.48])
    expect(plan.selected[0]).toMatchObject({ interval: { start_seconds: 0, end_seconds: 82.48, segment_ids: ['late'] },
      sampling_interval: { start_seconds: 74.48, end_seconds: 82.48 }, ambiguous: true,
      images: [{ frame_id: 'endpoint-before' }, { frame_id: 'endpoint-after' }] })
    expect(plan.selected.flatMap(packet => packet.images).some(image => image.frame_id.startsWith('middle'))).toBe(false)
  })

  it('bounds after-speech sampling at the original left anchor without hiding the remaining candidate range', () => {
    const { scene, location } = fixture()
    const line = 10
    const plan = planManuscriptVideoPackets(scene, { ...location, windows: [{ window_id: 'all', start_seconds: 0, end_seconds: 86,
      frames: [frame('near-before', 5.8), frame('near-cut', 6, true), frame('near-after', 6.2), frame('middle', 44, true)],
      event_notes: [], speech_segment_ids: ['previous'], continuous_speech_candidate_indexes: [] }],
    line_candidates: [{ line: 9, quote: '甲：等一下。', candidates: [{ segment_id: 'previous', start_seconds: 0,
      end_seconds: 2, literal_match: 'exact', matched_characters: 3 }] }],
    visual_queries: [{ line, quote: '▲甲走向门口。', kind: 'action_line', time_candidates: [{ start_seconds: 2,
      end_seconds: 86, relation: 'after_speech_candidate', segment_ids: ['previous'] }] }] }, 2, new Set(), new Set([line]))
    expect(plan.selected[0]).toMatchObject({ interval: { start_seconds: 2, end_seconds: 86 },
      sampling_interval: { start_seconds: 2, end_seconds: 10 }, images: [{ frame_id: 'near-before' }, { frame_id: 'near-after' }] })
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
        follow_up: { status: 'active' }, scan_complete: true, scanned_until: 24 }, scope: { start_seconds: 0, end_seconds: 24, full_episode: true, window_seconds: 8 },
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
        follow_up: { status: 'active' }, scan_complete: true, scanned_until: 24 }, scope: { start_seconds: 0, end_seconds: 24, full_episode: true, window_seconds: 8 },
      material_sha256: 'material', windows, notice: '候选材料。' }
    const plan = planManuscriptVideoPackets(scene, { ...location, visual_queries: [], line_candidates: [] }, 0, new Set())
    const blocks = manuscriptVideoPacketContent({ timeline, documentSha256: 'document-hash', plans: [plan], images: new Map(), indexRows: 9 })
    const raw: unknown = JSON.parse(blocks[0]?.type === 'text' ? blocks[0].text : '{}')
    expect(raw).toMatchObject({ manuscript_video_source: { document_sha256: 'document-hash',
      source_change_timeline: { total_anchors: 3, omitted_for_budget: 0,
        interpretation_source: 'unverified_prior_model_observations', rows: [['B', 3.5, ['cut']], ['E', 12, ['cut']], ['H', 20, ['cut']]] } } })
    expect(blocks.some(block => block.type === 'image')).toBe(false)
  })

  it('samples the source ending after final ASR rather than an earlier cut and keeps draft lines empty', () => {
    const { scene, timeline } = sourceTailFixture()
    const packet = planManuscriptSourceTail(scene, timeline, 4, new Set())!
    expect(packet).toMatchObject({ origin: 'source_timeline', lines: [],
      interval: { start_seconds: 84, end_seconds: 86, relation: 'source_tail_not_aligned_to_draft_ending', segment_ids: [] },
      sampling_interval: { start_seconds: 84, end_seconds: 86 },
      selection_basis: 'cached_middle_latest_after_final_asr_end_not_draft_alignment',
      images: [{ frame_id: 'tail-first', role: 'anchor' }, { frame_id: 'tail-last', role: 'after' }] })
    const plan = planManuscriptVideoPackets(scene, { ...fixture().location, windows: timeline.windows }, 0, new Set())
    plan.candidates.push(packet)
    plan.selected.push(packet)
    const blocks = manuscriptVideoPacketContent({ timeline, documentSha256: 'tail-document', plans: [plan], images: new Map(), indexRows: 10 })
    const header: unknown = JSON.parse(blocks[0]?.type === 'text' ? blocks[0].text : '{}')
    const body = blocks.find(block => block.type === 'text' && block.text.includes('"manuscript_source_packet"'))
    expect(header).toHaveProperty('manuscript_video_source.presentation_version', MANUSCRIPT_VIDEO_PRESENTATION)
    expect(header).toHaveProperty(`manuscript_video_source.visual_candidates.${plan.candidates.length - 1}.sampling_interval`,
      { start_seconds: 84, end_seconds: 86 })
    const packetBody: unknown = JSON.parse(body?.type === 'text' ? body.text : '{}')
    expect(packetBody).toMatchObject({ manuscript_source_packet: {
      actual_current_lines: [], sampling_interval: { start_seconds: 84, end_seconds: 86 },
      time_candidate: { relation: 'source_tail_not_aligned_to_draft_ending' } } })
  })

  it.each([0, 1, 2, 4])('limits the independent source-tail sample to the shared allowance %s', (count) => {
    const { scene, timeline } = sourceTailFixture()
    const packet = planManuscriptSourceTail(scene, timeline, count, new Set())
    if (count === 0) expect(packet).toBeUndefined()
    else expect(packet?.images.map(image => image.frame_id)).toEqual(count === 1 ? ['tail-last'] : ['tail-first', 'tail-last'])
  })

  it('retains an interior cached tail state instead of sampling only its endpoints', () => {
    const { scene, timeline } = sourceTailFixture()
    const template = timeline.windows[0]!.frames.find(frame => frame.frame_id === 'tail-first')!
    timeline.windows[0]!.frames.push({ ...template, frame_id: 'tail-middle', time: 85.1 })
    const packet = planManuscriptSourceTail(scene, timeline, 2, new Set())
    expect(packet?.images).toEqual([
      { frame_id: 'tail-middle', time: 85.1, role: 'anchor' },
      { frame_id: 'tail-last', time: 85.9, role: 'after' },
    ])
    expect(packet?.eligible_cache_frames).toBe(3)
    expect(planManuscriptSourceTail(scene, timeline, 1, new Set())?.images.map(frame => frame.frame_id)).toEqual(['tail-last'])
    expect(planManuscriptSourceTail(scene, timeline, 2, new Set(['tail-middle']))?.images.map(frame => frame.frame_id))
      .toEqual(['tail-first', 'tail-last'])
  })

  it('uses the rolling source ending when ASR is absent, with no draft alignment claim', () => {
    const { scene, timeline } = sourceTailFixture()
    const { speech: _speech, ...withoutSpeech } = timeline
    const packet = planManuscriptSourceTail(scene, withoutSpeech, 2, new Set())
    expect(packet).toMatchObject({ sampling_interval: { start_seconds: 78, end_seconds: 86 },
      selection_basis: 'rolling_source_tail_without_asr_not_draft_alignment',
      images: [{ frame_id: 'cut-after' }, { frame_id: 'tail-last' }] })
  })

  it('falls back to the rolling ending only when the post-ASR interval has no readable cache images', () => {
    const { scene, timeline } = sourceTailFixture()
    timeline.windows[0]!.frames = timeline.windows[0]!.frames.map(frame => frame.time > 84
      ? { ...frame, image_available: false } : frame)
    const packet = planManuscriptSourceTail(scene, timeline, 2, new Set())
    expect(packet).toMatchObject({ sampling_interval: { start_seconds: 78, end_seconds: 86 },
      selection_basis: 'rolling_source_tail_without_post_asr_cache_not_draft_alignment',
      images: [{ frame_id: 'cut-after' }, { frame_id: 'speech-end' }] })
    timeline.windows[0]!.frames = timeline.windows[0]!.frames.map((frame) => {
      const { observation: _observation, ...cached } = frame
      return { ...cached, observation_source: 'not_recorded' }
    })
    expect(planManuscriptSourceTail(scene, timeline, 2, new Set())).toBeUndefined()
    timeline.windows[0]!.frames = timeline.windows[0]!.frames.map(frame => ({ ...frame, image_available: false }))
    expect(planManuscriptSourceTail(scene, timeline, 2, new Set())).toBeUndefined()
    expect(planManuscriptSourceTail(scene, { ...timeline, windows: [] }, 2, new Set())).toBeUndefined()
  })

  it('does not request pending post-ASR cache images or replace them with earlier rolling images', () => {
    const { scene, timeline } = sourceTailFixture()
    timeline.windows[0]!.frames = timeline.windows[0]!.frames.map((frame) => {
      if (frame.time <= 84) return frame
      const { observation: _observation, ...cached } = frame
      return { ...cached, observation_source: 'not_recorded' }
    })
    expect(planManuscriptSourceTail(scene, timeline, 2, new Set())).toBeUndefined()
  })

  it('deduplicates repeated cache rows, avoids already returned tail frames and does not relabel earlier images as new tail evidence', () => {
    const { scene, timeline } = sourceTailFixture()
    timeline.windows[0]!.frames.push(timeline.windows[0]!.frames.find(frame => frame.frame_id === 'tail-last')!)
    const one = planManuscriptSourceTail(scene, timeline, 2, new Set(['tail-first']))
    expect(one?.images.map(image => image.frame_id)).toEqual(['tail-last'])
    expect(planManuscriptSourceTail(scene, timeline, 2, new Set(['tail-first', 'tail-last']))).toBeUndefined()
    timeline.windows[0]!.frames = timeline.windows[0]!.frames.filter(frame => frame.time < 84)
    expect(planManuscriptSourceTail(scene, timeline, 2, new Set(timeline.windows[0]!.frames.map(frame => frame.frame_id)))).toBeUndefined()
  })
})

function sparseChangedFixture() {
  const scene = manuscriptScenes('第1集\n1-1 家 日 内\n▲甲停住。\n甲：这是原片已经有的一整句较长对白。\n乙（转身）：回来。')[0]!
  const location: ManuscriptSourceLocation = { anchors: [], between_dialogue_lines: [], window_seconds: 8,
    line_candidates: [{ line: 4, quote: '甲：这是原片已经有的一整句较长对白。', candidates: [
      { segment_id: 'early', start_seconds: 0.08, end_seconds: 5, literal_match: 'exact', matched_characters: 18 }] },
    { line: 5, quote: '乙（转身）：回来。', candidates: [
      { segment_id: 'later', start_seconds: 20, end_seconds: 21, literal_match: 'exact', matched_characters: 2 }] }],
    visual_queries: [{ line: 3, quote: '▲甲停住。', kind: 'action_line', time_candidates: [{ start_seconds: 0,
      end_seconds: 0.08, relation: 'before_speech_candidate', segment_ids: ['early'] }] },
    { line: 5, quote: '乙（转身）：回来。', kind: 'dialogue_parenthetical', time_candidates: [{ start_seconds: 20,
      end_seconds: 21, relation: 'within_speech_candidate', segment_ids: ['later'] }] }],
    windows: [{ window_id: 'all', start_seconds: 0, end_seconds: 24, event_notes: [], speech_segment_ids: ['early', 'later'],
      continuous_speech_candidate_indexes: [], frames: [frame('early-only', 0, true), frame('later-before', 20),
        frame('later-anchor', 20.5, true), frame('later-after', 21)] }] }
  return { scene, location }
}

it('preserves a sparse first changed sample and fills its unused allowance from a distinct changed range', () => {
  const { scene, location } = sparseChangedFixture()
  const first = planManuscriptVideoPackets(scene, location, 1, new Set(), new Set([3, 5]))
  const filled = planManuscriptVideoPackets(scene, location, 2, new Set(), new Set([3, 5]))
  expect(first.selected[0]?.images).toEqual([{ frame_id: 'early-only', time: 0, role: 'anchor' }])
  expect(filled.selected[0]).toEqual(first.selected[0])
  expect(filled.selected.map(packet => packet.images.map(image => image.frame_id))).toEqual([['early-only'], ['later-anchor']])
  expect(filled.selected[1]?.changed_visual_lines?.map(line => line.line)).toEqual([5])
  expect(filled.selected[1]?.interval).toEqual({ start_seconds: 20, end_seconds: 21,
    relation: 'within_speech_candidate', segment_ids: ['later'] })
})

it.each([0, 1, 2, 3, 4, 8])('refills at most the allowance %s without repeating frames or temporal ranges', (count) => {
  const { scene, location } = sparseChangedFixture()
  const repeated = { ...location, visual_queries: [...location.visual_queries, { ...location.visual_queries[1]!,
    time_candidates: [{ start_seconds: 20, end_seconds: 21, relation: 'within_speech_candidate', segment_ids: ['other'] }] }] }
  const plan = planManuscriptVideoPackets(scene, repeated, count, new Set(), new Set([3, 5]))
  const images = plan.selected.flatMap(packet => packet.images), ranges = plan.selected.map(packet =>
    JSON.stringify([packet.interval.start_seconds, packet.interval.end_seconds]))
  expect(images.length).toBeLessThanOrEqual(count)
  expect(new Set(images.map(image => image.frame_id)).size).toBe(images.length)
  expect(new Set(ranges).size).toBe(ranges.length)
  if (count === 0) expect(plan.selected).toEqual([])
  if (count >= 4) expect(images).toHaveLength(4)
})

it('does not refill with excluded cache identities or manufacture frames when only one remains', () => {
  const { scene, location } = sparseChangedFixture()
  const excluded = new Set(['later-before', 'later-anchor', 'later-after'])
  const one = planManuscriptVideoPackets(scene, location, 4, excluded, new Set([3, 5]))
  expect(one.selected.flatMap(packet => packet.images.map(image => image.frame_id))).toEqual(['early-only'])
  const none = planManuscriptVideoPackets(scene, location, 4, new Set([...excluded, 'early-only']), new Set([3, 5]))
  expect(none.selected.flatMap(packet => packet.images)).toEqual([])
})

function packetTimeline(windows: VideoSourceTimeline['windows']): VideoSourceTimeline {
  return { advisory: true, semantic_assessment: 'not_performed', source: { review_id: VideoReviewId('event-review'),
    episode: '1', path: '/source.mp4', source_version: 'event-v1', follow_up: { status: 'active' }, duration_seconds: 24, scanned_until: 24, scan_complete: true },
  scope: { start_seconds: 0, end_seconds: 24, full_episode: true, window_seconds: 8 }, material_sha256: 'event-material',
  windows, notice: '仅为候选材料。' }
}

function eventFixture() {
  const { scene, location } = fixture()
  const note: VideoSourceTimeline['windows'][number]['event_notes'][number] = { event_id: 'E1', frame_ids: ['D', 'E'],
    actor: 'OLD_EVENT_ACTOR', action: 'OLD_EVENT_ACTION', object: '旧道具记录', before: '旧事件之前', after: '旧事件之后', uncertainty: '尚未核实',
    start_seconds: 11.7, end_seconds: 12, observation_digest: 'prior-observations',
    evidence_source: 'model_authored_observations', evidence_current: true }
  const windows = location.windows.map(window => ({ ...window, event_notes: window.window_id === 'W2' ? [note] : [] }))
  return { scene, location: { ...location, windows }, note, timeline: packetTimeline(windows),
    changed: new Set([location.visual_queries[0]!.line]) }
}

function cachedImages(ids: readonly string[]): Map<string, ImageBlock> {
  return new Map(ids.map(id => [id, { type: 'image', attachment: { attachmentId: AttachmentId(`test:${id}`),
    mediaType: 'image/png', width: 1, height: 1, bytes: 4 } }]))
}

it('uses current event frame references inside a selected literal range without promoting the event to semantic alignment', () => {
  const { scene, location, changed } = eventFixture()
  const plan = planManuscriptVideoPackets(scene, location, 2, new Set(), changed)
  expect(plan.selected[0]).toMatchObject({ interval: { start_seconds: 10, end_seconds: 14, segment_ids: ['whole'] },
    images: [{ frame_id: 'D' }, { frame_id: 'E' }], sampling_interval: { start_seconds: 11.7, end_seconds: 12 },
    event_selection: { event_id: 'E1', referenced_frame_ids: ['D', 'E'], context_frame_ids: [],
      association: 'event_frame_refs_not_asr_or_verified_action_alignment' } })
  expect(plan.selected_event_ids).toEqual(['E1'])
  expect(plan.candidates.find(packet => packet.interval.segment_ids[0] === 'short')?.event_candidates).toEqual([])
})

it.each([0, 1, 2, 4])('keeps the shared event-image allowance %s and excludes already returned cache identities', (count) => {
  const { scene, location, changed } = eventFixture()
  const plan = planManuscriptVideoPackets(scene, location, count, new Set(['D']), changed)
  const ids = plan.selected.flatMap(packet => packet.images.map(image => image.frame_id))
  expect(ids.length).toBeLessThanOrEqual(count)
  expect(new Set(ids).size).toBe(ids.length)
  expect(ids).not.toContain('D')
  expect(new Set(plan.selected_event_ids).size).toBe(plan.selected_event_ids.length)
  if (count === 0) expect(plan.selected).toEqual([])
})

it('uses only recorded context links around a single event frame and otherwise keeps the event sample singular', () => {
  const { scene, location, note, changed } = eventFixture()
  const single = { ...note, frame_ids: ['E'], start_seconds: 12, end_seconds: 12 }
  const windows = location.windows.map(window => ({ ...window, event_notes: window.window_id === 'W2' ? [single] : [],
    frames: window.frames.map(frame => frame.frame_id === 'F' ? { ...frame, reasons: ['context_for:E'] } : frame) }))
  const linked = planManuscriptVideoPackets(scene, { ...location, windows }, 2, new Set(), changed)
  expect(linked.selected.find(packet => packet.event_selection)?.images.map(image => image.frame_id)).toEqual(['E', 'F'])
  expect(linked.selected[0]?.event_selection?.context_frame_ids).toEqual(['F'])
  const unlinked = planManuscriptVideoPackets(scene, { ...location, windows: windows.map(window => ({ ...window,
    frames: window.frames.map(frame => frame.frame_id === 'F' ? { ...frame, reasons: ['coverage'] } : frame) })) }, 2, new Set(), changed)
  expect(unlinked.selected.find(packet => packet.event_selection)?.images.map(image => image.frame_id)).toEqual(['E'])
})

it('retains stale and unavailable event references while falling back to the existing temporal selection', () => {
  const { scene, location, note, changed } = eventFixture()
  const stale = { ...note, evidence_current: false }
  const windows = location.windows.map(window => ({ ...window, event_notes: window.window_id === 'W2' ? [stale] : [] }))
  const plan = planManuscriptVideoPackets(scene, { ...location, windows }, 2, new Set(), changed)
  expect(plan.selected[0]?.images.map(image => image.frame_id)).toEqual(['D', 'F'])
  expect(plan.selected[0]?.event_candidates).toMatchObject([{ event_id: 'E1', evidence_current: false }])
  expect(plan.selected_event_ids).toEqual([])
  const missing = { ...note, frame_ids: ['missing', 'E'] }
  const unavailable = planManuscriptVideoPackets(scene, { ...location, windows: windows.map(window => ({ ...window,
    event_notes: window.window_id === 'W2' ? [missing] : [], frames: window.frames.map(frame => frame.frame_id === 'E'
      ? { ...frame, image_available: false } : frame) })) }, 2, new Set(), changed)
  expect(unavailable.selected[0]?.event_candidates).toMatchObject([{ missing_local_frame_ids: ['missing'], unreadable_frame_ids: ['E'] }])
  expect(unavailable.selected[0]?.event_selection).toBeUndefined()
  expect(unavailable.selected[0]?.images.length).toBeGreaterThan(0)
})

it('deduplicates a shared event across windows and packets without suppressing its later references', () => {
  const { scene, location, note } = eventFixture()
  const shared = { ...note, frame_ids: ['A', 'E'], start_seconds: 3.3, end_seconds: 12 }
  const windows = location.windows.map(window => ({ ...window, event_notes: [shared] }))
  const changed = new Set(location.visual_queries.map(query => query.line))
  const plan = planManuscriptVideoPackets(scene, { ...location, windows }, 4, new Set(), changed)
  expect(plan.selected_event_ids).toEqual(['E1'])
  const ids = plan.selected.flatMap(packet => packet.images.map(image => image.frame_id))
  const timeline = packetTimeline(windows), blocks = manuscriptVideoPacketContent({ timeline, documentSha256: 'draft', plans: [plan],
    images: cachedImages(ids), indexRows: 50 })
  expect(manuscriptPacketEventIds(timeline, [plan], new Set(ids))).toEqual(['E1'])
  const text = blocks.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n')
  expect([...text.matchAll(/OLD_EVENT_ACTION/gu)]).toHaveLength(1)
  const prior: PacketContext = { document_sha256: 'draft', previous_status: 'available', excluded_event_ids: new Set(['E1']) }
  const next = planManuscriptVideoPackets(scene, { ...location, windows }, 2, new Set(), changed, prior)
  expect(next.selected_event_ids).toEqual([])
  const nextIds = next.selected.flatMap(packet => packet.images.map(image => image.frame_id))
  const repeated = manuscriptVideoPacketContent({ timeline, documentSha256: 'draft', plans: [next], images: cachedImages(nextIds), indexRows: 50 })
  expect(JSON.stringify(repeated)).not.toContain('OLD_EVENT_ACTION')
  expect(JSON.stringify(repeated)).toContain('already_presented_event_refs')
})

it('places original image blocks before prior frame observations and full event interpretation beside text-hunk candidates', () => {
  const { scene, location, timeline, changed } = eventFixture(), line = location.visual_queries[0]!.line
  const context: PacketContext = { document_sha256: 'current-file', previous_status: 'available', previous_hunks: [{
    basis: 'complete_read_source_difference', before: [{ line: 9, quote: 'OLD_SOURCE_QUOTE' }], after_lines: [line],
    source_path: '/read-draft.md', source_text_sha256: 'read-text-hash' }] }
  const plan = planManuscriptVideoPackets(scene, location, 2, new Set(), changed, context)
  const ids = plan.selected.flatMap(packet => packet.images.map(image => image.frame_id))
  const blocks = manuscriptVideoPacketContent({ timeline, documentSha256: 'current-file', plans: [plan], images: cachedImages(ids), indexRows: 50 })
  const lastImage = blocks.findLastIndex(block => block.type === 'image')
  const observations = blocks.findIndex(block => block.type === 'text' && block.text.startsWith('{"manuscript_prior_frame_observations":'))
  const events = blocks.findIndex(block => block.type === 'text' && block.text.includes('OLD_EVENT_ACTION'))
  expect(observations).toBeGreaterThan(lastImage)
  expect(events).toBeGreaterThan(lastImage)
  const packet = blocks.find(block => block.type === 'text' && block.text.startsWith('{"manuscript_source_packet":'))
  const raw: unknown = JSON.parse(packet?.type === 'text' ? packet.text : '{}')
  expect(raw).toMatchObject({ manuscript_source_packet: { document_sha256: 'current-file', previous_text: {
    status: 'same_text_diff_hunk_candidates', context_document_sha256: 'current-file', adoption: 'not_asserted',
    mapping: 'text_diff_hunk_not_semantic_line_pair', hunks: [{ before: [{ line: 9, quote: 'OLD_SOURCE_QUOTE' }],
      source_path: '/read-draft.md', source_text_sha256: 'read-text-hash', source_role: 'read_text_comparison_candidate_not_approved_baseline' }] } } })
})

it('distinguishes missing corresponding hunks from unavailable previous context and labels native prior text separately', () => {
  const { scene, location, timeline, changed } = eventFixture(), line = location.visual_queries[0]!.line
  for (const [context, expected] of [
    [undefined, 'context_not_supplied'], [{ document_sha256: 'draft', previous_status: 'unavailable' }, 'previous_context_unavailable'],
    [{ document_sha256: 'draft', previous_status: 'available', previous_hunks: [] }, 'no_corresponding_hunk_supplied'],
  ] satisfies [PacketContext | undefined, string][]) {
    const plan = planManuscriptVideoPackets(scene, location, 1, new Set(), changed, context)
    const blocks = manuscriptVideoPacketContent({ timeline, documentSha256: 'draft', plans: [plan], images: new Map(), indexRows: 0 })
    expect(JSON.stringify(blocks)).toContain(expected)
  }
  const native = planManuscriptVideoPackets(scene, location, 1, new Set(), changed, { document_sha256: 'draft', previous_status: 'available',
    previous_hunks: [{ basis: 'successful_native_mutation', before: [{ line: 4, quote: '上次原生保存原句' }], after_lines: [line] }] })
  expect(JSON.stringify(manuscriptVideoPacketContent({ timeline, documentSha256: 'draft', plans: [native], images: new Map(), indexRows: 0 })))
    .toContain('previous_native_saved_text_not_approved_baseline')
})

it('pairs already selected source-tail images with an event and scene-time candidates without relabeling the tail as draft alignment', () => {
  const { timeline } = sourceTailFixture()
  const scene = manuscriptScenes('第1集\n1-1 家 日 内\n甲：最后一句。\n▲甲抬起手。')[0]!
  const note: VideoSourceTimeline['windows'][number]['event_notes'][number] = { event_id: 'tail-event', frame_ids: ['tail-first', 'tail-last'],
    actor: '旧人物解释', action: 'OLD_TAIL_EVENT', object: '', before: '', after: '', uncertainty: '', start_seconds: 84.2, end_seconds: 85.9,
    observation_digest: 'tail-observations', evidence_source: 'model_authored_observations', evidence_current: true }
  const source = { ...timeline, windows: timeline.windows.map(window => ({ ...window, event_notes: [note] })) }
  const location: ManuscriptSourceLocation = { windows: source.windows, window_seconds: 8, anchors: [], between_dialogue_lines: [],
    line_candidates: [{ line: 3, quote: '甲：最后一句。', candidates: [{ segment_id: 'last', start_seconds: 82, end_seconds: 84,
      literal_match: 'exact', matched_characters: 4 }] }], visual_queries: [{ line: 4, quote: '▲甲抬起手。', kind: 'action_line',
      time_candidates: [{ start_seconds: 84, end_seconds: 86, relation: 'after_speech_candidate', segment_ids: ['last'] }] }] }
  const tail = planManuscriptSourceTail(scene, source, 2, new Set())!
  const ids = tail.images.map(image => image.frame_id)
  const plan = planManuscriptVideoPackets(scene, location, 0, new Set(ids), new Set([4]))
  plan.selected.push(tail)
  const blocks = manuscriptVideoPacketContent({ timeline: source, documentSha256: 'tail-draft', plans: [plan], images: cachedImages(ids), indexRows: 50 })
  expect(manuscriptPacketEventIds(source, [plan], new Set(ids))).toEqual(['tail-event'])
  const packet = blocks.find(block => block.type === 'text' && block.text.startsWith('{"manuscript_source_packet":'))
  const raw: unknown = JSON.parse(packet?.type === 'text' ? packet.text : '{}')
  expect(raw).toMatchObject({ manuscript_source_packet: { origin: 'source_timeline', actual_current_lines: [],
    candidate_current_lines: [{ line: 4, quote: '▲甲抬起手。' }], event_refs: [{ event_id: 'tail-event' }] } })
  expect(blocks.filter(block => block.type === 'image')).toHaveLength(2)
  expect([...JSON.stringify(blocks).matchAll(/OLD_TAIL_EVENT/gu)]).toHaveLength(1)
})

it('places a returned source-tail event interpretation after images even when no manuscript line has a time candidate', () => {
  const { scene, timeline } = sourceTailFixture()
  const note: VideoSourceTimeline['windows'][number]['event_notes'][number] = { event_id: 'unaligned-tail',
    frame_ids: ['tail-first', 'tail-last'], actor: '旧人物解释', action: 'UNALIGNED_TAIL_EVENT', object: '', before: '', after: '',
    uncertainty: '', start_seconds: 84.2, end_seconds: 85.9, observation_digest: 'tail-observations',
    evidence_source: 'model_authored_observations', evidence_current: true }
  const source = { ...timeline, windows: timeline.windows.map(window => ({ ...window, event_notes: [note] })) }
  const location: ManuscriptSourceLocation = { windows: source.windows, window_seconds: 8, anchors: [],
    between_dialogue_lines: [], line_candidates: [], visual_queries: [] }
  const tail = planManuscriptSourceTail(scene, source, 2, new Set())!
  const ids = tail.images.map(image => image.frame_id)
  const plan = planManuscriptVideoPackets(scene, location, 0, new Set(ids))
  plan.selected.push(tail)
  const blocks = manuscriptVideoPacketContent({ timeline: source, documentSha256: 'unaligned-draft', plans: [plan],
    images: cachedImages(ids), indexRows: 50 })
  const lastImage = blocks.findLastIndex(block => block.type === 'image')
  const interpretation = blocks.findIndex(block => block.type === 'text' && block.text.includes('UNALIGNED_TAIL_EVENT'))
  expect(interpretation).toBeGreaterThan(lastImage)
  expect(blocks.filter(block => block.type === 'image')).toHaveLength(2)
  expect(manuscriptPacketEventIds(source, [plan], new Set(ids))).toEqual(['unaligned-tail'])
  const packet = blocks.find(block => block.type === 'text' && block.text.startsWith('{"manuscript_source_packet":'))
  const raw: unknown = JSON.parse(packet?.type === 'text' ? packet.text : '{}')
  expect(raw).toMatchObject({ manuscript_source_packet: { origin: 'source_timeline', actual_current_lines: [],
    candidate_current_lines: [], event_refs: [{ event_id: 'unaligned-tail' }] } })
  const prior = blocks.find(block => block.type === 'text' && block.text.startsWith('{"manuscript_prior_event_interpretations":'))
  const explanation: unknown = JSON.parse(prior?.type === 'text' ? prior.text : '{}')
  expect(explanation).toMatchObject({ manuscript_prior_event_interpretations: { events: [{
    event: { event_id: 'unaligned-tail', action: 'UNALIGNED_TAIL_EVENT' }, candidate_current_lines: [] }] } })
})
