/** Packing and splitting keep each word's measured time and flag what crosses a shot boundary. */
import { expect, it } from 'vitest'
import { attachPunctuation, packSha256, planPacks, splitPack } from '../src/asr-pack.ts'

const shots = [{ audio_sha256: 'a', samples: 300 }, { audio_sha256: 'b', samples: 300 }, { audio_sha256: 'c', samples: 500 }]

it('packs greedily in order with silence after each shot and gives an oversized shot its own pack', () => {
  const packs = planPacks(shots, 700, 50, 100)
  expect(packs.map(pack => pack.members.map(member => [member.audio_sha256, member.offset_samples]))).toEqual([[['a', 0], ['b', 350]], [['c', 0]]])
  expect(packs.map(pack => pack.samples)).toEqual([700, 550])
  expect(planPacks([{ audio_sha256: 'x', samples: 900 }], 700, 50, 100)[0]?.members).toHaveLength(1)
  expect(packs[0]?.sha256).toBe(packSha256(shots.slice(0, 2), 50, 100))
  expect(packSha256(shots.slice(0, 2), 50, 100)).not.toBe(packSha256(shots.slice(0, 2), 40, 100))
})

it('assigns words by midpoint, flags gap and crossing words, and keeps segment timing without words', () => {
  const [pack] = planPacks(shots.slice(0, 2), 10_000, 50, 100)
  const split = splitPack([
    { start: 0.5, end: 3.4, text: '你好，回来了', words: [{ start: 0.5, end: 0.9, text: '你' }, { start: 1, end: 1.4, text: '好' },
      { start: 2.9, end: 3.1, text: '回' }, { start: 3.0, end: 3.2, text: '来了' }] },
    { start: 3.6, end: 5.5, text: '没有字词时间的一整段' },
  ], pack!)
  expect(split.get('a')).toEqual({ words: [{ start: 0.5, end: 0.9, text: '你', seg: 0 }, { start: 1, end: 1.4, text: '好，', seg: 0 },
    { start: 2.9, end: 3, text: '回', seg: 0 }, { start: 3, end: 3, text: '来了', seg: 0 }],
  flags: [{ kind: 'boundary', start: 2.9, end: 3 }, { kind: 'boundary', start: 3, end: 3 }] })
  expect(split.get('b')).toEqual({ words: [{ start: 0.1, end: 2, text: '没有字词时间的一整段', seg: 1 }], flags: [] })
})

it('attaches following punctuation and spaces to the preceding word and refuses mismatched text', () => {
  expect(attachPunctuation('林辰，你 回来了！', [{ text: '林' }, { text: '辰' }, { text: '你' }, { text: '回来' }, { text: '了' }]))
    .toEqual(['林', '辰，', '你 ', '回来', '了！'])
  expect(attachPunctuation('别的话', [{ text: '你' }])).toEqual(['你'])
})
