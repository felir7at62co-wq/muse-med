import { expect, it } from 'vitest'
import { parseBlindDialogueObservation, reconcileBlindDialogue, validateBlindAuthoredDialogue } from '../src/content-listening-blind.ts'

const duration = 56_133_333
const reviewed = (start_us = 0, end_us = duration) => ({ start_us, end_us, status: 'reviewed' as const })
const spoken = (text: string, start_us = 10_650_000, end_us = 10_900_000) => ({ start_us, end_us, text })
const advisory = { listening_verified: false, grants_approval: false }

it('compares spoken characters across adjacent reported intervals without giving approval', () => {
  const observation = {
    ranges: [reviewed(0, 10_800_000), reviewed(10_800_000)],
    utterances: [spoken(' 哼，'), spoken('收到！Ａ', 12_000_000, 13_000_000)],
  }
  expect(reconcileBlindDialogue(duration, observation, ['哼！收 到', 'A'])).toEqual({
    observation: { ...observation, utterances: [spoken('哼，'), observation.utterances[1]] },
    status: 'needs_review', findings: [], ...advisory,
  })
})

it('surfaces a missing written character without inventing its spoken time', () => {
  // The recorded EP21 036 concern was the short 「哼」 at 10.650–10.900 seconds.
  // These observations exercise missing and identical transcriptions of that word, not an audio verdict.
  const empty = { ranges: [reviewed()], utterances: [] }
  expect(reconcileBlindDialogue(duration, empty, ['哼'])).toMatchObject({
    status: 'issues_found', findings: [
      { kind: 'omitted', authored_offset: 0, observed_offset: 0, authored_count: 1, observed_count: 0 },
    ], ...advisory,
  })
  expect(reconcileBlindDialogue(duration, empty, ['哼']).findings[0]).not.toHaveProperty('start_us')
  expect(reconcileBlindDialogue(duration, { ...empty, utterances: [spoken('哼')] }, ['哼'])).toMatchObject({
    status: 'needs_review', findings: [], ...advisory,
  })
})

it.each([
  { authored: '开门吧', seen: '开门', kind: 'omitted', authoredCount: 1, observedCount: 0 },
  { authored: '开门吧', seen: '开门啊', kind: 'replaced', authoredCount: 1, observedCount: 1 },
  { authored: '开门', seen: '开门吧', kind: 'inserted', authoredCount: 0, observedCount: 1 },
])('identifies $kind edits in a completely reported transcript', ({ authored, seen, kind, authoredCount, observedCount }) => {
  const { start_us, end_us } = spoken(seen)
  const result = reconcileBlindDialogue(duration, { ranges: [reviewed()], utterances: [spoken(seen)] }, [authored])
  expect(result).toMatchObject({ status: 'issues_found', ...advisory })
  expect(result.findings).toEqual([{ kind, authored_offset: 2, observed_offset: 2,
    authored_count: authoredCount, observed_count: observedCount,
    ...(kind === 'omitted' ? {} : { start_us, end_us }) }])
})

it('retains the bounds of the observed utterance for a consecutive replacement', () => {
  const observation = { ranges: [reviewed()], utterances: [spoken('𠮷乙'), spoken('错字', 12_000_000, 13_000_000)] }
  const result = reconcileBlindDialogue(duration, observation, ['𠮷乙对白'])
  expect(result.findings).toEqual([{ kind: 'replaced', authored_offset: 2, observed_offset: 2,
    authored_count: 2, observed_count: 2, start_us: 12_000_000, end_us: 13_000_000 }])
})

it('distinguishes reported uncertainty from skipped time and withholds character findings', () => {
  const raw = {
    ranges: [reviewed(200, 400), { start_us: 400, end_us: 600, status: 'uncertain' }, reviewed(700, 1000)],
    utterances: [spoken('不清楚', 720, 800)],
  }
  expect(reconcileBlindDialogue(duration, raw, ['另一句话'])).toMatchObject({
    status: 'needs_review', ...advisory, findings: [
      { kind: 'unreviewed', start_us: 0, end_us: 200 },
      { kind: 'uncertain', start_us: 400, end_us: 600 },
      { kind: 'unreviewed', start_us: 600, end_us: 700 },
      { kind: 'unreviewed', start_us: 1000, end_us: duration },
    ],
  })
})

it('distinguishes an empty report from an explicit complete silence claim', () => {
  expect(reconcileBlindDialogue(duration, { ranges: [], utterances: [] }, [])).toMatchObject({ status: 'needs_review',
    findings: [{ kind: 'unreviewed', start_us: 0, end_us: duration }], ...advisory })
  expect(reconcileBlindDialogue(duration, { ranges: [reviewed()], utterances: [] }, [])).toMatchObject({
    status: 'needs_review', findings: [], ...advisory,
  })
})

it.each([
  { ranges: [reviewed(0, 500), reviewed(499)], utterances: [] },
  { ranges: [reviewed(0, duration + 1)], utterances: [] },
  { ranges: [reviewed(0, 1.5)], utterances: [] },
  { ranges: [reviewed(0, 500), reviewed(600)], utterances: [spoken('越界', 450, 750)] },
  { ranges: [{ start_us: 0, end_us: duration, status: 'uncertain' }], utterances: [spoken('猜的')] },
  { ranges: [reviewed()], utterances: [spoken('暂无'), spoken('重叠')] },
  { ranges: [reviewed()], utterances: [spoken('。 ！')] },
  { ranges: [reviewed()], utterances: [spoken('汉'.repeat(342))] },
  { ranges: [reviewed()], utterances: [spoken('文字')], grants_approval: true },
])('rejects malformed or unbounded recognizer data', (raw) => {
  expect(() => parseBlindDialogueObservation(duration, raw)).toThrow(/盲听|实听对白/u)
})

it('bounds authored data before a request and rejects missing local duration', () => {
  expect(() => { validateBlindAuthoredDialogue(['哼', '收 到！']) }).not.toThrow()
  expect(() => { validateBlindAuthoredDialogue(['。']) }).toThrow('可比较的正文')
  expect(() => { validateBlindAuthoredDialogue(Array.from({ length: 129 }, () => '甲')) }).toThrow('上限')
  expect(() => { validateBlindAuthoredDialogue(['汉'.repeat(342)]) }).toThrow('上限')
  expect(() => { validateBlindAuthoredDialogue(Array.from({ length: 5 }, () => 'A'.repeat(512))) }).toThrow('上限')
  expect(() => parseBlindDialogueObservation(0, { ranges: [], utterances: [] })).toThrow('实测音频时长')
})
