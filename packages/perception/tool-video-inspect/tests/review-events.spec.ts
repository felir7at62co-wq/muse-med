import { expect, it } from 'vitest'
import { bindReviewEvents, reviewEventCurrent, reviewEventEvidence, reviewEventNoteSchema } from '../src/review-events.ts'
import { compareReviewDraft } from '../src/review-compare.ts'
import { reviewSpeech } from '../src/review-speech.ts'
import { VideoReviewId } from '../src/review-state.ts'

const frames = [{ id: 'F00001', time: 1, reasons: ['opening'], exposed: true,
  observation: { visible: '男子坐在桌旁，右手握着酒杯。', change: '初始画面。', uncertainty: '' } },
{ id: 'F00002', time: 2, reasons: ['appearance'], exposed: true,
  observation: { visible: '男子站起，酒杯仍握在手里。', change: '男子从椅子上站起。', uncertainty: '' } },
{ id: 'F00003', time: 3, reasons: ['closing'], exposed: false }]
const note = { event_id: 'E1', frame_ids: ['F00002', 'F00001'], actor: '男子', action: '从椅子上站起',
  object: '酒杯', before: '坐在桌旁', after: '站起，仍握酒杯', uncertainty: '是否离开桌边尚不确定' }

it('groups several recorded frames into one event and derives sampled timing without approving action meaning', () => {
  const events = bindReviewEvents([note], frames)
  expect(events).toHaveLength(1)
  expect(events[0]).toMatchObject({ frame_ids: ['F00001', 'F00002'], start_seconds: 1, end_seconds: 2, uncertainty: note.uncertainty })
  expect(reviewEventCurrent(events[0]!, frames)).toBe(true)
  const changed = frames.map(frame => frame.id === 'F00001' ? { ...frame,
    observation: { visible: '男子双手空着，坐在桌旁。', change: '观察已更正。', uncertainty: '' } } : frame)
  expect(reviewEventCurrent(events[0]!, changed)).toBe(false)
  expect(bindReviewEvents([], frames)).toEqual([])
})

it('refuses missing, unrecorded or duplicate frame references and duplicate event identities', () => {
  for (const ids of [[], ['missing'], ['F00003'], ['F00001', 'F00001']]) {
    expect(() => bindReviewEvents([{ ...note, frame_ids: ids }], frames)).toThrow('VIDEO_EVENT_FRAME')
  }
  expect(() => bindReviewEvents([note, note], frames)).toThrow('VIDEO_EVENT_DUPLICATE')
  expect(() => bindReviewEvents([{ ...note, frame_ids: [] }], frames)).toThrow('VIDEO_EVENT_FRAME')
})

it('orders simultaneous observations and events deterministically, then exposes stale evidence', () => {
  const simultaneous = [{ ...frames[0]!, id: 'B', time: 1 }, { ...frames[1]!, id: 'A', time: 1 }]
  const eventNotes = [{ ...note, event_id: 'later', frame_ids: ['B'] },
    { ...note, event_id: 'tie', frame_ids: ['B', 'A'] },
    { ...note, event_id: 'earlier', frame_ids: ['A'] }]
  const events = bindReviewEvents(eventNotes, simultaneous)
  expect(events.map(event => event.frame_ids)).toEqual([['B'], ['A', 'B'], ['A']])
  expect(reviewEventCurrent(events[1]!, simultaneous)).toBe(true)
  expect(reviewEventCurrent(events[1]!, [simultaneous[0]!])).toBe(false)
  expect(reviewEventEvidence(events[1]!, [simultaneous[0]!])).toEqual([
    { frame_id: 'A', status: 'not_recorded' },
    { frame_id: 'B', time: 1, ...simultaneous[0]!.observation, status: 'recorded' },
  ])

})

