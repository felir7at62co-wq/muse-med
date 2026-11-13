/** Explicit original-task actions reject retired queries and uncertain-response retries. */
import { expect, it, onTestFinished, vi } from 'vitest'
import { RemoteError, type RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import type { EpisodeClient } from '../src/client/episode-directory.ts'
import type { EpisodeDeliveryStatus, EpisodeReadiness } from '../src/types.ts'
import { RecoveryDirectory } from '../src/client/recovery-directory.ts'
import { episodeClientFixture, input, original, ready } from './fixtures/episode-client.client.ts'

it('does not check or admit on connect, typing or an unselected refresh', () => {
  const f = episodeClientFixture()
  f.directory.retireSelection('2'); f.directory.refresh()
  expect(f.api.episodeReadiness).not.toHaveBeenCalled()
  expect(f.api.episodeHistory).not.toHaveBeenCalled()
  expect(f.api.episodeStatus).not.toHaveBeenCalled()
  expect(f.api.admitEpisode).not.toHaveBeenCalled()
})

it('rejects a retired check result and waits for the replacement before enabling admission', async () => {
  const old = Promise.withResolvers<RemoteResult<EpisodeReadiness>>()
  const current = Promise.withResolvers<RemoteResult<EpisodeReadiness>>()
  const f = episodeClientFixture({ episodeReadiness: vi.fn<EpisodeClient['episodeReadiness']>().mockReturnValueOnce(old.promise).mockReturnValueOnce(current.promise) })
  f.directory.check(input); f.directory.check(input)
  old.resolve({ ok: true, value: ready }); await old.promise
  await f.directory.admit()
  expect(f.api.episodeStatus).not.toHaveBeenCalled(); expect(f.api.admitEpisode).not.toHaveBeenCalled()
  current.resolve({ ok: true, value: ready })
  await vi.waitFor(() => { expect(f.api.episodeStatus).toHaveBeenCalledTimes(1) })
  await vi.waitFor(async () => { await f.directory.admit(); expect(f.api.admitEpisode).toHaveBeenCalledTimes(1) })
})

it.each(['remote error', 'lost reply'] as const)('only looks up the original after a %s and rejects an early old status permission', async (fault) => {
  const response = Promise.withResolvers<RemoteResult<EpisodeDeliveryStatus>>()
  const f = episodeClientFixture({ admitEpisode: vi.fn<EpisodeClient['admitEpisode']>(() => response.promise) })
  await f.waitReady()
  const early = f.directory.state.getSnapshot().statusAddress, admission = f.directory.admit()
  f.directory.acceptStatus(early, { ...original, canResume: true })
  if (fault === 'remote error') response.resolve({ ok: false, error: new RemoteError('jubian-video-recovery/rejected', 'acknowledgement lost', {}) })
  else response.reject(new Error('connection ended after commit'))
  await admission
  await f.directory.admit(); await f.directory.admit(true)
  expect(f.api.admitEpisode).toHaveBeenCalledTimes(1)
  expect(f.api.admitEpisode).toHaveBeenCalledWith(input)
  await vi.waitFor(() => { expect(f.api.episodeStatus).toHaveBeenCalledTimes(2) })
  expect(f.directory.state.getSnapshot().target).toEqual(input)
  expect(f.api.episodeReadiness).toHaveBeenCalledTimes(1)
})

it('reconnects with the original digest but cannot use old resume permission', async () => {
  const f = episodeClientFixture({ episodeStatus: vi.fn<EpisodeClient['episodeStatus']>(async () => ({ ok: true, value: { ...original, canResume: true } })) })
  f.directory.history(input)
  await vi.waitFor(() => { expect(f.api.episodeHistory).toHaveBeenCalledTimes(1) })
  f.directory.selectOriginal(input, f.directory.state.getSnapshot().historyAddress)
  await vi.waitFor(() => { expect(f.api.episodeStatus).toHaveBeenCalledTimes(1) })
  f.disconnect()
  const held = Promise.withResolvers<RemoteResult<EpisodeDeliveryStatus>>()
  const fresh = { ...f.api, episodeStatus: vi.fn<EpisodeClient['episodeStatus']>(() => held.promise) }
  f.connect(fresh); await f.directory.admit(true)
  expect(f.api.admitEpisode).not.toHaveBeenCalled()
  expect(f.directory.state.getSnapshot().target).toEqual(input)
  held.resolve({ ok: true, value: { ...original, canResume: true } })
  await vi.waitFor(async () => { await f.directory.admit(true); expect(f.api.admitEpisode).toHaveBeenCalledTimes(1) })
  expect(f.api.admitEpisode).toHaveBeenCalledWith({ ...input, resume: true })
  expect(f.api.episodeReadiness).not.toHaveBeenCalled()
})

it.each(['selection', 'dispose'] as const)('ignores an old admission outcome after %s retires its UI owner', async (retire) => {
  const pending = Promise.withResolvers<RemoteResult<EpisodeDeliveryStatus>>()
  const f = episodeClientFixture({ admitEpisode: vi.fn<EpisodeClient['admitEpisode']>(() => pending.promise) })
  await f.waitReady(); const admission = f.directory.admit()
  if (retire === 'selection') f.directory.retireSelection('2')
  else f.directory.dispose()
  pending.resolve({ ok: true, value: original }); await admission
  expect(f.notices).not.toHaveBeenCalled()
  expect(f.api.episodeStatus).toHaveBeenCalledTimes(1)
})

it('retains a submitted original target instead of posting a second ordinary admission', async () => {
  const f = episodeClientFixture()
  await f.waitReady(); await f.directory.admit()
  await vi.waitFor(() => { expect(f.api.episodeStatus).toHaveBeenCalledTimes(2) })
  await f.directory.admit(); f.directory.refresh()
  expect(f.api.admitEpisode).toHaveBeenCalledTimes(1)
  expect(f.api.episodeReadiness).toHaveBeenCalledTimes(1)
  expect(f.directory.state.getSnapshot().target).toEqual(input)
})

it('retires the episode child when the A project draft changes and disposes it with A', () => {
  const recovery = new RecoveryDirectory(), child = recovery.episodes
  const f = episodeClientFixture()
  child.connect(f.api, (address, signal) => { f.resources.pin(address, signal) })
  child.check(input); recovery.setProjectDir('/other')
  expect(child.state.getSnapshot()).toMatchObject({ target: null, readinessAddress: '', statusAddress: '' })
  recovery.dispose(); child.check(input)
  expect(child.state.getSnapshot().readinessAddress).toBe('')
})

it('retires loaded episode facts when A accepts a different saved project after refresh', async () => {
  const recovery = new RecoveryDirectory(), f = episodeClientFixture()
  const api = {
    status: vi.fn(async () => ({ ok: true as const, value: { projectDir: '/project', enabled: false,
      configurable: true, decoderAvailable: true, reports: [] } })),
    configure: async () => { throw new Error('Not used by this query fixture') },
    review: async () => { throw new Error('Not used by this query fixture') },
    adopt: async () => { throw new Error('Not used by this query fixture') },
    deliverApprovedMp4: async () => { throw new Error('Not used by this query fixture') },
  }
  recovery.connect(api)
  await vi.waitFor(() => { expect(recovery.state.getSnapshot().status?.projectDir).toBe('/project') })
  const child = recovery.episodes
  child.connect(f.api, () => {})
  child.check(input)
  child.acceptReadiness(child.state.getSnapshot().readinessAddress, ready)
  expect(child.state.getSnapshot().displayedReadiness).not.toBeNull()
  api.status.mockResolvedValueOnce({ ok: true, value: { projectDir: '/other', enabled: false,
    configurable: true, decoderAvailable: true, reports: [] } })
  await recovery.refresh()
  expect(child.state.getSnapshot()).toMatchObject({ target: null, displayedReadiness: null, displayedHistory: null, displayedStatus: null })
  recovery.dispose()
})

it('requires the replacement status after a matching recheck even when an earlier query finishes during that check', async () => {
  const prior = Promise.withResolvers<RemoteResult<EpisodeDeliveryStatus>>()
  const replacement = Promise.withResolvers<RemoteResult<EpisodeDeliveryStatus>>()
  const recheck = Promise.withResolvers<RemoteResult<EpisodeReadiness>>()
  const api = vi.fn<EpisodeClient['episodeStatus']>().mockResolvedValueOnce({ ok: true, value: { ...original, state: 'not-admitted', attempt: null } })
    .mockReturnValueOnce(prior.promise).mockReturnValueOnce(replacement.promise)
  const f = episodeClientFixture({ episodeStatus: api,
    episodeReadiness: vi.fn<EpisodeClient['episodeReadiness']>().mockResolvedValueOnce({ ok: true, value: ready }).mockReturnValueOnce(recheck.promise),
    admitEpisode: vi.fn<EpisodeClient['admitEpisode']>(async () => ({ ok: false,
      error: new RemoteError('jubian-video-recovery/rejected', 'admission paused', {}) })) })
  await f.waitReady(); await f.directory.admit()
  await vi.waitFor(() => { expect(api).toHaveBeenCalledTimes(2) })
  f.directory.check(input)
  prior.resolve({ ok: true, value: { ...original, state: 'not-admitted', attempt: null } })
  await vi.waitFor(() => { expect(f.resources.source(f.directory.state.getSnapshot().statusAddress).getSnapshot().status).toBe('live') })
  recheck.resolve({ ok: true, value: ready })
  await vi.waitFor(() => { expect(api).toHaveBeenCalledTimes(3) })
  await f.directory.admit()
  expect(f.api.admitEpisode).toHaveBeenCalledTimes(1)
  replacement.resolve({ ok: true, value: { ...original, state: 'not-admitted', attempt: null } })
  await vi.waitFor(() => { expect(f.resources.source(f.directory.state.getSnapshot().statusAddress).getSnapshot().status).toBe('live') })
  await f.directory.admit()
  expect(f.api.admitEpisode).toHaveBeenCalledTimes(2)
  expect(vi.mocked(f.api.admitEpisode).mock.calls.map((args: Parameters<EpisodeClient['admitEpisode']>) => args[0])).toEqual([input, input])
})

it('keeps a replacement connection when the old disposer runs and leaves retained callbacks inert after disposal', async () => {
  const f = episodeClientFixture()
  const current = f.connect()
  f.disconnect()
  expect(f.directory.state.getSnapshot().connected).toBe(true)
  current()
  await f.directory.admit()
  f.directory.refresh(); f.directory.selectOriginal(input, '')
  f.directory.dispose()
  const retired = f.directory.state.getSnapshot()
  f.directory.connect(f.api, () => {})()
  f.directory.retireSelection('2'); f.directory.check(input); f.directory.history(input)
  f.directory.acceptReadiness('retired', ready)
  f.directory.acceptHistory('retired', { ...input, entries: [], truncated: false, unreadableRecords: 0, scannedEntries: 0 })
  f.directory.acceptStatus('retired', original)
  expect(f.directory.state.getSnapshot()).toBe(retired)
  expect(f.api.episodeReadiness).not.toHaveBeenCalled()
})

it('announces a completed original execution once across explicit status refreshes', async () => {
  const completed: EpisodeDeliveryStatus = { ...original, state: 'completed',
    output: { path: 'exports/original.mp4', sha256: input.digest, bytes: 26 } }
  const f = episodeClientFixture({ episodeStatus: vi.fn<EpisodeClient['episodeStatus']>(async () => ({ ok: true, value: completed })) })
  f.directory.history(input)
  await vi.waitFor(() => { expect(f.resources.source(f.directory.state.getSnapshot().historyAddress).getSnapshot().status).toBe('live') })
  f.directory.selectOriginal(input, f.directory.state.getSnapshot().historyAddress)
  await vi.waitFor(() => { expect(f.notices).toHaveBeenCalledExactlyOnceWith('episodeCompleted') })
  f.directory.refresh()
  await vi.waitFor(() => { expect(f.api.episodeStatus).toHaveBeenCalledTimes(2) })
  await vi.waitFor(() => { expect(f.resources.source(f.directory.state.getSnapshot().statusAddress).getSnapshot().status).toBe('live') })
  expect(f.notices).toHaveBeenCalledExactlyOnceWith('episodeCompleted')
})

it.each(['not-ready', 'missing-digest'] as const)('retains a %s readiness result without granting admission', async (kind) => {
  const f = episodeClientFixture({ episodeReadiness: vi.fn<EpisodeClient['episodeReadiness']>(async () => ({ ok: true,
    value: { ...ready, ready: kind !== 'not-ready', digest: kind === 'missing-digest' ? null : input.digest } })) })
  f.directory.check(input)
  await vi.waitFor(() => { expect(f.directory.state.getSnapshot().displayedReadiness).not.toBeNull() })
  await f.directory.admit()
  expect(f.api.episodeStatus).not.toHaveBeenCalled()
  expect(f.api.admitEpisode).not.toHaveBeenCalled()
})

it('does not start a status read after a synchronous readiness subscriber disconnects its owner', async () => {
  const f = episodeClientFixture()
  const unsubscribe = f.directory.state.subscribe(() => {
    if (f.directory.state.getSnapshot().displayedReadiness !== null) f.disconnect()
  })
  onTestFinished(unsubscribe)
  f.directory.check(input)
  await vi.waitFor(() => { expect(f.directory.state.getSnapshot().connected).toBe(false) })
  expect(f.api.episodeStatus).not.toHaveBeenCalled()
})

it.each(['plain-rejection', 'empty-wire-message', 'retired-rejection'] as const)('preserves admission failure ownership: %s', async (kind) => {
  const pending = Promise.withResolvers<RemoteResult<EpisodeDeliveryStatus>>()
  const f = episodeClientFixture({ admitEpisode: () => pending.promise })
  await f.waitReady()
  const admission = f.directory.admit()
  if (kind === 'retired-rejection') f.directory.retireSelection('2')
  if (kind === 'empty-wire-message') pending.resolve({ ok: false,
    error: new RemoteError('jubian-video-recovery/rejected', '', {}) })
  else pending.reject('Admission response is unavailable')
  await admission
  if (kind === 'retired-rejection') expect(f.notices).not.toHaveBeenCalled()
  else expect(f.notices).toHaveBeenCalledExactlyOnceWith({ failed: kind === 'empty-wire-message'
    ? 'jubian-video-recovery/rejected' : 'Admission response is unavailable' })
})
