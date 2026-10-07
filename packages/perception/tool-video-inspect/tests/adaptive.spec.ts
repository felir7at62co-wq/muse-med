/** Adaptive observations remain source ordered and report every deferred event. */
import { expect, it } from 'vitest'
import { adaptivePlan, sceneTimecodes } from '../src/adaptive.ts'

const limits = { maxFrames: 2, maxPlanPoints: 100, scenePaddingSeconds: 0.1 }
const input = { start: 0, end: 4, duration: 4, uniform: [1, 3], cuts: [2] }

it('selects both sides of a detected cut and defers ASR and uniform observations without inventing identities', () => {
  const plan = adaptivePlan({ ...input, transcript: [
    { start: 0, end: 1, text: '甲说话', speaker_id: 'job-1:0' },
    { start: 2, end: 3, text: '乙说话', speaker_id: 'job-1:1' },
  ] }, limits)
  expect(plan.selected).toEqual([{ time: 1.9, reasons: ['before_scene_cut'] }, { time: 2.1, reasons: ['after_scene_cut'] }])
  expect(plan.deferred).toEqual([{ time: 0.5, reasons: ['speaker_change_utterance'] }, { time: 1, reasons: ['uniform_checkpoint'] },
    { time: 2.5, reasons: ['speaker_change_utterance'] }, { time: 3, reasons: ['uniform_checkpoint'] }])
})

it('merges coincident events and keeps clipped utterances within the inspected range', () => {
  const plan = adaptivePlan({ ...input, start: 1, end: 3, uniform: [1.9, 2.1], transcript: { segments: [
    { start: 0, end: 0.5, text: '已过去的发声', speaker_id: '0' },
    { start: 0, end: 2, text: '开始前已在说话', speaker_id: '1' },
    { start: 2, end: 3, text: '继续说话', speaker_id: '1' },
    { start: 3, end: 4, text: '下一窗口', speaker_id: '1' },
  ] } }, { ...limits, maxFrames: 10 })
  expect(plan.selected).toEqual([{ time: 1.5, reasons: ['speaker_change_utterance'] },
    { time: 1.9, reasons: ['uniform_checkpoint', 'before_scene_cut'] }, { time: 2.1, reasons: ['uniform_checkpoint', 'after_scene_cut'] },
    { time: 2.5, reasons: ['utterance_midpoint'] }])
  expect(plan.deferred).toEqual([])
})

it('keeps a boundary-adjacent scene sample below the exclusive end and drops points outside the range', () => {
  const plan = adaptivePlan({ ...input, cuts: [0, 3.99], uniform: [-1, 4], transcript: [
    { start: 1, end: 1, text: '', speaker_id: '0' }, { start: 1, end: 1, text: '重复', speaker_id: '0' }, { start: 1, end: 1, text: '又重复', speaker_id: '0' },
  ] }, { ...limits, maxFrames: 10 })
  expect(plan.selected.map(point => point.time)).toEqual([0, 0.1, 1, 3.89, 4 - Number.EPSILON * 4])
  expect(plan.selected.find(point => point.time === 1)?.reasons).toEqual(['speaker_change_utterance', 'utterance_midpoint'])
})

it('rejects invalid transcript ranges, malformed input and candidate budget overflow', () => {
  for (const transcript of [[{ start: 2, end: 1, text: '倒序' }], [{ start: 0, end: 5, text: '其它视频' }], { nope: [] }]) {
    expect(() => adaptivePlan({ ...input, transcript }, limits)).toThrow()
  }
  expect(() => adaptivePlan(input, { ...limits, maxPlanPoints: 1 })).toThrow('point budget')
  expect(adaptivePlan({ ...input, cuts: [], transcript: [{ start: 0, end: 1, text: '未分离说话人' }] }, limits).selected[0]).toEqual({ time: 0.5, reasons: ['utterance_midpoint'] })
})

it('parses actual detector timecodes, accepts no cuts and rejects nonfinite or out-of-range detector output', () => {
  const bytes = (text: string) => Buffer.from(text)
  expect(sceneTimecodes(bytes('frame:0 pts:20 pts_time:2\nlavfi.scene_score=0.4\nframe:1 pts:20 pts_time:2\nframe:2 pts:30 pts_time:3\n'), 0, 4)).toEqual([2, 3])
  expect(sceneTimecodes(bytes(''), 0, 4)).toEqual([])
  for (const text of ['pts_time:no', 'pts_time:Infinity', 'pts_time:-1', 'pts_time:4']) expect(() => sceneTimecodes(bytes(text), 0, 4)).toThrow('invalid source timecode')
})

it('spreads a cut-heavy opening across the whole requested range while preserving every deferred event', () => {
  const plan = adaptivePlan({ start: 0, end: 12, duration: 12, uniform: [2, 6, 10], cuts: [0.5, 0.8, 1, 2, 3],
    transcript: [{ start: 5, end: 7, text: '中段对白' }] }, { ...limits, maxFrames: 3 })
  expect(plan.selected.map(point => point.time)).toEqual([1.9, 6, 10])
  expect(plan.selected[1]?.reasons).toEqual(['uniform_checkpoint', 'utterance_midpoint'])
  expect(plan.selected[2]?.reasons).toEqual(['uniform_checkpoint'])
  expect(plan.selected.length + plan.deferred.length).toBe(12)
  expect(plan.deferred.some(point => point.time === 2.1)).toBe(true)
})