it('orders tied sampled frames by identity and distinguishes missing from unobserved event evidence', () => {
  const tied = [frames[1]!, { ...frames[0]!, time: 2 }]
  const [event] = bindReviewEvents([note], tied)
  expect(event?.frame_ids).toEqual(['F00001', 'F00002'])
  expect(reviewEventCurrent(event!, tied.toReversed())).toBe(true)
  expect(reviewEventCurrent(event!, [tied[0]!])).toBe(false)
  expect(reviewEventEvidence({ ...event!, frame_ids: ['missing', 'F00003', 'F00001'] }, frames))
    .toEqual([{ frame_id: 'missing', status: 'not_recorded' },
      { frame_id: 'F00003', time: 3, status: 'not_recorded' },
      { frame_id: 'F00001', time: 1, ...frames[0]!.observation, status: 'recorded' }])
  const events = bindReviewEvents([
    { ...note, event_id: 'later', frame_ids: ['F00002'] },
    { ...note, event_id: 'long', frame_ids: ['F00001', 'F00002'] },
    { ...note, event_id: 'short', frame_ids: ['F00001'] },
  ], frames)
  expect(events.map(value => value.event_id)).toEqual(['short', 'long', 'later'])
})

it('orders simultaneous observations and overlapping events deterministically', () => {
  const simultaneous = frames.map(frame => ({ ...frame, time: frame.id === 'F00002' ? 1 : frame.time }))
  const early = { ...note, event_id: 'early', frame_ids: ['F00001'] }
  const events = bindReviewEvents([note, early], frames)
  expect(events.map(event => event.event_id)).toEqual(['early', 'E1'])
  expect(bindReviewEvents([note], simultaneous)[0]?.frame_ids).toEqual(['F00001', 'F00002'])
  const current = bindReviewEvents([note], simultaneous)[0]
  if (!current) throw Error('Missing event fixture')
  expect(reviewEventCurrent(current, simultaneous)).toBe(true)
})

it('accepts a meaningful single-character Chinese action without imposing a writing-length quota', () => {
  const sitting = reviewEventNoteSchema.parse({ ...note, actor: '周宁', action: '坐', object: '椅子' })
  expect(bindReviewEvents([sitting], frames)[0]).toMatchObject({ actor: '周宁', action: '坐', object: '椅子' })
  expect(() => reviewEventNoteSchema.parse({ ...note, action: ' ' })).toThrow()
})

it('links saved event evidence to speech timecodes and literal draft lines without a semantic pass verdict', () => {
  const review = { id: VideoReviewId('review'), path: 'episode.mp4', episode: '第1集', source_version: 'video-v1',
    duration: 4, scanned_until: 4, scan_complete: true, frames, event_groups: bindReviewEvents([note], frames) }
  const speech = reviewSpeech({ path: 'asr.json', version: 'asr-v1', text: JSON.stringify([
    { start: 0, end: 0.5, text: '在前面。', speaker_id: '1' },
    { start: 1, end: 2.5, text: '先别走。', speaker_id: '2' },
  ]) }, 4)
  const result = compareReviewDraft(review, { path: 'draft.md', version: 'draft-v1',
    text: '▲男子从椅子上站起，握着酒杯。\n男子：先别走。' }, speech)
  expect(result.event_groups[0]).toMatchObject({ evidence_current: true, speech_segment_ids: ['S00002'],
    evidence_source: 'model_authored_observations', evidence: [
      { frame_id: 'F00001', visible: frames[0]!.observation!.visible }, { frame_id: 'F00002', visible: frames[1]!.observation!.visible },
    ],
    literal_draft_candidates: [{ line: 1, text: '▲男子从椅子上站起，握着酒杯。', matched_fields: ['actor', 'action', 'object'] }] })
  expect(result.ungrouped_recorded_frame_ids).toEqual([])
  expect(result.speech?.segments).toHaveLength(2)
  expect(result.semantic_assessment).toBe('not_performed')
  expect(result.checks).toContain('未命中也不等于遗漏')
  const stale = compareReviewDraft({ ...review, frames: [frames[1]!] }, { path: 'draft.md', version: 'draft-v2', text: '甲：你好。' })
  expect(stale.event_groups[0]?.evidence_current).toBe(false)
  expect(stale.ungrouped_recorded_frame_ids).toEqual(['F00002'])
})
