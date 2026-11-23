import { expect, it } from 'vitest'
import { reviewBatchAfterOffload } from '../src/review-batch.ts'

it('keeps the batch when offloading only old or unrelated retained input occurrences', () => {
  expect(reviewBatchAfterOffload([[], [], ['F1'], ['F2']], 2, 8)).toBe(8)
  expect(reviewBatchAfterOffload([[], []], 2, 8)).toBe(8)
  expect(reviewBatchAfterOffload([['F1'], ['F2']], 0, 8)).toBe(8)
})

it('reduces only from actual pending frame losses and counts duplicate appearances once', () => {
  expect(reviewBatchAfterOffload([[], ['F1'], ['F2'], ['F3'], ['F4']], 2, 4)).toBe(3)
  expect(reviewBatchAfterOffload([['F1'], ['F1'], ['F2']], 1, 4)).toBe(4)
  expect(reviewBatchAfterOffload([['F1'], [], ['F2'], ['F2'], ['F3']], 3, 8)).toBe(2)
  expect(reviewBatchAfterOffload([['F1'], ['F2']], 2, 8)).toBe(1)
  expect(reviewBatchAfterOffload([['F1'], ['F2'], ['F3']], 1, 1)).toBe(1)
})

it('counts every pending tile of an offloaded grid page as lost', () => {
  expect(reviewBatchAfterOffload([['F1', 'F2', 'F3', 'F4'], ['F5', 'F6']], 1, 4)).toBe(2)
  expect(reviewBatchAfterOffload([['F1', 'F2'], ['F1', 'F2']], 1, 4)).toBe(4)
})
