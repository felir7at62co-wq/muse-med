import { expect, it } from 'vitest'
import { reviewBatchAfterOffload } from '../src/review-batch.ts'

it('keeps the batch when offloading only old or unrelated retained input occurrences', () => {
  expect(reviewBatchAfterOffload([undefined, undefined, 'F1', 'F2'], 2, 8)).toBe(8)
  expect(reviewBatchAfterOffload([undefined, undefined], 2, 8)).toBe(8)
  expect(reviewBatchAfterOffload(['F1', 'F2'], 0, 8)).toBe(8)
})

it('reduces only from actual pending frame losses and counts duplicate appearances once', () => {
  expect(reviewBatchAfterOffload([undefined, 'F1', 'F2', 'F3', 'F4'], 2, 4)).toBe(3)
  expect(reviewBatchAfterOffload(['F1', 'F1', 'F2'], 1, 4)).toBe(4)
  expect(reviewBatchAfterOffload(['F1', undefined, 'F2', 'F2', 'F3'], 3, 8)).toBe(2)
  expect(reviewBatchAfterOffload(['F1', 'F2'], 2, 8)).toBe(1)
  expect(reviewBatchAfterOffload(['F1', 'F2', 'F3'], 1, 1)).toBe(1)
})
