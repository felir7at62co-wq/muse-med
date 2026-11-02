/** Source windows retain frame and speech evidence without manufacturing story events. */
import { expect, it } from 'vitest'
import { buildVideoSourceTimeline } from '../src/review-timeline.ts'
import { bindReviewEvents } from '../src/review-events.ts'
import { reviewSpeech } from '../src/review-speech.ts'
import { VideoReviewId, type VideoReview } from '../src/review-state.ts'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { SessionSeq } from '@deepseek-ai/dsh-session'
import type { VideoTranscriptResolution } from '../src/review-transcript.ts'

function source(): VideoReview {
  return { id: VideoReviewId('review-1'), path: 'episode.mp4', episode: '第4集', source_version: 'v1', duration: 6,
    scan_complete: true, scanned_until: 6, frames: [
      { id: 'F00001', time: 0, reasons: ['opening'], exposed: true,
        observation: { visible: '男子坐在桌旁，手中握着茶杯。', change: '本集开场。', uncertainty: '' } },
      { id: 'F00002', time: 2, reasons: ['appearance'], exposed: true,
        observation: { visible: '男子已经站起，茶杯仍握在手中。', change: '从坐姿变为站姿。', uncertainty: '站起过程未完整呈现。' } },
      { id: 'F00003', time: 6, reasons: ['closing'], exposed: false },
    ] }
}

it('keeps boundary frames in one window and preserves silence and unrecorded frames without inventing events', () => {
  const timeline = buildVideoSourceTimeline(source(), { windowSeconds: 2 })
  expect(timeline.windows.map(window => window.frames.map(frame => frame.frame_id))).toEqual([['F00001'], ['F00002'], ['F00003']])
  expect(timeline.windows.every(window => window.event_notes.length === 0 && window.speech_segment_ids.length === 0)).toBe(true)
  expect(timeline.windows.at(-1)?.frames[0]).toMatchObject({ observation_source: 'not_recorded', exposed: false, image_available: false })
  expect(timeline).toMatchObject({ advisory: true, semantic_assessment: 'not_performed', scope: { full_episode: true } })
})

it('separates follow-up closure from observation coverage and material identity', () => {
  const review = source()
  const original = buildVideoSourceTimeline(review, { windowSeconds: 2 })
  expect(original.source.follow_up).toEqual({ status: 'active' })
  const closed = buildVideoSourceTimeline({ ...review, follow_up: { status: 'closed', reason: '不再跟进。' } },
    { windowSeconds: 2 })
  expect(closed.source.follow_up).toEqual({ status: 'closed', reason: '不再跟进。' })
  expect(closed.windows).toEqual(original.windows)
  expect(closed.material_sha256).toBe(original.material_sha256)
})

it('links overlapping original ASR and continuous-speech candidates without splitting or rewriting raw utterances', () => {
  const speech = reviewSpeech({ path: 'transcript.json', version: 'asr-v1', text: JSON.stringify([
    { start: 0.5, end: 1.5, text: '妈，', speaker_id: 1 },
    { start: 1.5, end: 3, text: '你先别走。', speaker_id: 1 },
    { start: 4, end: 5, text: '听见了吗？' },
  ]) }, 6)
  const timeline = buildVideoSourceTimeline(source(), { windowSeconds: 2 }, speech)
  expect(timeline.windows.map(window => window.speech_segment_ids)).toEqual([['S00001', 'S00002'], ['S00002'], ['S00003']])
  expect(timeline.windows.map(window => window.continuous_speech_candidate_indexes)).toEqual([[0], [0], []])
  expect(timeline.speech).toEqual(speech)
  expect(timeline.speech?.segments[2]?.speaker_id).toBeUndefined()
  expect(timeline.speech?.segments.every(segment => segment.speaker_identity_unverified)).toBe(true)
  const partial = buildVideoSourceTimeline(source(), { windowSeconds: 1, startSeconds: 2, endSeconds: 3 }, speech)
  expect(partial.speech?.segments.map(segment => segment.segment_id)).toEqual(['S00001', 'S00002'])
  expect(partial.windows[0]?.speech_segment_ids).toEqual(['S00002'])
})

