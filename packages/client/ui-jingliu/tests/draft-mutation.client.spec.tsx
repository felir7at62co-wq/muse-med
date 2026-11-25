// @vitest-environment jsdom
/** Concurrent draft submissions share one in-flight mutation. */
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { useDraftMutation } from '../src/client/useDraftMutation.ts'

afterEach(cleanup)

it('ignores a second submission while the current draft update is pending', async () => {
  const { result } = renderHook(useDraftMutation)
  const pending = Promise.withResolvers<undefined>()
  const overlapping = vi.fn(async () => {})
  let active = Promise.resolve()

  act(() => { active = result.current.run(() => pending.promise) })
  expect(result.current.busy).toBe(true)
  await act(async () => { await result.current.run(overlapping) })
  expect(overlapping).not.toHaveBeenCalled()
  expect(result.current.busy).toBe(true)

  await act(async () => {
    pending.resolve(undefined)
    await active
  })
  expect(result.current.busy).toBe(false)
  await act(async () => { await result.current.run(overlapping) })
  expect(overlapping).toHaveBeenCalledOnce()
})
