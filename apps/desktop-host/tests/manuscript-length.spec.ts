/** Unicode counts and advisory growth reports use the same complete-text metric. */
import { expect, it } from 'vitest'
import { compareManuscriptLengths, measureManuscriptLength } from '../src/manuscript-length.ts'

it('counts Unicode letters and numbers without treating punctuation or emoji as prose', () => {
  expect(measureManuscriptLength('甲𠮷 A2，\n🙂！')).toEqual({ nonWhitespaceCharacters: 7, lettersAndNumbers: 4 })
  expect(measureManuscriptLength('é e\u0301 九Ⅷ②')).toEqual({ nonWhitespaceCharacters: 6, lettersAndNumbers: 5 })
})

it('includes titles and speaker labels instead of claiming an inferred net-prose count', () => {
  expect(measureManuscriptLength('# 第1集\n甲：回来。')).toEqual({ nonWhitespaceCharacters: 9, lettersAndNumbers: 6 })
})

it('reports growth from thirty thousand to eighty thousand without inventing an unspecified tolerance', () => {
  const result = compareManuscriptLengths(measureManuscriptLength('字'.repeat(30_000)), measureManuscriptLength('字'.repeat(80_000)))
  expect(result.difference).toBe(50_000)
  expect(result.ratio).toBe(8 / 3)
  expect(result.growthPercent).toBeCloseTo(166.6666667)
  expect(result.assessment).toBe('no_growth_limit')
  expect(result).not.toHaveProperty('maxGrowthPercent')
})

it.each([
  [99, 'below_source'],
  [100, 'within_requested_growth'],
  [110, 'within_requested_growth'],
  [111, 'above_requested_growth'],
] as const)('reports %s percent of the source against an explicitly requested ten-percent upper tolerance', (count, assessment) => {
  const result = compareManuscriptLengths(measureManuscriptLength('字'.repeat(100)), measureManuscriptLength('字'.repeat(count)), 10)
  expect(result.assessment).toBe(assessment)
  expect(result.maxGrowthPercent).toBe(10)
  expect(result.difference).toBe(count - 100)
})

it('leaves the ratio absent for a source with no letters or numbers', () => {
  expect(compareManuscriptLengths(measureManuscriptLength('？！\n'), measureManuscriptLength('正文'), 10))
    .toMatchObject({ ratio: null, growthPercent: null, assessment: 'empty_source', difference: 2 })
})
