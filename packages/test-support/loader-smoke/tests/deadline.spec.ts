/** Effective runner budgets retain Loader smoke diagnostics before the test deadline. */
import { describe, expect, it } from 'vitest'
import { LOADER_SMOKE_PROCESS_TIMEOUT_MS, LOADER_SMOKE_TEST_TIMEOUT_MS, loaderSmokeProcessTimeout } from '../src/deadline.ts'

describe('Loader smoke deadlines', () => {
  it('keeps the default process deadline within the default test deadline', () => {
    expect(LOADER_SMOKE_PROCESS_TIMEOUT_MS).toBe(30_000)
    expect(LOADER_SMOKE_TEST_TIMEOUT_MS).toBe(45_000)
    expect(loaderSmokeProcessTimeout(LOADER_SMOKE_TEST_TIMEOUT_MS)).toBe(LOADER_SMOKE_PROCESS_TIMEOUT_MS)
  })

  it('uses an explicitly granted runner budget for the subprocess', () => {
    expect(loaderSmokeProcessTimeout(90_000)).toBe(75_000)
  })

  it('keeps a finite process deadline when the runner deadline is disabled', () => {
    expect(loaderSmokeProcessTimeout(0)).toBe(LOADER_SMOKE_PROCESS_TIMEOUT_MS)
  })

  it.each([1, 15_000, -1, Number.POSITIVE_INFINITY, Number.NaN])('rejects a test deadline without process time: %s', (timeout) => {
    expect(() => loaderSmokeProcessTimeout(timeout)).toThrow('diagnostic and cleanup reserve')
  })
})
