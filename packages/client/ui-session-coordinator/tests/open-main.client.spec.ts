/** An in-flight Main Session request must not update a disposed UI contribution. */
import { expect, it, vi } from 'vitest'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import { openRetainedMain } from '../src/client/open-main.ts'

it('ignores a successful response received after the contribution unloads', async () => {
  const controller = new AbortController()
  const opened = vi.fn(), failed = vi.fn()
  let resolve!: (result: { ok: true; value: SessionId }) => void
  const request = new Promise<{ ok: true; value: SessionId }>((done) => { resolve = done })
  const pending = openRetainedMain(controller.signal, () => request, opened, failed)
  controller.abort()
  resolve({ ok: true, value: SessionId('main') })
  await pending
  expect(opened).not.toHaveBeenCalled()
  expect(failed).not.toHaveBeenCalled()
})

it('opens the returned identity while active and reports an active failure', async () => {
  const controller = new AbortController()
  const opened = vi.fn(), failed = vi.fn()
  await openRetainedMain(controller.signal, async () => ({ ok: true, value: SessionId('main') }), opened, failed)
  expect(opened).toHaveBeenCalledExactlyOnceWith(SessionId('main'))
  await openRetainedMain(controller.signal, async () => ({ ok: false }), opened, failed)
  expect(failed).toHaveBeenCalledOnce()
})

it('settles a late transport rejection after unload and preserves active errors', async () => {
  const controller = new AbortController()
  const opened = vi.fn(), failed = vi.fn()
  let reject!: (error: Error) => void
  const request = new Promise<{ ok: true; value: SessionId }>((_resolve, fail) => { reject = fail })
  const pending = openRetainedMain(controller.signal, () => request, opened, failed)
  controller.abort()
  reject(new Error('transport closed'))
  await expect(pending).resolves.toBeUndefined()
  expect(opened).not.toHaveBeenCalled()
  expect(failed).not.toHaveBeenCalled()
  await expect(openRetainedMain(new AbortController().signal, async () => { throw new Error('unavailable') }, opened, failed))
    .rejects.toThrow('unavailable')
})
