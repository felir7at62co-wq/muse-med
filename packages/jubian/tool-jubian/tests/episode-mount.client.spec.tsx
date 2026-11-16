// @vitest-environment jsdom
/** Episode Settings callbacks share actual resource and connection-generation lifetimes. */
import { Context } from '@deepseek-ai/cordis'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { ResourceRegistry } from '@deepseek-ai/dsh-client-resources/src/client/resources.ts'
import type { ConnectionGeneration } from '@deepseek-ai/dsh-client-connection/client'
import type { PropsRenderSlots } from '@deepseek-ai/dsh-client-ui-slots'
import { RemoteError, type RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import { expect, it, onTestFinished, vi } from 'vitest'
import { mountJubianTokenSettings } from '../src/client/mount.ts'
import type { JubianTokenInjected } from '../src/client/JubianTokenSection.tsx'
import type { RecoveryToastInjected } from '../src/client/VideoRecoverySection.tsx'
import type { EpisodeClient } from '../src/client/episode-directory.ts'
import type { EpisodeDeliveryStatus } from '../src/types.ts'
import { input, original, ready, unadmitted } from './fixtures/episode-client.client.ts'

async function fixture() {
  const ctx = new Context()
  onTestFinished(async () => { await ctx.fiber.dispose() })
  await ctx.plugin(SlotRegistry).await()
  ctx.provide('locale', new LocaleRuntime(ctx))
  const resources = new ResourceRegistry(ctx)
  ctx.effect(() => ctx.provide('resources', resources))
  const generation = createSnapshotStore<ConnectionGeneration | undefined>(undefined)
  ctx.provide('connection', { generation })
  ctx.provide('remote', { $mount: async () => async () => {},
    get jubianToken(): unknown { const api: unknown = ctx.get('remote.jubianToken'); return api },
    get jubianEpisodeDelivery(): unknown { const api: unknown = ctx.get('remote.jubianEpisodeDelivery'); return api } })
  ctx.provide('remote.jubianToken', { describe: async () => ({ ok: true, value: { configured: false, writable: true } }) })
  const api: EpisodeClient = {
    episodeReadiness: vi.fn<EpisodeClient['episodeReadiness']>(async () => ({ ok: true, value: ready })),
    episodeHistory: vi.fn<EpisodeClient['episodeHistory']>(async () => ({ ok: true, value: { ...input,
      entries: [], truncated: false, unreadableRecords: 0, scannedEntries: 0 } })),
    episodeStatus: vi.fn<EpisodeClient['episodeStatus']>(async () => ({ ok: true, value: unadmitted })),
    admitEpisode: vi.fn<EpisodeClient['admitEpisode']>(async () => ({ ok: true, value: original })),
  }
  const withdraw = ctx.provide('remote.jubianEpisodeDelivery', api)
  const slots = ctx.slots
  ctx.effect(() => slots.register({ name: 'root', children: { 'settings.section': { kind: 'list', scope: 'root' },
    'shell.overlay': { kind: 'list', scope: 'root' } } },
  ({ renderSlot }: PropsRenderSlots<'settings.section' | 'shell.overlay'>) => <>
    {renderSlot('settings.section', { close: () => {} })}{renderSlot('shell.overlay', {})}
  </>))
  const dispose = await mountJubianTokenSettings(ctx, { package: '@deepseek-ai/dsh-tool-jubian', descriptors: [] }, 1000)
  const entry = slots.entries('settings.section')[0]
  if (entry?.inject === undefined) throw new Error('The real Settings section was not registered')
  const face = entry.inject() as JubianTokenInjected & Record<string, unknown>
  const overlay = slots.entries('shell.overlay')[0]
  if (overlay?.inject === undefined) throw new Error('The real shell overlay was not registered')
  const toast = overlay.inject() as RecoveryToastInjected & Record<string, unknown>
  return { ctx, api, generation, resources, face, toast, dispose, withdraw }
}

it('mounts episode resources only for a ready generation and routes explicit Settings actions', async () => {
  const f = await fixture(), register = vi.spyOn(f.resources, 'register')
  const current: ConnectionGeneration = { id: 1, host: { home: '/home' } }
  expect(f.face.hooks.episodeState.getSnapshot().connected).toBe(false)
  f.generation.set(current)
  await vi.waitFor(() => { expect(f.face.hooks.episodeState.getSnapshot().connected).toBe(true) })
  expect(register).toHaveBeenCalledTimes(3)
  f.generation.set(current)
  expect(register).toHaveBeenCalledTimes(3)
  expect(f.api.episodeReadiness).not.toHaveBeenCalled()
  f.face.setEpisodeText('1')
  f.face.checkEpisode(input)
  await vi.waitFor(() => { expect(f.resources.source(f.face.hooks.episodeState.getSnapshot().statusAddress).getSnapshot().status).toBe('live') })
  await f.face.admitEpisode()
  expect(f.api.admitEpisode).toHaveBeenCalledExactlyOnceWith(input)
  expect(f.toast.hooks.recoveryNotice.getSnapshot().kind).toBe('episodeAccepted')
  f.face.loadEpisodeHistory(input)
  await vi.waitFor(() => { expect(f.resources.source(f.face.hooks.episodeState.getSnapshot().historyAddress).getSnapshot().status).toBe('live') })
  f.face.selectEpisodeOriginal(input, f.face.hooks.episodeState.getSnapshot().historyAddress)
  f.face.refreshEpisode()
  await vi.waitFor(() => { expect(f.api.episodeStatus).toHaveBeenCalledTimes(4) })
  f.generation.set(undefined)
  expect(f.face.hooks.episodeState.getSnapshot().connected).toBe(false)
  f.generation.set({ id: 2, host: { home: '/home' } })
  expect(register).toHaveBeenCalledTimes(6)
  expect(f.face.hooks.episodeState.getSnapshot().target).toEqual(input)
  await f.dispose()
  f.generation.set({ id: 3, host: { home: '/retired' } })
  expect(register).toHaveBeenCalledTimes(6)
  register.mockRestore()
})

it('retires episode namespace callbacks and reports admission failures through the retained shell owner', async () => {
  const f = await fixture()
  f.generation.set({ id: 1, host: { home: '/home' } })
  await vi.waitFor(() => { expect(f.face.hooks.episodeState.getSnapshot().connected).toBe(true) })
  f.face.checkEpisode(input)
  await vi.waitFor(() => { expect(f.resources.source(f.face.hooks.episodeState.getSnapshot().statusAddress).getSnapshot().status).toBe('live') })
  vi.mocked(f.api.admitEpisode).mockResolvedValueOnce({ ok: false,
    error: new RemoteError('jubian-video-recovery/rejected', 'Original admission unavailable', {}) })
  await f.face.admitEpisode()
  expect(f.toast.hooks.recoveryNotice.getSnapshot()).toMatchObject({ kind: 'failed', reason: 'Original admission unavailable' })
  const pending = Promise.withResolvers<RemoteResult<EpisodeDeliveryStatus>>()
  vi.mocked(f.api.episodeStatus).mockReturnValueOnce(pending.promise)
  f.face.refreshEpisode()
  f.withdraw()
  await vi.waitFor(() => { expect(f.face.hooks.episodeState.getSnapshot().connected).toBe(false) })
  const retired = f.face.hooks.episodeState.getSnapshot()
  pending.resolve({ ok: true, value: original })
  await pending.promise
  expect(f.face.hooks.episodeState.getSnapshot()).toBe(retired)
  await f.dispose()
})
