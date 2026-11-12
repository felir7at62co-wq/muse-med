// @vitest-environment jsdom
/** Real Cordis registries retain optional presentation and Remote ownership across accepted switches. */
import { Context, Service } from '@deepseek-ai/cordis'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client'
import type { OwnerOf, StoredEntry } from '@deepseek-ai/dsh-client-ui-slots'
import { UiConversation } from '@deepseek-ai/dsh-client-ui-conversation/client'
import { RemoteError, TestRoot, TestSessions, stubConfigForm } from '@deepseek-ai/dsh-client-test-runtime'
import type { ConfigForm } from '@deepseek-ai/dsh-client-ui-settings/client'
import type { ClientRemote } from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@deepseek-ai/dsh-session-video/remote'
import type { TypertRemoteContribution } from '@deepseek-ai/dsh-typert-protocol'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { SessionVideoSourceId } from '@deepseek-ai/dsh-session-video'
import { afterEach, expect, it, onTestFinished, vi } from 'vitest'
import { apply, inject } from '../src/client/index.ts'
import { SESSION_VIDEO_CONFIG_GLOBAL, SETTINGS_ENTRY } from '../src/config.ts'
import type { PresentationSettingFace } from '../src/client/PresentationSetting.tsx'
import type { VideoInjected } from '../src/client/face.ts'
import { en, NS } from '../src/client/locales.ts'

const { contribution } = vi.hoisted(() => ({
  contribution: { package: '@deepseek-ai/dsh-session-video', descriptors: [] } satisfies TypertRemoteContribution,
}))
vi.mock('@deepseek-ai/dsh-session-video/remote', () => ({ default: contribution }))
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })

declare module '@deepseek-ai/cordis' {
  interface Context { 'remote.sessionVideo': ClientRemote['sessionVideo'] }
}

class VideoRemote extends Service {
  readonly trace: string[] = []
  constructor(ctx: Context, readonly namespace: ClientRemote['sessionVideo']) { super(ctx, 'remote') }
  async $mount(value: TypertRemoteContribution): Promise<() => Promise<void>> {
    expect(value).toBe(contribution)
    this.trace.push('mount')
    const owner = this.ctx.plugin((scope) => { scope.provide('remote.sessionVideo', this.namespace) })
    await owner.await()
    return async () => { this.trace.push('remote-dispose'); await owner.dispose() }
  }
  get sessionVideo(): ClientRemote['sessionVideo'] { return this.namespace }
}

/** The settings transport face consumed by this plugin, owned by its real Cordis service lifetime. */
class PresentationForms extends Service {
  constructor(ctx: Context, readonly get: (entryId: string) => ConfigForm<{ enabled: boolean }>) { super(ctx, 'configForms') }
}

function injected(entry: StoredEntry): object {
  const value = entry.inject?.()
  if (value === undefined) throw new Error('Expected an injected presentation face')
  return value
}

