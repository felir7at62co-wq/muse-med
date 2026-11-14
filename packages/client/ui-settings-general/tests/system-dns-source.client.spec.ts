import { expect, it, vi } from 'vitest'
import { SystemDnsSource, type SystemDnsPreference } from '../src/client/system-dns-source.ts'

it('does not send reads or duplicate writes while a preference change is pending', async () => {
  const pending = Promise.withResolvers<SystemDnsPreference>()
  const bridge = { status: vi.fn(async () => ({ saved: false, active: false })), set: vi.fn(() => pending.promise) }
  const source = new SystemDnsSource(bridge)
  await vi.waitFor(() => { expect(source.store.getSnapshot().loading).toBe(false) })
  const change = source.set(true)
  await source.load()
  await source.set(false)
  expect(bridge.status).toHaveBeenCalledTimes(1)
  expect(bridge.set).toHaveBeenCalledExactlyOnceWith(true)
  expect(source.store.getSnapshot()).toMatchObject({ busy: true, preference: { saved: false, active: false } })
  pending.resolve({ saved: true, active: false })
  await change
  expect(source.store.getSnapshot()).toMatchObject({ busy: false, notice: 'saved', noticeSequence: 1,
    preference: { saved: true, active: false } })
  source.dismiss()
  expect(source.store.getSnapshot().notice).toBeNull()
  source.dispose()
})

it('refuses writes during startup and after an initial read fails without an accepted preference', async () => {
  const pending = Promise.withResolvers<SystemDnsPreference>()
  const bridge = { status: vi.fn(() => pending.promise), set: vi.fn(async () => ({ saved: true, active: true })) }
  const source = new SystemDnsSource(bridge)
  await source.set(true)
  expect(bridge.set).not.toHaveBeenCalled()
  pending.reject(new Error('read unavailable'))
  await vi.waitFor(() => { expect(source.store.getSnapshot().loadFailed).toBe(true) })
  await source.set(true)
  expect(bridge.set).not.toHaveBeenCalled()
  expect(source.store.getSnapshot()).toMatchObject({ preference: undefined, loading: false, busy: false })
  source.dispose()
})

it('ignores late read rejection and all public mutations after disposal', async () => {
  const pending = Promise.withResolvers<SystemDnsPreference>()
  const bridge = { status: vi.fn(() => pending.promise), set: vi.fn(async () => ({ saved: true, active: true })) }
  const source = new SystemDnsSource(bridge)
  source.dispose()
  const stopped = source.store.getSnapshot()
  pending.reject(new Error('late read rejection'))
  await Promise.resolve()
  await source.load()
  await source.set(true)
  source.dismiss()
  expect(source.store.getSnapshot()).toBe(stopped)
  expect(bridge.status).toHaveBeenCalledTimes(1)
  expect(bridge.set).not.toHaveBeenCalled()
})

it('ignores a late write rejection without publishing a notice after disposal', async () => {
  const pending = Promise.withResolvers<SystemDnsPreference>()
  const source = new SystemDnsSource({ status: async () => ({ saved: false, active: false }), set: () => pending.promise })
  await vi.waitFor(() => { expect(source.store.getSnapshot().loading).toBe(false) })
  const change = source.set(true)
  source.dispose()
  const stopped = source.store.getSnapshot()
  pending.reject(new Error('late write rejection'))
  await change
  expect(source.store.getSnapshot()).toBe(stopped)
  expect(stopped).toMatchObject({ unknown: false, notice: null, noticeSequence: 0 })
})