it('retains uncertain model notes, identifies stale event evidence, and changes the material identity with observations', () => {
  const review = source()
  review.event_groups = bindReviewEvents([{ event_id: 'E1', frame_ids: ['F00001', 'F00002'], actor: '男子',
    action: '站起', object: '茶杯', before: '坐着', after: '站着', uncertainty: '中间过程不清楚' }], review.frames)
  const original = buildVideoSourceTimeline(review, { windowSeconds: 2 })
  expect(original.windows[0]?.event_notes[0]).toMatchObject({ evidence_current: true,
    evidence_source: 'model_authored_observations', uncertainty: '中间过程不清楚' })
  review.frames[0]!.observation!.visible = '男子站在桌旁，手中握着茶杯。'
  const changed = buildVideoSourceTimeline(review, { windowSeconds: 2 })
  expect(changed.material_sha256).not.toBe(original.material_sha256)
  expect(changed.windows[0]?.event_notes[0]?.evidence_current).toBe(false)
})

it('orders same-time frames and same-path diagnostics deterministically', () => {
  const review = source()
  review.frames.unshift({ ...review.frames[0]!, id: 'F00000' })
  const resolution: VideoTranscriptResolution = { kind: 'unavailable', same_source_verified: false,
    diagnostics: [{ path: '/project/asr.json', status: 'unavailable', reason: 'read failed' },
      { path: '/project/asr.json', status: 'valid' }] }
  const timeline = buildVideoSourceTimeline(review, { windowSeconds: 2 }, undefined, undefined, resolution)
  expect(timeline.windows[0]?.frames.map(frame => frame.frame_id)).toEqual(['F00000', 'F00001'])
  expect(timeline.material_sha256).toMatch(/^[a-f0-9]{64}$/)
})

it('reports a partial source range and unavailable ASR without completing the episode or substituting speech', () => {
  const review = source(), unavailable = { reference: { path: 'missing.json', version: 'old', sha256: 'old-hash' },
    current_version: 'changed', reason: 'missing', notice: '未使用ASR。' }
  const timeline = buildVideoSourceTimeline(review, { windowSeconds: 2, startSeconds: 1, endSeconds: 4 }, undefined, unavailable)
  expect(timeline.scope).toEqual({ start_seconds: 1, end_seconds: 4, full_episode: false, window_seconds: 2 })
  expect(timeline.windows.map(window => window.frames.map(frame => frame.frame_id))).toEqual([[], ['F00002']])
  expect(timeline.speech).toBeUndefined()
  expect(timeline.speech_unavailable).toEqual(unavailable)
  expect(review.frames.at(-1)?.observation).toBeUndefined()
})

it('keeps zero-duration ASR at an included boundary without borrowing it from the next window', () => {
  const speech = reviewSpeech({ path: 'transcript.json', version: 'asr-v1', text: JSON.stringify([
    { start: 1, end: 2, text: '好' }, { start: 3, end: 4, text: '爸' },
  ]) }, 6)
  speech.segments[0]!.start_seconds = 2
  speech.segments[0]!.end_seconds = 2
  speech.segments[1]!.start_seconds = 6
  speech.segments[1]!.end_seconds = 6
  const whole = buildVideoSourceTimeline(source(), { windowSeconds: 2 }, speech)
  expect(whole.windows.map(window => window.speech_segment_ids)).toEqual([[], ['S00001'], ['S00002']])
  const before = buildVideoSourceTimeline(source(), { windowSeconds: 2, endSeconds: 2 }, speech)
  expect(before.windows[0]?.speech_segment_ids).toEqual([])
  const after = buildVideoSourceTimeline(source(), { windowSeconds: 2, startSeconds: 2, endSeconds: 4 }, speech)
  expect(after.windows[0]?.speech_segment_ids).toEqual(['S00001'])
})

