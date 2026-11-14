// @vitest-environment jsdom
/** Native registration follows accepted settings and owns its traced Remote namespace. */
import { Context, Service } from '@deepseek-ai/cordis'
import type { ClientRemote } from '@deepseek-ai/dsh-api-remotes/client'
import type { PropsRenderSlots, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client'
import { UiConversation } from '@deepseek-ai/dsh-client-ui-conversation/client'
import { TestSessions, stubConfigForm } from '@deepseek-ai/dsh-client-test-runtime'
import type { TypertRemoteContribution } from '@deepseek-ai/dsh-typert-protocol'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import remoteContribution from '@deepseek-ai/dsh-session-video/remote'
import { act, waitFor } from '@testing-library/react'
import { expect, it, onTestFinished, vi } from 'vitest'
import { apply } from '../src/client/index.ts'
import { SESSION_VIDEO_CONFIG_GLOBAL, SETTINGS_ENTRY } from '../src/config.ts'
import type { VideoInjected } from '../src/client/face.ts'
import type { PresentationSettingFace } from '../src/client/PresentationSetting.tsx'
import { inventory, source, analysis } from './video-fixture.tsx'

vi.mock('@deepseek-ai/dsh-session-video/remote', () => ({
  default: { package: '@deepseek-ai/dsh-session-video', descriptors: [] },
}))

declare module '@deepseek-ai/cordis' {
  interface Context { 'remote.sessionVideo': ClientRemote['sessionVideo'] }
}

class VideoRemote extends Service {
  readonly mounted = vi.fn<() => void>()
  readonly disposed = vi.fn<() => void>()
  readonly operations = {
    list: vi.fn<ClientRemote['sessionVideo']['list']>().mockResolvedValue({ ok: true, value: inventory([source()]) }),
    detect: vi.fn<ClientRemote['sessionVideo']['detect']>().mockResolvedValue({ ok: true, value: analysis(source()) }),
  }
  constructor(ctx: Context) { super(ctx, 'remote') }
  async $mount(value: TypertRemoteContribution): Promise<() => Promise<void>> {
    expect(value).toBe(remoteContribution)
    this.mounted()
    const owner = this.ctx.plugin((scope) => { scope.provide('remote.sessionVideo', this.operations) })
    await owner
    return async () => { await owner.dispose(); this.disposed() }
  }
  get sessionVideo(): ClientRemote['sessionVideo'] { return this.ctx['remote.sessionVideo'] }
}

async function fixture(enabled = false) {
  const ctx = new Context()
  onTestFinished(async () => { await ctx.fiber.dispose(); vi.restoreAllMocks(); vi.unstubAllGlobals() })
  vi.stubGlobal(SESSION_VIDEO_CONFIG_GLOBAL, { enabled, pixelsPerSecond: 64 })
  await ctx.plugin(SlotRegistry).await()
  const locale = new LocaleRuntime(ctx)
  ctx.provide('locale', locale)
  const sessions = new TestSessions(async (fn) => { await fn() }, ctx)
  new UiConversation(ctx, sessions)
  const form = stubConfigForm<{ enabled: boolean }>()
  ctx.provide('configForms', { get: (entry: string) => { expect(entry).toBe(SETTINGS_ENTRY); return form.scope } })
  ctx.slots.register({ name: 'root', children: {
    'settings.general.item': { kind: 'list', scope: 'root' },
    'conversation.chat.pinned': { kind: 'list', scope: 'session' },
    'conversation.content.overlay': { kind: 'list', scope: 'session' },
    'deliverables.video': { kind: 'chain', scope: 'session' },
    'conversation.chat.turnTail': { kind: 'list', scope: 'session' },
  } }, ({ renderSlot }: PropsRenderSlots<'settings.general.item' | 'conversation.chat.pinned'
    | 'conversation.content.overlay' | 'deliverables.video' | 'conversation.chat.turnTail'>) => renderSlot('settings.general.item', {}))
  const remote = new VideoRemote(ctx)
  return { ctx, locale, form, remote }
}

it('keeps settings mounted while disabling and remounting every optional contribution', async () => {
  const { ctx, form, remote } = await fixture()
  const dispose = await apply(ctx)
  expect(ctx.slots.entries('settings.general.item')).toHaveLength(1)
  expect(ctx.slots.entries('conversation.content.overlay')).toHaveLength(0)
  expect(ctx.uiConversation.headerPresentations.getSnapshot()).toBeUndefined()
  act(() => { form.publish({ status: 'ready', writable: true, value: { enabled: true } }) })
  await waitFor(() => { expect(ctx.slots.entries('conversation.content.overlay')).toHaveLength(1) })
  expect(ctx.uiConversation.headerPresentations.getSnapshot()).toBe('floating')
  const overlay = ctx.slots.entries('conversation.content.overlay')[0]
  if (!overlay?.inject) throw Error('Enabled shelf has no Host operations')
  const injected = overlay.inject() as Partial<VideoInjected>
  if (!injected.listVideos || !injected.detectShots) throw Error('Shelf operations are incomplete')
  const delivered = ctx.slots.entries('deliverables.video')[0]
  const generated = ctx.slots.entries('conversation.chat.turnTail')[0]
  if (!delivered?.select || !delivered.inject || !generated?.inject) throw Error('Video playback contributions are incomplete')
  // Registry entries erase the named chain's input type.
  const select = delivered.select as (props: Pick<PropsRuntime<'deliverables.video'>,
    'sourceUrl' | 'label' | 'path' | 'seq' | 'index'>) => boolean
  expect(select({ sourceUrl: '/delivered.mp4', label: 'Delivered video', path: 'delivered.mp4', seq: 1, index: 0 })).toBe(true)
  expect(delivered.inject()).toBe(injected)
  expect(generated.inject()).toBe(injected)
  const id = inventory([]).sessionId, controller = new AbortController()
  expect(injected.pixelsPerSecond).toBe(64)
  expect(await injected.listVideos(id, controller.signal)).toEqual(inventory([source()]))
  expect(remote.operations.list).toHaveBeenCalledExactlyOnceWith(id, controller.signal)
  expect(await injected.detectShots(id, source().id, 'v1', controller.signal)).toEqual(analysis(source()))
  expect(remote.operations.detect).toHaveBeenCalledExactlyOnceWith(id, source().id, 'v1', controller.signal)
  remote.operations.list.mockResolvedValueOnce({ ok: false, error: new RemoteError('gateway/internal', 'Unavailable inventory', {}) })
  await expect(injected.listVideos(id, controller.signal)).rejects.toThrow('gateway/internal')
  remote.operations.detect.mockResolvedValueOnce({ ok: false, error: new RemoteError('gateway/internal', 'Unavailable detector', {}) })
  await expect(injected.detectShots(id, source().id, 'v1', controller.signal)).rejects.toThrow('gateway/internal')
  const settings = ctx.slots.entries('settings.general.item')[0]?.inject?.() as PresentationSettingFace | undefined
  if (!settings) throw Error('Settings row has no persistent writer')
  form.set.mockResolvedValueOnce(false)
  await expect(settings.setEnabled(false)).rejects.toThrow('Session video setting was refused')
  expect(ctx.slots.entries('conversation.content.overlay')).toHaveLength(1)
  await settings.setEnabled(false)
  for (const slot of ['conversation.content.overlay', 'conversation.chat.pinned', 'deliverables.video', 'conversation.chat.turnTail'] as const) {
    expect(ctx.slots.entries(slot)).toHaveLength(0)
  }
  expect(ctx.uiConversation.headerPresentations.getSnapshot()).toBeUndefined()
  await settings.setEnabled(true)
  expect(ctx.slots.entries('conversation.content.overlay')).toHaveLength(1)
  expect(ctx.slots.entries('conversation.content.overlay')[0]).not.toBe(overlay)
  await dispose()
  expect(form.listenerCount()).toBe(0)
  expect(ctx.slots.entries('settings.general.item')).toHaveLength(0)
  expect(ctx.slots.entries('conversation.content.overlay')).toHaveLength(0)
  expect(ctx.get('remote.sessionVideo')).toBeUndefined()
  expect(remote.mounted).toHaveBeenCalledOnce()
  expect(remote.disposed).toHaveBeenCalledOnce()
})

it('releases the generated namespace when initialization fails', async () => {
  const { ctx, locale, remote } = await fixture()
  vi.spyOn(locale, 'register').mockImplementation(() => { throw Error('Dictionary initialization failed') })
  await expect(apply(ctx)).rejects.toThrow('Dictionary initialization failed')
  expect(ctx.get('remote.sessionVideo')).toBeUndefined()
  expect(remote.disposed).toHaveBeenCalledOnce()
  expect(ctx.slots.entries('settings.general.item')).toHaveLength(0)
})

it('reports a failed optional scope and allows a later accepted setting to retry it', async () => {
  const { ctx, form, remote } = await fixture(true)
  const error = vi.spyOn(ctx.logger, 'error').mockImplementation(() => {})
  const registration = vi.spyOn(ctx.uiConversation.headerPresentations, 'register')
    .mockImplementationOnce(() => { throw Error('Header owner unavailable') })
  const dispose = await apply(ctx)
  await waitFor(() => { expect(error).toHaveBeenCalled() })
  expect(ctx.slots.entries('conversation.content.overlay')).toHaveLength(0)
  expect(ctx.get('remote.sessionVideo')).toBe(remote.operations)
  registration.mockRestore()
  act(() => { form.publish({ status: 'ready', writable: true, value: { enabled: true } }) })
  await waitFor(() => { expect(ctx.slots.entries('conversation.content.overlay')).toHaveLength(1) })
  await dispose()
  expect(remote.disposed).toHaveBeenCalledOnce()
})
