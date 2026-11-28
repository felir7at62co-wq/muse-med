/** Verify that local word timing retains measured intervals and rejects unmeasured words. */
import { expect, it } from 'vitest'
import { offlineWordSpans } from '../src/offline.ts'

const measured = {
  start: 0.2, end: 1.8, text: '玻璃球。',
  words: [{ start: 0.3, end: 0.8, text: '玻璃' }, { start: 1.3, end: 1.7, text: '球。' }],
}

it('keeps the measured leading and internal gaps, and returns empty for no recognized words', () => {
  expect(offlineWordSpans(JSON.stringify([measured]), 2)).toEqual([measured])
  expect(offlineWordSpans('[]', 2)).toEqual([])
  expect(offlineWordSpans(JSON.stringify([{ ...measured, text: '。', words: [{ ...measured.words[0], text: '。' }] }]), 2))
    .toEqual([])
})

it('rejects zero-length, overlapping, or out-of-range timings', () => {
  const secondWord = measured.words[1]!
  const withSecondWord = (changes: Partial<typeof secondWord>) => JSON.stringify([
    { ...measured, words: [measured.words[0], { ...secondWord, ...changes }] },
  ])
  expect(() => offlineWordSpans(withSecondWord({ end: secondWord.start }), 2)).toThrow('OFFLINE_ASR_WORD_TIME')
  expect(() => offlineWordSpans(withSecondWord({ start: 0.7 }), 2)).toThrow('OFFLINE_ASR_INFERENCE')
  expect(() => offlineWordSpans(withSecondWord({ end: 1.9 }), 2)).toThrow('OFFLINE_ASR_INFERENCE')
  expect(() => offlineWordSpans(JSON.stringify([measured]), 1.75)).toThrow('OFFLINE_ASR_INFERENCE')
})
