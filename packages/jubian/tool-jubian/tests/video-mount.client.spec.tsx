// @vitest-environment jsdom
/** Composer registration follows remote availability and owns each session directory until disposal. */
import { Context } from '@deepseek-ai/cordis'
import { expect, it, onTestFinished, vi } from 'vitest'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import type { RemoteResult, TypertRemoteContribution } from '@deepseek-ai/dsh-typert-protocol'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import { mountJubianTokenSettings } from '../src/client/mount.ts'
import type { VideoModelSelectInjected } from '../src/client/VideoModelSelect.tsx'
import type { VideoSelectionClient } from '../src/client/video-directory.ts'
import type { SessionVideoSelection } from '../src/video-session-types.ts'

const contribution: TypertRemoteContribution = { package: '@deepseek-ai/dsh-tool-jubian', descriptors: [] }
const option = { key: '1:480p', standardId: 1, modelId: 'fixture-model', modelName: 'Fixture',
  platformId: 'FIXTURE', resolution: '480p', ratios: ['16:9'], genTypes: [3], maxDurationSeconds: 30 }

async function bench(available: () => Promise<RemoteResult<boolean>>) {
  const ctx = new Context(), sessionScope = new Context()
  onTestFinished(async () => { await sessionScope.fiber.dispose(); await ctx.fiber.dispose() })
  await ctx.plugin(SlotRegistry).await()
  ctx.provide('locale', new LocaleRuntime(ctx))
  const selection = createSnapshotStore<SessionVideoSelection | null>(null)
  const unsubscribe = vi.fn()
  const projection = { getSnapshot: () => selection.getSnapshot(), subscribe: (listener: () => void) => {
    const release = selection.subscribe(listener)
    return () => { unsubscribe(); release() }
  } }
  const binding = { session: { projections: { faceOf: vi.fn(() => projection) } } }
  const remote = {
    available: vi.fn(available),
    defaults: vi.fn<VideoSelectionClient['defaults']>(async () => ({ ok: true, value: null })),
    catalogue: vi.fn<VideoSelectionClient['catalogue']>(async () => ({ ok: true, value: [option] })),
    select: vi.fn<VideoSelectionClient['select']>(async () => ({ ok: true, value: { ...option, revision: 1 } })),
  }
  const sessionBindings = new Map([[SessionId('present'), binding], [SessionId('without-scope'), binding]])
  ctx.provide('sessions', { binding: (id: SessionId) => sessionBindings.get(id),
    scope: (id: SessionId) => id === SessionId('present') ? sessionScope : undefined } as never)
  ctx.provide('remote', { $mount: async () => async () => {},
    get jubianToken(): unknown { const namespace: unknown = ctx.get('remote.jubianToken'); return namespace },
    get jubianVideoSelection(): unknown { const namespace: unknown = ctx.get('remote.jubianVideoSelection'); return namespace },
  })
  ctx.provide('remote.jubianToken', { describe: async () => ({ ok: true, value: { configured: false, writable: true } }) })
  ctx.provide('remote.jubianVideoSelection', remote)
  const slots = ctx.get('slots') as SlotRegistry
  slots.register({ name: 'root', children: { 'settings.section': { kind: 'list', scope: 'root' },
    'conversation.input.right': { kind: 'list', scope: 'session' } } } as never, () => null)
  return { ctx, sessionScope, slots, remote, selection, unsubscribe, binding }
}

it('shares a directory for a session binding and releases its projection before late reads publish', async () => {
  const b = await bench(async () => ({ ok: true, value: true }))
  const dispose = await mountJubianTokenSettings(b.ctx, contribution)
  await vi.waitFor(() => { expect(b.slots.entries('conversation.input.right')).toHaveLength(1) })
  const entry = b.slots.entries('conversation.input.right')[0]!
  const inject = entry.inject as (id: SessionId) => VideoModelSelectInjected & Record<string, unknown>
  const first = inject(SessionId('present'))
  const second = inject(SessionId('present'))
  expect(first.hooks.videoState).toBe(second.hooks.videoState)
  await first.load()
  expect(b.remote.catalogue).toHaveBeenCalledOnce()
  expect(first.hooks.videoState.getSnapshot().options).toEqual([option])
  await second.select(option.key)
  expect(b.remote.select).toHaveBeenCalledWith(SessionId('present'), option.key, 0)
  expect(first.hooks.videoState.getSnapshot().current?.revision).toBe(1)
  expect(() => inject(SessionId('missing'))).toThrow('Video selector requires a session scope')
  expect(() => inject(SessionId('without-scope'))).toThrow('Video selector requires a session scope')
  await b.sessionScope.fiber.dispose()
  expect(b.unsubscribe).toHaveBeenCalledOnce()
  await dispose()
  expect(b.slots.entries('conversation.input.right')).toHaveLength(0)
})

it.each(['disabled', 'refused', 'disposed'] as const)('does not register a composer picker when availability is %s', async (mode) => {
  const pending = Promise.withResolvers<RemoteResult<boolean>>()
  const b = await bench(() => pending.promise)
  const dispose = await mountJubianTokenSettings(b.ctx, contribution)
  await vi.waitFor(() => { expect(b.remote.available).toHaveBeenCalledOnce() })
  const closing = mode === 'disposed' ? dispose() : undefined
  pending.resolve(mode === 'refused' ? { ok: false, error: new RemoteError('gateway/internal', 'video selection unavailable', {}) }
    : { ok: true, value: mode === 'disposed' })
  await vi.waitFor(() => { expect(b.slots.entries('conversation.input.right')).toHaveLength(0) })
  if (closing) await closing
  else await dispose()
  expect(b.remote.catalogue).not.toHaveBeenCalled()
})