it('keeps an unavailable ASR reference without an invented current version', () => {
  const timeline = buildVideoSourceTimeline(source(), { windowSeconds: 2 }, undefined,
    { reference: { path: 'missing.json', version: 'old', sha256: 'old-hash' }, reason: 'missing', notice: '未使用ASR。' })
  expect(timeline.speech_unavailable?.current_version).toBeUndefined()
  expect(timeline.material_sha256).toMatch(/^[a-f0-9]{64}$/)
})

it('keeps equivalent workspace-copy digests stable without replacing actual source identities or paths', () => {
  const original = { ...source(), path: '/first/project/episode.mp4' }
  const copied = { ...source(), id: VideoReviewId('other-review'), path: '/second/project/episode.mp4' }
  const speech = (path: string) => reviewSpeech({ path, version: 'asr-v1', text: JSON.stringify([
    { start: 0, end: 1, text: '先别走。', speaker_id: '1' },
  ]) }, 6)
  const first = buildVideoSourceTimeline(original, { windowSeconds: 2 }, speech('/first/project/asr.json'))
  const second = buildVideoSourceTimeline(copied, { windowSeconds: 2 }, speech('/second/project/asr.json'))
  expect(first.material_sha256).toBe(second.material_sha256)
  expect(second.source.path).toBe('/second/project/episode.mp4')
  expect(second.source.review_id).toBe('other-review')
  expect(second.speech?.source.path).toBe('/second/project/asr.json')
})

it('keeps candidate receipt and diagnostic paths out of material identity while preserving actual source revisions', () => {
  const timeline = (root: string, call: string, sha256: string) => {
    const review = { ...source(), path: `${root}/source.mp4` }
    const resolution: VideoTranscriptResolution = { kind: 'successful_read_candidate', same_source_verified: false,
      reference: { path: `${root}/asr.json`, version: 'asr-v1', sha256 },
      read_receipts: [{ path: `${root}/asr.json`, readCallId: ToolCallId(call), readResultSeq: SessionSeq(call === 'first' ? 5 : 9) }],
      diagnostics: [{ path: `${root}/invalid.json`, status: 'unavailable', reason: `${root}/invalid.json: missing` },
        { path: `${root}/asr.json`, status: 'valid', reference: { path: `${root}/asr.json`, version: 'asr-v1', sha256 } }] }
    return buildVideoSourceTimeline(review, { windowSeconds: 2 }, undefined, undefined, resolution)
  }
  const first = timeline('/one/project', 'first', 'old-hash'), copied = timeline('/two/project', 'second', 'old-hash')
  expect(first.material_sha256).toBe(copied.material_sha256)
  expect(copied.transcript_resolution?.read_receipts?.[0]?.readCallId).toBe('second')
  expect(copied.transcript_resolution?.diagnostics[0]?.reason).toBe('/two/project/invalid.json: missing')
  expect(timeline('/two/project', 'second', 'new-hash').material_sha256).not.toBe(first.material_sha256)
})

it('keeps zero-duration boundary speech in its source window and sorts same-time frames', () => {
  const review = source()
  review.frames.push({ ...review.frames[0]!, id: 'A', time: 2 }, { ...review.frames[0]!, id: 'B', time: 2 })
  const base = reviewSpeech({ path: 'asr.json', version: 'asr-v1', text: JSON.stringify([
    { start: 2, end: 3, text: '开始。' }, { start: 4, end: 5, text: '结束。' },
  ]) }, 6)
  const speech = { ...base, segments: base.segments.map(segment => ({ ...segment, end_seconds: segment.start_seconds })) }
  const partial = buildVideoSourceTimeline(review, { windowSeconds: 2, startSeconds: 2, endSeconds: 4 }, speech)
  expect(partial.windows[0]?.frames.map(frame => frame.frame_id)).toEqual(['A', 'B', 'F00002'])
  expect(partial.windows[0]?.speech_segment_ids).toEqual([base.segments[0]!.segment_id])
  expect(partial.speech?.segments.map(segment => segment.segment_id)).toEqual([base.segments[0]!.segment_id])
  const closing = buildVideoSourceTimeline(review, { windowSeconds: 2 }, {
    ...speech, segments: [{ ...base.segments[1]!, start_seconds: 6, end_seconds: 6 }],
  })
  expect(closing.windows.at(-1)?.speech_segment_ids).toEqual([base.segments[1]!.segment_id])
})

