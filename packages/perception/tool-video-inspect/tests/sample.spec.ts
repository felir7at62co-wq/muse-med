/** Sampling covers a bounded interval and refuses ambiguous or excessive requests. */
import { expect, it } from 'vitest'
import * as sampling from '../src/sample.ts'

it('samples the interval in chronological order and exposes the next uninspected range', () => {
  expect(sampling.planSamples(
    { duration: 180, start: 30, end: 90, count: 3 }, { maxRangeSeconds: 120, maxFrames: 12 },
  )).toEqual([40, 60, 80])
})
it.each([
  { duration: 180, start: -1, end: 10, count: 3 },
  { duration: 180, start: 0, end: 130, count: 3 },
  { duration: 180, start: 0, end: 20, count: 13 },
  { duration: 180, start: 0, end: 20, count: 2.5 },
  { duration: 180, start: 0, end: 20, count: 2, timestamps: [21] },
])('refuses an invalid sampling request %#', (request) => {
  expect(() => sampling.planSamples(request, { maxRangeSeconds: 120, maxFrames: 12 })).toThrow()
})
it('accepts explicit timecodes, sorts them and avoids duplicate image observations', () => {
  expect(sampling.planSamples(
    { duration: 180, start: 0, end: 60, count: 6, timestamps: [4, 2, 4] }, { maxRangeSeconds: 120, maxFrames: 12 },
  )).toEqual([2, 4])
})