async function setup(accepted: boolean | 'loading' = false, bootstrap = true) {
  vi.stubGlobal(SESSION_VIDEO_CONFIG_GLOBAL, { enabled: bootstrap, pixelsPerSecond: 64 })
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  await ctx.plugin(SlotRegistry).await()
  const slots = ctx.get('slots') as SlotRegistry
  const locale = new LocaleRuntime(ctx)
  ctx.provide('locale', locale)
  locale.setLocale('en')
  const sessions = new TestSessions(async (action) => { await action() }, ctx)
  onTestFinished(() => sessions.disposeScopes())
  ctx.provide('sessions', sessions)
  new UiConversation(ctx, sessions)
  ctx.uiConversation.headerPresentations.register({ id: 'prior', presentation: 'standard' })
  const form = stubConfigForm<{ enabled: boolean }>()
  if (accepted !== 'loading') form.publish({ status: 'ready', writable: true, value: { enabled: accepted } })
  const getForm = vi.fn(() => form.scope)
  new PresentationForms(ctx, getForm)
  const id = SessionId('video-plugin')
  const source = brandString<SessionVideoSourceId>('video-source')
  const inventory = { sessionId: id, sources: [], complete: true, issues: [] }
  const analysis = { sourceId: source, sourceVersion: 'v1', state: 'ready' as const,
    durationSeconds: 2, width: 64, height: 48, shots: [], method: 'ffmpeg-scene' as const, threshold: 0.3, issue: null }
  const list = vi.fn<ClientRemote['sessionVideo']['list']>(async () => ({ ok: true, value: inventory }))
  const detect = vi.fn<ClientRemote['sessionVideo']['detect']>(async () => ({ ok: true, value: analysis }))
  const remote = new VideoRemote(ctx, { list, detect })
  const root = new TestRoot(slots, async (action) => { await action() })
  onTestFinished(() => { root.release() })
  await root.declare({
    'settings.general.item': { kind: 'list', scope: 'root' },
    'conversation.chat.pinned': { kind: 'list', scope: 'session' },
    'conversation.content.overlay': { kind: 'list', scope: 'session' },
    'deliverables.video': { kind: 'chain', scope: 'session' },
    'conversation.chat.turnTail': { kind: 'list', scope: 'session' },
  }, () => null)
  const mount = async () => {
    const dispose = await apply(ctx)
    onTestFinished(dispose)
    return dispose
  }
  const setting = () => injected(slots.entries('settings.general.item')[0]!) as PresentationSettingFace
  const face = () => injected(slots.entries('conversation.content.overlay')[0]!) as VideoInjected
  const counts = () => (['conversation.chat.pinned', 'conversation.content.overlay', 'deliverables.video', 'conversation.chat.turnTail'] as const)
    .map(key => slots.entries(key).length)
  return { ctx, slots, locale, form, getForm, remote, list, detect, id, source, inventory, analysis, mount, setting, face, counts }
}

it('keeps settings available while disabled, switches the four real contributions and restores prior header ownership', async () => {
  expect(inject).toEqual(['slots', 'locale', 'remote', 'configForms', 'uiConversation'])
  const h = await setup(), dispose = await h.mount()
  expect(h.getForm).toHaveBeenCalledExactlyOnceWith(SETTINGS_ENTRY)
  expect(h.counts()).toEqual([0, 0, 0, 0])
  expect(h.slots.entries('settings.general.item')).toHaveLength(1)
  expect(h.locale.bind(NS)('settingTitle')).toBe(en.settingTitle)
  expect(h.form.listenerCount()).toBe(1)
  await h.setting().setEnabled(true)
  expect(h.form.set).toHaveBeenCalledWith('enabled', true)
  expect(h.counts()).toEqual([1, 1, 1, 1])
  expect(h.ctx.uiConversation.headerPresentations.getSnapshot()).toBe('floating')
  const store = h.slots.entries('conversation.content.overlay')[0]?.store
  // StoredEntry erases selector input to never; this contribution accepts the slot's declared owner.
  const select = h.slots.entries('deliverables.video')[0]?.select as ((owner: OwnerOf<'deliverables.video'>) => unknown) | undefined
  expect(select?.({ sourceUrl: '/api/video', label: 'Actual video', path: '/work/actual.mp4', seq: 4, index: 0 })).toBe(true)
  expect(injected(h.slots.entries('deliverables.video')[0]!)).toEqual(h.face())
  expect(injected(h.slots.entries('conversation.chat.turnTail')[0]!)).toEqual(h.face())
  h.form.publish({ value: { enabled: true } })
  await h.setting().setEnabled(false)
  expect(h.counts()).toEqual([0, 0, 0, 0])
  expect(h.ctx.uiConversation.headerPresentations.getSnapshot()).toBe('standard')
  await h.setting().setEnabled(true)
  expect(h.counts()).toEqual([1, 1, 1, 1])
  expect(h.slots.entries('conversation.content.overlay')[0]?.store).not.toBe(store)
  await dispose()
  expect(h.counts()).toEqual([0, 0, 0, 0])
  expect(h.slots.entries('settings.general.item')).toHaveLength(0)
  expect(h.form.listenerCount()).toBe(0)
  expect(h.ctx.uiConversation.headerPresentations.getSnapshot()).toBe('standard')
  expect(h.ctx.get('remote.sessionVideo')).toBeUndefined()
  expect(h.remote.trace).toEqual(['mount', 'remote-dispose'])
  expect(h.locale.bind(NS)('settingTitle')).toBe('settingTitle')
})

