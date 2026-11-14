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
  await vi.advanceTimersByTimeAsync(1000)
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

it.each(['readiness', 'history'] as const)('publishes current %s failures without accepting display values', async (kind) => {
  for (const fault of ['wire', 'error', 'plain'] as const) {
    const reason = fault === 'plain' ? 'Episode query unavailable' : new Error('Episode query unavailable')
    const readiness = vi.fn<EpisodeClient['episodeReadiness']>(), history = vi.fn<EpisodeClient['episodeHistory']>()
    if (fault === 'wire') {
      const failure = { ok: false as const, error: new RemoteError('jubian-video-recovery/rejected', 'Episode query unavailable', {}) }
      readiness.mockResolvedValue(failure); history.mockResolvedValue(failure)
    } else { readiness.mockRejectedValue(reason); history.mockRejectedValue(reason) }
    const f = episodeClientFixture({ episodeReadiness: readiness, episodeHistory: history })
    if (kind === 'readiness') f.directory.check(input)
    else f.directory.history(input)
    const source = f.resources.source(f.directory.state.getSnapshot()[`${kind}Address`])
    await vi.waitFor(() => { expect(source.getSnapshot().status).toBe('failed') })
    expect(source.getSnapshot().failure?.message).toBe('Episode query unavailable')
    expect(f.directory.state.getSnapshot()[kind === 'readiness' ? 'displayedReadiness' : 'displayedHistory']).toBeNull()
  }
})

it.each(['readiness', 'history', 'status'] as const)('suppresses a retired %s rejection while another subscriber retains its resource', async (kind) => {
  const failure = new Error('Retired connection failed')
  const readiness = Promise.withResolvers<Awaited<ReturnType<EpisodeClient['episodeReadiness']>>>()
  const history = Promise.withResolvers<Awaited<ReturnType<EpisodeClient['episodeHistory']>>>()
  const status = Promise.withResolvers<Awaited<ReturnType<EpisodeClient['episodeStatus']>>>()
  const f = episodeClientFixture(kind === 'readiness' ? { episodeReadiness: () => readiness.promise }
    : kind === 'history' ? { episodeHistory: () => history.promise } : { episodeStatus: () => status.promise })
  if (kind === 'readiness') f.directory.check(input)
  else {
    f.directory.history(input)
    if (kind === 'status') f.directory.selectOriginal(input, f.directory.state.getSnapshot().historyAddress)
  }
  const source = f.resources.source(f.directory.state.getSnapshot()[`${kind}Address`])
  const release = source.subscribe(() => {})
  f.directory.retireSelection('2')
  if (kind === 'readiness') readiness.reject(failure)
  else if (kind === 'history') history.reject(failure)
  else status.reject(failure)
  if (kind === 'readiness') await readiness.promise.catch(() => undefined)
  else if (kind === 'history') await history.promise.catch(() => undefined)
  else await status.promise.catch(() => undefined)
  expect(source.getSnapshot().failure).toBeUndefined()
  expect(f.notices).not.toHaveBeenCalled()
  release()
})

it('does not accept a late history answer after its original selection retires', async () => {
  const held = Promise.withResolvers<Awaited<ReturnType<EpisodeClient['episodeHistory']>>>()
  const f = episodeClientFixture({ episodeHistory: () => held.promise })
  f.directory.history(input)
  const source = f.resources.source(f.directory.state.getSnapshot().historyAddress), release = source.subscribe(() => {})
  f.directory.retireSelection('2')
  held.resolve({ ok: true, value: { ...input, entries: [], truncated: false, unreadableRecords: 0, scannedEntries: 0 } })
  await held.promise
  expect(f.directory.state.getSnapshot().displayedHistory).toBeNull()
  release()
})

it.each(['wrong-host-case', 'wrong-kind', 'missing-digest'] as const)('refuses a foreign status resource address: %s', (kind) => {
  const f = episodeClientFixture()
  const query = { kind: kind === 'wrong-kind' ? 'history' : 'status', projectDir: input.projectDir,
    episode: input.episode, epoch: 0, revision: 1 }
  const host = kind === 'wrong-host-case' ? 'JUBIAN-EPISODE-STATUS' : 'jubian-episode-status'
  const address = `dsh-resource://${host}/${encodeURIComponent(JSON.stringify(query))}`
  const release = f.resources.source(address).subscribe(() => {})
  expect(f.api.episodeStatus).not.toHaveBeenCalled()
  expect(f.notices).not.toHaveBeenCalled()
  release()
})

it('joins a pending-status pause when its last resource holder disconnects during frame publication', async () => {
  vi.useFakeTimers()
  const f = episodeClientFixture({ episodeStatus: vi.fn<EpisodeClient['episodeStatus']>(async () => ({ ok: true,
    value: { ...original, state: 'running' } })) })
  f.directory.history(input); await vi.advanceTimersByTimeAsync(0)
  f.directory.selectOriginal(input, f.directory.state.getSnapshot().historyAddress)
  const source = f.resources.source(f.directory.state.getSnapshot().statusAddress)
  let release = () => {}
  release = source.subscribe(() => {
    if (source.getSnapshot().status === 'live') { f.disconnect(); release() }
  })
  await vi.advanceTimersByTimeAsync(10000)
  expect(f.api.episodeStatus).toHaveBeenCalledTimes(1)
  expect(f.directory.state.getSnapshot().connected).toBe(false)
  release()
})
