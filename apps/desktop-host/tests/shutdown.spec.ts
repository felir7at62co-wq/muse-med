import { afterEach, expect, it, vi } from 'vitest'
import { shutdownDesktopHost } from '../src/shutdown.ts'

afterEach(() => { vi.unstubAllGlobals() })

function fixture(connected = true) {
  const exitSignal = new Error('test process exit')
  const disconnect = vi.fn()
  const exit = vi.fn((): never => { throw exitSignal })
  vi.stubGlobal('process', { ...process, connected, disconnect, exit })
  const stopped = Promise.withResolvers<undefined>()
  const sent = Promise.withResolvers<undefined>()
  const shutdown = vi.fn(() => stopped.promise)
  const acknowledge = vi.fn(() => sent.promise)
  const application = Promise.resolve({ shutdown: { shutdown } })
  return { stopped, sent, shutdown, acknowledge, disconnect, exit, exitSignal, application }
}

it('waits for teardown and IPC delivery before disconnecting and exiting', async () => {
  const f = fixture()
  const result = shutdownDesktopHost(f.application, f.acknowledge)
  const exited = expect(result).rejects.toBe(f.exitSignal)
  await vi.waitFor(() => { expect(f.shutdown).toHaveBeenCalledWith(0) })
  expect(f.acknowledge).not.toHaveBeenCalled()
  expect(f.exit).not.toHaveBeenCalled()
  f.stopped.resolve(undefined)
  await vi.waitFor(() => { expect(f.acknowledge).toHaveBeenCalledOnce() })
  expect(f.disconnect).not.toHaveBeenCalled()
  expect(f.exit).not.toHaveBeenCalled()
  f.sent.resolve(undefined)
  await exited
  expect(f.disconnect).toHaveBeenCalledOnce()
  expect(f.exit).toHaveBeenCalledOnce()
  expect(f.disconnect.mock.invocationCallOrder[0]).toBeLessThan(f.exit.mock.invocationCallOrder[0]!)
})

it.each(['teardown', 'acknowledgement'] as const)('keeps failed %s from authorizing an exit', async (failure) => {
  const f = fixture()
  const error = new Error('shutdown rejected')
  const result = expect(shutdownDesktopHost(f.application, f.acknowledge)).rejects.toBe(error)
  if (failure === 'teardown') f.stopped.reject(error)
  else { f.stopped.resolve(undefined); f.sent.reject(error) }
  await result
  if (failure === 'teardown') expect(f.acknowledge).not.toHaveBeenCalled()
  expect(f.disconnect).not.toHaveBeenCalled()
  expect(f.exit).not.toHaveBeenCalled()
})

it('retains startup failure ownership without forcing a successful process exit', async () => {
  const f = fixture()
  f.sent.resolve(undefined)
  await shutdownDesktopHost(Promise.reject(new Error('startup failed')), f.acknowledge)
  expect(f.shutdown).not.toHaveBeenCalled()
  expect(f.acknowledge).toHaveBeenCalledOnce()
  expect(f.disconnect).toHaveBeenCalledOnce()
  expect(f.exit).not.toHaveBeenCalled()
})

it('finishes a stopped Host after its IPC channel has already disconnected', async () => {
  const f = fixture(false)
  f.stopped.resolve(undefined)
  f.sent.resolve(undefined)
  await expect(shutdownDesktopHost(f.application, f.acknowledge)).rejects.toBe(f.exitSignal)
  expect(f.disconnect).not.toHaveBeenCalled()
  expect(f.exit).toHaveBeenCalledOnce()
})