it('uses startup policy until an accepted setting arrives and forwards source identities, errors and cancellation signals', async () => {
  const h = await setup('loading'), dispose = await h.mount()
  await vi.waitFor(() => { expect(h.counts()).toEqual([1, 1, 1, 1]) })
  const face = h.face(), signal = new AbortController().signal
  expect(face.pixelsPerSecond).toBe(64)
  expect(await face.listVideos(h.id, signal)).toBe(h.inventory)
  expect(h.list).toHaveBeenCalledExactlyOnceWith(h.id, signal)
  expect(await face.detectShots(h.id, h.source, 'v1', signal)).toBe(h.analysis)
  expect(h.detect).toHaveBeenCalledExactlyOnceWith(h.id, h.source, 'v1', signal)
  h.list.mockResolvedValueOnce({ ok: false, error: new RemoteError('gateway/invocation-unavailable', 'private detail', { endpoint: 'sessionVideo/list' }) })
  await expect(face.listVideos(h.id, signal)).rejects.toThrow('gateway/invocation-unavailable')
  h.detect.mockResolvedValueOnce({ ok: false, error: new RemoteError('gateway/result-invalid', 'private detail', { endpoint: 'sessionVideo/detect' }) })
  await expect(face.detectShots(h.id, h.source, 'v1', signal)).rejects.toThrow('gateway/result-invalid')
  h.form.publish({ status: 'ready', writable: true, value: { enabled: false } })
  await vi.waitFor(() => { expect(h.counts()).toEqual([0, 0, 0, 0]) })
  await dispose()
})

it('keeps the presentation unchanged when a saved write is refused', async () => {
  const h = await setup(), dispose = await h.mount()
  h.form.set.mockResolvedValueOnce(false)
  await expect(h.setting().setEnabled(true)).rejects.toThrow('Session video setting was refused')
  expect(h.counts()).toEqual([0, 0, 0, 0])
  expect(h.ctx.uiConversation.headerPresentations.getSnapshot()).toBe('standard')
  await dispose()
})

it('unwinds a failed optional provider and permits a later accepted enable to create a fresh scope', async () => {
  const h = await setup(), dispose = await h.mount()
  const registration = vi.spyOn(h.ctx.uiConversation.headerPresentations, 'register')
    .mockImplementationOnce(() => { throw new Error('Header provider unavailable') })
  await expect(h.setting().setEnabled(true)).rejects.toThrow('Header provider unavailable')
  expect(h.counts()).toEqual([0, 0, 0, 0])
  expect(h.slots.entries('settings.general.item')).toHaveLength(1)
  registration.mockRestore()
  await h.setting().setEnabled(true)
  expect(h.counts()).toEqual([1, 1, 1, 1])
  await dispose()
})

it('releases its generated Remote namespace if outer locale initialization fails', async () => {
  const h = await setup()
  vi.spyOn(h.locale, 'register').mockImplementationOnce(() => { throw new Error('Locale unavailable') })
  await expect(h.mount()).rejects.toThrow('Locale unavailable')
  expect(h.remote.trace).toEqual(['mount', 'remote-dispose'])
  expect(h.ctx.get('remote.sessionVideo')).toBeUndefined()
  expect(h.counts()).toEqual([0, 0, 0, 0])
})

it('reports an initial optional provider failure while retaining the setting for an explicit retry', async () => {
  const h = await setup('loading'), failure = new Error('Initial header provider unavailable')
  const errors = vi.spyOn(h.ctx.logger, 'error').mockImplementation(() => {})
  const registration = vi.spyOn(h.ctx.uiConversation.headerPresentations, 'register').mockImplementationOnce(() => { throw failure })
  const dispose = await h.mount()
  await vi.waitFor(() => { expect(errors).toHaveBeenCalledWith(failure) })
  expect(h.counts()).toEqual([0, 0, 0, 0])
  expect(h.slots.entries('settings.general.item')).toHaveLength(1)
  registration.mockRestore()
  await h.setting().setEnabled(true)
  expect(h.counts()).toEqual([1, 1, 1, 1])
  await dispose()
})