it('retains current unavailable ASR revision and deterministic same-path diagnostic ordering', () => {
  const review = source(), reference = { path: 'asr.json', version: 'old', sha256: 'old-hash' }
  const unavailable = { reference, current_version: 'new', reason: 'changed', notice: '未使用ASR。' }
  const resolution: VideoTranscriptResolution = { kind: 'unavailable', same_source_verified: false,
    diagnostics: [{ path: 'asr.json', status: 'valid', reference },
      { path: 'asr.json', status: 'unavailable', reason: 'changed' }] }
  const result = buildVideoSourceTimeline(review, { windowSeconds: 2 }, undefined, unavailable, resolution)
  expect(result.speech_unavailable?.current_version).toBe('new')
  expect(result.transcript_resolution?.diagnostics).toEqual(resolution.diagnostics)
  expect(result.material_sha256).toMatch(/^[a-f0-9]{64}$/)
})

it.each([{ windowSeconds: 0 }, { windowSeconds: -1 }, { windowSeconds: Infinity },
  { windowSeconds: 2, startSeconds: -1 }, { windowSeconds: 2, startSeconds: Number.NaN },
  { windowSeconds: 2, startSeconds: Infinity }, { windowSeconds: 2, startSeconds: 7 },
  { windowSeconds: 2, endSeconds: Number.NaN }, { windowSeconds: 2, endSeconds: Infinity },
  { windowSeconds: 2, endSeconds: -1 }, { windowSeconds: 2, startSeconds: 3, endSeconds: 3 },
  { windowSeconds: 2, endSeconds: 7 }])('rejects invalid timeline ranges %j', (selection) => {
  expect(() => buildVideoSourceTimeline(source(), selection)).toThrow('VIDEO_TIMELINE_RANGE')
})

it('retains zero-duration speech at internal boundaries and the source closing timestamp', () => {
  const speech = reviewSpeech({ path: 'asr.json', version: 'v1', text: JSON.stringify([
    { start: 2, end: 2, text: '中间。' }, { start: 6, end: 6, text: '结尾。' },
  ]) }, 6)
  const timeline = buildVideoSourceTimeline(source(), { windowSeconds: 2 }, speech)
  expect(timeline.windows.map(window => window.speech_segment_ids)).toEqual([[], ['S00001'], ['S00002']])
})

it('orders simultaneous frames and gives equivalent diagnostic permutations the same material identity', () => {
  const review = source()
  review.frames = [review.frames[1]!, { ...review.frames[0]!, time: 2 }, review.frames[2]!]
  const diagnostics: VideoTranscriptResolution['diagnostics'] = [
    { path: 'asr.json', status: 'not_current_task' }, { path: 'asr.json', status: 'unavailable' },
  ]
  const resolution: VideoTranscriptResolution = { kind: 'unavailable', same_source_verified: false, diagnostics }
  const unavailable = { reference: { path: 'asr.json', version: 'old', sha256: 'old' }, current_version: 'new',
    reason: 'changed', notice: 'The current file is not the recorded transcript.' }
  const first = buildVideoSourceTimeline(review, { windowSeconds: 2 }, undefined, unavailable, resolution)
  const second = buildVideoSourceTimeline(review, { windowSeconds: 2 }, undefined, unavailable,
    { ...resolution, diagnostics: [...diagnostics].reverse() })
  expect(first.windows[1]?.frames.map(frame => frame.frame_id)).toEqual(['F00001', 'F00002'])
  expect(first.material_sha256).toBe(second.material_sha256)
})
