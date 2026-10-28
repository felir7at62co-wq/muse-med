/** Neighboring cue evidence cannot replace plot intent or fabricate missing tag checks. */
import { expect, it } from 'vitest'
import { continuityFit, resolveContinuityPolicy } from '../src/continuity.ts'

const policy = resolveContinuityPolicy({})
const family = { valence: 5, arousal: 3, tags: ['family', 'soft'] }

it('reports both abrupt emotional changes and disjoint tag sets', () => {
  expect(continuityFit(family, { valence: 5, arousal: 7, tags: ['action', 'epic'] }, policy))
    .toMatchObject({ status: 'review_required', emotion_distance: 4, tag_overlap: 0 })
  expect(continuityFit(family, { valence: 5, arousal: 4, tags: [' FAMILY ', 'soft'] }, policy))
    .toMatchObject({ status: 'compatible', emotion_distance: 1, tag_overlap: 1 })
})

it('does not mark absent labels as a completed compatibility check', () => {
  expect(continuityFit(family, { valence: 5, arousal: 4, tags: [] }, policy))
    .toMatchObject({ status: 'insufficient_tags', tag_overlap: null })
})

it.each([{ maxTransitionEmotionDistance: -1 }, { minTransitionTagOverlap: 2 }, { minTransitionTagOverlap: Number.NaN }])(
  'rejects invalid deployment continuity limits: %j', (config) => {
    expect(() => resolveContinuityPolicy(config)).toThrow('continuity')
  },
)
