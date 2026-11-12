/** Actual resource registry holds explicit checks and bounded single-flight status observations. */
import { Context } from '@deepseek-ai/cordis'
import { ResourceRegistry } from '@deepseek-ai/dsh-client-resources/src/client/resources.ts'
import { RemoteError, type RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import { afterEach, expect, it, vi } from 'vitest'
import type { EpisodeClient } from '../src/client/episode-directory.ts'
import type { EpisodeDeliveryStatus } from '../src/types.ts'
import { registerEpisodeResources } from '../src/client/episode-resources.ts'
import { episodeClientFixture, input, original, unadmitted } from './fixtures/episode-client.client.ts'

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
