/** Actual resource registry holds explicit checks and bounded single-flight status observations. */
import { Context } from '@deepseek-ai/cordis'
import { ResourceRegistry } from '@deepseek-ai/dsh-client-resources/src/client/resources.ts'
import { RemoteError, type RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import { afterEach, expect, it, vi } from 'vitest'
import type { EpisodeClient } from '../src/client/episode-directory.ts'
import type { EpisodeDeliveryStatus, EpisodeHistory } from '../src/types.ts'
import { registerEpisodeResources } from '../src/client/episode-resources.ts'
import { attempt, episodeClientFixture, input, original, unadmitted } from './fixtures/episode-client.client.ts'

afterEach(() => { vi.useRealTimers() })

it('holds an explicit readiness check across panel subscriber release without rehashing on reopen', async () => {
  const f = episodeClientFixture()
  await f.waitReady()
  const source = f.resources.source(f.directory.state.getSnapshot().readinessAddress)
  const first = source.subscribe(() => {}); first()
  const second = source.subscribe(() => {})
  expect(source.getSnapshot().status).toBe('live')
  expect(f.api.episodeReadiness).toHaveBeenCalledTimes(1)
  second(); f.directory.history(input)
  await vi.waitFor(() => { expect(f.api.episodeHistory).toHaveBeenCalledTimes(1) })
  expect(f.api.episodeReadiness).toHaveBeenCalledTimes(1)
  expect(f.api.admitEpisode).not.toHaveBeenCalled()
})

it('polls one pending status at a time and stops at unknown without another readiness call', async () => {
  vi.useFakeTimers()
  const first = Promise.withResolvers<RemoteResult<EpisodeDeliveryStatus>>()
  const api = vi.fn<EpisodeClient['episodeStatus']>().mockReturnValueOnce(first.promise).mockResolvedValue({ ok: true, value: original })
  const f = episodeClientFixture({ episodeStatus: api }, 1000)
  f.directory.history(input)
  await vi.advanceTimersByTimeAsync(0)
  f.directory.selectOriginal(input, f.directory.state.getSnapshot().historyAddress)
  await vi.advanceTimersByTimeAsync(10000)
  expect(api).toHaveBeenCalledTimes(1)
  first.resolve({ ok: true, value: { ...original, state: 'running' } })
  await vi.advanceTimersByTimeAsync(0)
  await vi.advanceTimersByTimeAsync(999)
  expect(api).toHaveBeenCalledTimes(1)
  await vi.advanceTimersByTimeAsync(1)
  expect(api).toHaveBeenCalledTimes(2)
  await vi.advanceTimersByTimeAsync(10000)
  expect(api).toHaveBeenCalledTimes(2)
  expect(f.api.episodeReadiness).not.toHaveBeenCalled()
  expect(f.api.admitEpisode).not.toHaveBeenCalled()
})

it('stops a failed status query until explicit refresh while retaining the original target', async () => {
  vi.useFakeTimers()
  const api = vi.fn<EpisodeClient['episodeStatus']>().mockResolvedValueOnce({ ok: false,
    error: new RemoteError('jubian-video-recovery/rejected', 'unreadable record', {}) }).mockResolvedValue({ ok: true, value: original })
  const f = episodeClientFixture({ episodeStatus: api })
  f.directory.history(input); await vi.advanceTimersByTimeAsync(0)
  f.directory.selectOriginal(input, f.directory.state.getSnapshot().historyAddress)
  await vi.advanceTimersByTimeAsync(10000)
  expect(api).toHaveBeenCalledTimes(1)
  expect(f.resources.source(f.directory.state.getSnapshot().statusAddress).getSnapshot().status).toBe('failed')
  f.directory.refresh(); await vi.advanceTimersByTimeAsync(0)
  expect(api).toHaveBeenCalledTimes(2)
  expect(f.directory.state.getSnapshot().target).toEqual(input)
})

it('disconnect aborts pending timers and suppresses a late retired result', async () => {
  vi.useFakeTimers()
  const held = Promise.withResolvers<RemoteResult<EpisodeDeliveryStatus>>()
  const f = episodeClientFixture({ episodeStatus: vi.fn<EpisodeClient['episodeStatus']>(() => held.promise) })
  f.directory.history(input); await vi.advanceTimersByTimeAsync(0)
  f.directory.selectOriginal(input, f.directory.state.getSnapshot().historyAddress)
  const address = f.directory.state.getSnapshot().statusAddress
  f.disconnect(); held.resolve({ ok: true, value: { ...unadmitted, state: 'running' } })
  await vi.advanceTimersByTimeAsync(10000)
  expect(f.resources.source(address).getSnapshot().value).toBeUndefined()
  expect(f.api.episodeStatus).toHaveBeenCalledTimes(1)
  expect(f.notices).not.toHaveBeenCalled()
})

it('rolls back earlier protocol registrations when a later public registration conflicts', async () => {
  const f = episodeClientFixture(), ctx = new Context(), resources = new ResourceRegistry(ctx)
  ctx.effect(() => ctx.provide('resources', resources))
  const occupied = resources.register({ protocol: 'jubian-episode-history', async *open() { yield { ok: true,
    value: { projectDir: '/project', episode: 1, entries: [], truncated: false, scannedEntries: 0, unreadableRecords: 0 } } } })
  try {
    expect(() => registerEpisodeResources(ctx, f.api, f.directory, 1000)).toThrow('already has a provider')
    const replacement = resources.register({ protocol: 'jubian-episode-readiness', async *open() {} })
    replacement(); occupied()
  } finally { await ctx.fiber.dispose() }
})

it.each(['readiness', 'history', 'status'] as const)('contains a thrown %s query failure in its resource and allows an explicit retry', async (kind) => {
  const f = episodeClientFixture()
  const query = kind === 'readiness' ? f.api.episodeReadiness : kind === 'history' ? f.api.episodeHistory : f.api.episodeStatus
  vi.mocked(query).mockRejectedValueOnce('The connection closed')
  if (kind === 'history' || kind === 'status') {
    f.directory.history(input)
    if (kind === 'status') {
      await vi.waitFor(() => { expect(f.directory.state.getSnapshot().displayedHistory?.entries).toHaveLength(1) })
      f.directory.selectOriginal(input, f.directory.state.getSnapshot().historyAddress)
    }
  } else f.directory.check(input)
  const address = f.directory.state.getSnapshot()[`${kind}Address`]
  await vi.waitFor(() => {
    expect(f.resources.source(address).getSnapshot()).toMatchObject({
      status: 'failed', failure: { message: 'The connection closed' },
    })
  })
  expect(f.api.admitEpisode).not.toHaveBeenCalled()
  if (kind === 'readiness') f.directory.check(input)
  else if (kind === 'history') f.directory.history(input)
  else f.directory.refresh()
  await vi.waitFor(() => {
    const current = f.directory.state.getSnapshot()[`${kind}Address`]
    expect(f.resources.source(current).getSnapshot().status).toBe('live')
  })
  expect(query).toHaveBeenCalledTimes(2)
})

it.each(['readiness', 'history'] as const)('does not restore a retired %s query when its failed reply arrives late', async (kind) => {
  const pending = Promise.withResolvers<never>(), f = episodeClientFixture()
  if (kind === 'readiness') {
    vi.mocked(f.api.episodeReadiness).mockReturnValueOnce(pending.promise)
    f.directory.check(input)
  } else {
    vi.mocked(f.api.episodeHistory).mockReturnValueOnce(pending.promise)
    f.directory.history(input)
  }
  const address = f.directory.state.getSnapshot()[`${kind}Address`]
  f.directory.retireSelection('2')
  pending.reject(new Error('Old connection failed'))
  await pending.promise.catch(() => undefined)
  await vi.waitFor(() => {
    expect(f.resources.source(address).getSnapshot()).toEqual({ status: 'loading', value: undefined, failure: undefined })
  })
  expect(f.directory.state.getSnapshot()).toMatchObject({ displayedReadiness: null, displayedHistory: null, episodeText: '2' })
  expect(f.notices).not.toHaveBeenCalled()
})

it('cancels a scheduled status poll when its connection disappears', async () => {
  vi.useFakeTimers()
  const api = vi.fn<EpisodeClient['episodeStatus']>(async () => ({ ok: true, value: { ...original, state: 'running' } }))
  const f = episodeClientFixture({ episodeStatus: api }, 1000)
  f.directory.history(input)
  await vi.advanceTimersByTimeAsync(0)
  f.directory.selectOriginal(input, f.directory.state.getSnapshot().historyAddress)
  await vi.advanceTimersByTimeAsync(0)
  expect(f.directory.state.getSnapshot().displayedStatus?.state).toBe('running')
  f.disconnect()
  await vi.advanceTimersByTimeAsync(10_000)
  expect(api).toHaveBeenCalledTimes(1)
  expect(f.directory.state.getSnapshot()).toMatchObject({ connected: false, displayedStatus: { state: 'running' } })
  expect(f.notices).not.toHaveBeenCalled()
})

it('discards a successful history reply after its selection has been retired', async () => {
  const pending = Promise.withResolvers<RemoteResult<EpisodeHistory>>()
  const value: EpisodeHistory = { projectDir: input.projectDir, episode: input.episode,
    entries: [{ attempt, digest: input.digest, recordedState: 'unknown' }],
    truncated: false, unreadableRecords: 0, scannedEntries: 1 }
  const f = episodeClientFixture({ episodeHistory: vi.fn<EpisodeClient['episodeHistory']>(() => pending.promise) })
  try {
    f.directory.history(input)
    await vi.waitFor(() => { expect(f.api.episodeHistory).toHaveBeenCalledTimes(1) })
    const address = f.directory.state.getSnapshot().historyAddress
    const source = f.resources.source(address)
    expect(source.getSnapshot().status).toBe('loading')
    f.directory.retireSelection('2')
    const retired = f.directory.state.getSnapshot()
    pending.resolve({ ok: true, value })
    await pending.promise
    await f.directory.admit(); await f.directory.admit(true)
    expect(source.getSnapshot()).toEqual({ status: 'loading', value: undefined, failure: undefined })
    expect(f.directory.state.getSnapshot()).toBe(retired)
    expect(retired).toMatchObject({ episodeText: '2', target: null, displayedHistory: null, historyAddress: '', statusAddress: '' })
    expect(f.api.episodeStatus).not.toHaveBeenCalled()
    expect(f.api.admitEpisode).not.toHaveBeenCalled()
    expect(f.api.episodeHistory).toHaveBeenCalledTimes(1)
    expect(f.notices).not.toHaveBeenCalled()
  } finally {
    pending.resolve({ ok: true, value })
    await pending.promise
  }
})

it('does not publish an old status rejection while a second public pin holds the retired observation', async () => {
  const pending = Promise.withResolvers<RemoteResult<EpisodeDeliveryStatus>>()
  const f = episodeClientFixture({ episodeStatus: vi.fn<EpisodeClient['episodeStatus']>(() => pending.promise) })
  const pins = vi.spyOn(f.resources, 'pin'), extra = new AbortController()
  try {
    f.directory.history(input)
    await vi.waitFor(() => { expect(f.directory.state.getSnapshot().displayedHistory?.entries).toHaveLength(1) })
    f.directory.selectOriginal(input, f.directory.state.getSnapshot().historyAddress)
    await vi.waitFor(() => { expect(f.api.episodeStatus).toHaveBeenCalledTimes(1) })
    const address = f.directory.state.getSnapshot().statusAddress, source = f.resources.source(address)
    const owner = pins.mock.calls.find(([pinned]) => pinned === address)?.[1]
    if (owner === undefined) throw new Error('Expected the real directory pin signal')
    f.resources.pin(address, extra.signal)
    expect(pins.mock.calls.filter(([pinned]) => pinned === address).map(([, signal]) => signal)).toEqual([owner, extra.signal])
    expect(owner.aborted).toBe(false)
    f.directory.retireSelection('2')
    const retired = f.directory.state.getSnapshot()
    pending.reject(new Error('Old status connection failed'))
    await pending.promise.catch(() => undefined)
    await f.directory.admit(); await f.directory.admit(true)
    expect(owner.aborted).toBe(true)
    expect(extra.signal.aborted).toBe(false)
    expect(source.getSnapshot()).toEqual({ status: 'loading', value: undefined, failure: undefined })
    expect(f.directory.state.getSnapshot()).toBe(retired)
    expect(retired).toMatchObject({ episodeText: '2', target: null, displayedStatus: null, statusAddress: '' })
    expect(f.api.episodeStatus).toHaveBeenCalledExactlyOnceWith(input)
    expect(f.api.admitEpisode).not.toHaveBeenCalled()
    expect(f.notices).not.toHaveBeenCalled()
  } finally {
    extra.abort()
    pending.resolve({ ok: true, value: original })
    await pending.promise.catch(() => undefined)
    pins.mockRestore()
  }
})

it('stops before scheduling another status poll when its observer and directory pin release during publication', async () => {
  vi.useFakeTimers()
  const running: EpisodeDeliveryStatus = { ...original, state: 'running' }
  const f = episodeClientFixture({ episodeStatus: vi.fn<EpisodeClient['episodeStatus']>(async () => ({ ok: true, value: running })) }, 1000)
  const pins = vi.spyOn(f.resources, 'pin')
  let releaseObserver = () => {}
  try {
    f.directory.history(input)
    await vi.advanceTimersByTimeAsync(0)
    f.directory.selectOriginal(input, f.directory.state.getSnapshot().historyAddress)
    const address = f.directory.state.getSnapshot().statusAddress, source = f.resources.source(address)
    const owner = pins.mock.calls.find(([pinned]) => pinned === address)?.[1]
    if (owner === undefined) throw new Error('Expected the real directory pin signal')
    const frames: ReturnType<typeof source.getSnapshot>[] = []
    releaseObserver = source.subscribe(() => {
      const frame = source.getSnapshot()
      if (frames.length !== 0 || frame.status !== 'live') return
      frames.push(frame)
      releaseObserver()
      f.disconnect()
    })
    await vi.advanceTimersByTimeAsync(0)
    expect(frames).toEqual([{ status: 'live', value: running, failure: undefined }])
    expect(owner.aborted).toBe(true)
    expect(f.directory.state.getSnapshot()).toMatchObject({ connected: false, statusAddress: '', displayedStatus: running })
    expect(source.getSnapshot()).toEqual({ status: 'loading', value: undefined, failure: undefined })
    await vi.advanceTimersByTimeAsync(10_000)
    expect(vi.getTimerCount()).toBe(0)
    expect(f.api.episodeStatus).toHaveBeenCalledExactlyOnceWith(input)
    expect(f.api.admitEpisode).not.toHaveBeenCalled()
    expect(f.notices).not.toHaveBeenCalled()
  } finally {
    releaseObserver()
    f.disconnect()
    pins.mockRestore()
  }
})

it.each([
  { label: 'readiness with history JSON', route: 'readiness', kind: 'history', digest: true },
  { label: 'history with status JSON', route: 'history', kind: 'status', digest: true },
  { label: 'status with readiness JSON', route: 'status', kind: 'readiness', digest: true },
  { label: 'status without an original digest', route: 'status', kind: 'status', digest: false },
] as const)('rejects $label through its actual registered resource descriptor before Remote work', async ({ route, kind, digest }) => {
  const f = episodeClientFixture(), ctx = new Context(), resources = new ResourceRegistry(ctx), controller = new AbortController()
  ctx.effect(() => ctx.provide('resources', resources))
  const registrations = vi.spyOn(resources, 'register')
  let unregister = () => {}
  try {
    unregister = registerEpisodeResources(ctx, f.api, f.directory, 1000)
    const protocol = 'jubian-episode-' + route
    const provider = registrations.mock.calls.find(([registered]) => registered.protocol === protocol)?.[0]
    if (provider === undefined) throw new Error('Expected the actual registered episode resource descriptor')
    const address = 'dsh-resource://' + protocol + '/' + encodeURIComponent(JSON.stringify({
      projectDir: input.projectDir, episode: input.episode, epoch: 1, revision: 1, kind,
      ...(digest ? { digest: input.digest } : {}),
    }))
    const before = f.directory.state.getSnapshot(), frames: RemoteResult<unknown>[] = []
    for await (const frame of provider.open(address, { signal: controller.signal })) frames.push(frame)
    expect(frames).toEqual([])
    expect(f.directory.state.getSnapshot()).toBe(before)
    expect(f.api.episodeReadiness).not.toHaveBeenCalled()
    expect(f.api.episodeHistory).not.toHaveBeenCalled()
    expect(f.api.episodeStatus).not.toHaveBeenCalled()
    expect(f.api.admitEpisode).not.toHaveBeenCalled()
    expect(f.notices).not.toHaveBeenCalled()
    await f.waitReady()
    expect(f.api.episodeReadiness).toHaveBeenCalledTimes(1)
    expect(f.directory.state.getSnapshot().checked).toBe(true)
  } finally {
    controller.abort(); unregister(); registrations.mockRestore()
    await ctx.fiber.dispose()
  }
})

it.each(['readiness', 'history'] as const)('keeps a current %s Host failure frame without granting admission or dispatching follow-up work', async (kind) => {
  const error = new RemoteError('jubian-video-recovery/rejected', kind + ' could not be checked', {})
  const f = kind === 'readiness'
    ? episodeClientFixture({ episodeReadiness: vi.fn<EpisodeClient['episodeReadiness']>(async () => ({ ok: false, error })) })
    : episodeClientFixture({ episodeHistory: vi.fn<EpisodeClient['episodeHistory']>(async () => ({ ok: false, error })) })
  const pins = vi.spyOn(f.resources, 'pin')
  try {
    if (kind === 'readiness') f.directory.check(input)
    else f.directory.history(input)
    const address = f.directory.state.getSnapshot()[kind === 'readiness' ? 'readinessAddress' : 'historyAddress']
    const source = f.resources.source(address)
    const signal = pins.mock.calls.find(([pinned]) => pinned === address)?.[1]
    if (signal === undefined) throw new Error('Expected the actual directory resource hold')
    expect(signal).toBeInstanceOf(AbortSignal)
    expect(signal.aborted).toBe(false)
    expect(f.directory.current(kind, address)).toBe(true)
    await vi.waitFor(() => { expect(source.getSnapshot().status).toBe('failed') })
    expect(source.getSnapshot()).toEqual({ status: 'failed', value: undefined, failure: error })
    expect(source.getSnapshot().failure).toBe(error)
    expect(signal.aborted).toBe(false)
    expect(f.directory.current(kind, address)).toBe(true)
    expect(f.directory.state.getSnapshot()).toMatchObject({ checked: false, target: null,
      displayedReadiness: null, displayedHistory: null, statusAddress: '' })
    expect(kind === 'readiness' ? f.api.episodeReadiness : f.api.episodeHistory)
      .toHaveBeenCalledExactlyOnceWith({ projectDir: input.projectDir, episode: input.episode })
    expect(kind === 'readiness' ? f.api.episodeHistory : f.api.episodeReadiness).not.toHaveBeenCalled()
    expect(f.api.episodeStatus).not.toHaveBeenCalled()
    await f.directory.admit(); await f.directory.admit(true)
    expect(f.api.admitEpisode).not.toHaveBeenCalled()
    expect(f.notices).not.toHaveBeenCalled()
  } finally { pins.mockRestore() }
})
