/** Initial navigation attempts follow connection replacement and feature lifetime. */
import { expect, it, vi } from 'vitest'
import { followInitialMain } from '../src/client/initial-main.ts'

it('aborts an old startup attempt and retries after connection reset', async () => {
  const lifetime = new AbortController()
  const attempts: AbortSignal[] = []
  const pending = Promise.withResolvers<undefined>()
  const start = vi.fn((signal: AbortSignal) => { attempts.push(signal); return pending.promise })
  let reset!: () => void
  const remove = vi.fn()
  const error = vi.fn()
  const stop = followInitialMain(lifetime.signal, (callback) => { reset = callback; return remove }, start, error)
  expect(start).toHaveBeenCalledOnce()
  reset()
  expect(attempts[0]?.aborted).toBe(true)
  expect(start).toHaveBeenCalledTimes(2)
  expect(attempts[1]?.aborted).toBe(false)
  stop()
  expect(remove).toHaveBeenCalledOnce()
  expect(attempts[1]?.aborted).toBe(true)
  pending.reject(new Error('connection closed'))
  await Promise.resolve()
  expect(error).not.toHaveBeenCalled()
})

it('reports active failures and retries when connection returns', async () => {
  const lifetime = new AbortController()
  let reset!: () => void
  const error = vi.fn()
  const start = vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValue(undefined)
  const stop = followInitialMain(lifetime.signal, (callback) => { reset = callback; return () => {} }, start, error)
  await vi.waitFor(() => { expect(error).toHaveBeenCalledOnce() })
  reset()
  await vi.waitFor(() => { expect(start).toHaveBeenCalledTimes(2) })
  stop()
})

it('starts no attempt when the feature lifetime has already ended', () => {
  const lifetime = new AbortController()
  lifetime.abort()
  const start = vi.fn(async () => {})
  const remove = vi.fn()
  const stop = followInitialMain(lifetime.signal, () => remove, start, vi.fn())
  expect(start).not.toHaveBeenCalled()
  stop()
  expect(remove).toHaveBeenCalledOnce()
})
