// @vitest-environment jsdom
/** Native registration follows accepted settings and owns its traced Remote namespace. */
import { Context, Service } from '@deepseek-ai/cordis'
import type { ClientRemote } from '@deepseek-ai/dsh-api-remotes/client'
import type { ResourceProvider } from '@deepseek-ai/dsh-client-resources/client'
import type { PropsRenderSlots, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client'
import { UiConversation } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { InputTriggerSource } from '@deepseek-ai/dsh-client-ui-input-trigger/client'
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
import type { VideoSelectionTextInjected } from '../src/client/VideoSelectionText.tsx'
import type { VideoSuggestionLinkInjected } from '../src/client/VideoSuggestionLink.tsx'
import { SessionInputShell } from '../../ui-conversation/src/client/input/facade.ts'
import { NS } from '../src/client/locales.ts'
import { inventory, source, analysis } from './video-fixture.tsx'
import { sessionId as shotSessionId, shot } from './selection-fixture.client.ts'
import { videoWorkspaceAddress, VIDEO_REVIEW_REQUEST } from '../src/client/target-selection.ts'
import { VIDEO_REFERENCE_SOURCE, VIDEO_REVIEW_REFERENCE_SOURCE, VIDEO_REVIEW_REFERENCE } from '../src/client/references.ts'

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
  ctx.provide('sessions', sessions)
  new UiConversation(ctx, sessions)
  ctx.provide('conversation', { input: { for: () => { throw Error('No composer is mounted in the registration fixture') } } })
  const references = new Map<string, InputTriggerSource>(), referenceReleased = vi.fn()
  const registerSource = vi.fn((source: InputTriggerSource) => {
    if (references.has(source.name)) throw Error('Duplicate reference source in registration fixture')
    references.set(source.name, source)
    return () => { references.delete(source.name); referenceReleased(source.name) }
  })
  ctx.provide('inputTriggers', { registerSource })
  const openResource = vi.fn()
  ctx.provide('sidebarRight', { openResource })
  const registerTab = vi.fn<typeof ctx.sidebarRightTabs.register>(() => () => {})
  const registerResource = vi.fn<typeof ctx.resources.register>(() => () => {})
  ctx.provide('sidebarRightTabs', { register: registerTab })
  ctx.provide('resources', { register: registerResource })
  const form = stubConfigForm<{ enabled: boolean }>()
  ctx.provide('configForms', { get: (entry: string) => { expect(entry).toBe(SETTINGS_ENTRY); return form.scope } })
  const tabInfo = () => { throw Error('Registration fixture does not render a Sidebar tab') }
  ctx.slots.register({ name: 'root', children: {
    'settings.general.item': { kind: 'list', scope: 'root' },
    'conversation.chat.pinned': { kind: 'list', scope: 'session' },
    'conversation.input.dock': { kind: 'list', scope: 'session' },
    'conversation.chat.markdown.resource-link': { kind: 'hoc', scope: 'session', inline: true },
    'conversation.session.header.utilities': { kind: 'list', scope: 'session' },
    'deliverables.video': { kind: 'chain', scope: 'session' },
    'conversation.chat.turnTail': { kind: 'list', scope: 'session' },
    'sidebar.right.pane.tab': { kind: 'keyed', scope: 'session', inject: { hooks: { tabInfo } } },
    'sidebar.right.pane.tab.title': { kind: 'keyed', scope: 'session', inject: { hooks: { tabInfo } } },
    'conversation.user.text.node': { kind: 'keyed', scope: 'session' },
  } }, ({ renderSlot }: PropsRenderSlots<'settings.general.item' | 'conversation.chat.pinned' | 'conversation.input.dock'
    | 'conversation.chat.markdown.resource-link' | 'conversation.session.header.utilities' | 'deliverables.video' | 'conversation.chat.turnTail'
    | 'sidebar.right.pane.tab' | 'sidebar.right.pane.tab.title' | 'conversation.user.text.node'>) => renderSlot('settings.general.item', {}))
  const remote = new VideoRemote(ctx)
  return { ctx, locale, sessions, form, remote, references, referenceReleased, registerSource, openResource,
    registerTab, registerResource }
}

it('retains the selected-video codec across accepted presentation changes until the plugin unloads', async () => {
  const { ctx, form, remote, references, referenceReleased, registerSource, openResource } = await fixture(true)
  const dispose = await apply(ctx)
  await waitFor(() => { expect(ctx.slots.entries('conversation.session.header.utilities')).toHaveLength(1) })
  const selected = references.get(VIDEO_REFERENCE_SOURCE)
  const reviewMode = references.get(VIDEO_REVIEW_REFERENCE_SOURCE)
  if (selected?.codec === undefined || reviewMode?.codec === undefined) throw Error('Video references have no stable serializer')
  const sessionId = inventory([]).sessionId, item = source(), signal = new AbortController().signal
  const ref = videoWorkspaceAddress(sessionId, { kind: 'source', sourceId: item.id, sourceVersion: 'v1' })
  expect(selected.openReference?.({ sessionId }, { ref })).toBe(true)
  expect(openResource).toHaveBeenCalledOnce()
  act(() => { form.publish({ status: 'ready', writable: true, value: { enabled: false } }) })
  await waitFor(() => { expect(ctx.slots.entries('conversation.session.header.utilities')).toHaveLength(0) })
  expect(references.get(VIDEO_REFERENCE_SOURCE)).toBe(selected)
  expect(references.get(VIDEO_REVIEW_REFERENCE_SOURCE)).toBe(reviewMode)
  expect(registerSource).toHaveBeenCalledTimes(2)
  expect(referenceReleased).not.toHaveBeenCalled()
  expect(selected.openReference?.({ sessionId }, { ref })).toBe(false)
  expect(openResource).toHaveBeenCalledOnce()
  expect(await selected.codec.serialize(ref, signal)).toContain('"source_version": "v1"')
  expect(await reviewMode.codec.serialize(VIDEO_REVIEW_REFERENCE, signal)).toBe(VIDEO_REVIEW_REQUEST)
  expect(reviewMode.codec.clipboardText(VIDEO_REVIEW_REFERENCE)).toBe(ctx.locale.bind(NS)('readOnlyReview'))
  expect(remote.operations.list).toHaveBeenCalledExactlyOnceWith(sessionId, signal)
  act(() => { form.publish({ status: 'ready', writable: true, value: { enabled: true } }) })
  await waitFor(() => { expect(ctx.slots.entries('conversation.session.header.utilities')).toHaveLength(1) })
  expect(references.get(VIDEO_REFERENCE_SOURCE)).toBe(selected)
  expect(references.get(VIDEO_REVIEW_REFERENCE_SOURCE)).toBe(reviewMode)
  expect(registerSource).toHaveBeenCalledTimes(2)
  await dispose()
  expect(references.size).toBe(0)
  expect(referenceReleased).toHaveBeenCalledTimes(2)
  expect(referenceReleased).toHaveBeenCalledWith(VIDEO_REFERENCE_SOURCE)
  expect(referenceReleased).toHaveBeenCalledWith(VIDEO_REVIEW_REFERENCE_SOURCE)
})

it('keeps settings mounted while disabling and remounting every optional contribution', async () => {
  const { ctx, form, remote } = await fixture()
  const dispose = await apply(ctx)
  expect(ctx.slots.entries('settings.general.item')).toHaveLength(1)
  expect(ctx.slots.entries('conversation.session.header.utilities')).toHaveLength(0)
  expect(ctx.uiConversation.headerPresentations.getSnapshot()).toBeUndefined()
  act(() => { form.publish({ status: 'ready', writable: true, value: { enabled: true } }) })
  await waitFor(() => { expect(ctx.slots.entries('conversation.session.header.utilities')).toHaveLength(1) })
  expect(ctx.uiConversation.headerPresentations.getSnapshot()).toBeUndefined()
  expect(ctx.uiConversation.userText.entries().map(value => value.id)).toEqual(['muse-video-selection', 'muse-video-review'])
  expect(ctx.slots.entries('conversation.user.text.node')).toHaveLength(2)
  expect(ctx.slots.entries('conversation.chat.markdown.resource-link').map(entry => entry.options.key)).toEqual(['session-video'])
  const overlay = ctx.slots.entries('conversation.session.header.utilities')[0]
  if (!overlay?.inject) throw Error('Enabled shelf has no Host operations')
  const id = inventory([]).sessionId
  const injected = Reflect.apply(overlay.inject, undefined, [id]) as Partial<VideoInjected>
  if (!injected.detectShots) throw Error('Workspace detection is incomplete')
  const delivered = ctx.slots.entries('deliverables.video')[0]
  const generated = ctx.slots.entries('conversation.chat.turnTail')[0]
  if (!delivered?.select || !delivered.inject || !generated?.inject) throw Error('Video playback contributions are incomplete')
  // Registry entries erase the named chain's input type.
  const select = delivered.select as (props: Pick<PropsRuntime<'deliverables.video'>,
    'sourceUrl' | 'label' | 'path' | 'seq' | 'index'>) => boolean
  expect(select({ sourceUrl: '/delivered.mp4', label: 'Delivered video', path: 'delivered.mp4', seq: 1, index: 0 })).toBe(true)
  expect(Reflect.apply(delivered.inject, undefined, [id])).toBe(injected)
  expect(Reflect.apply(generated.inject, undefined, [id])).toBe(injected)
  const controller = new AbortController()
  expect(injected.pixelsPerSecond).toBe(64)
  expect(await injected.detectShots(id, source().id, 'v1', controller.signal)).toEqual(analysis(source()))
  expect(remote.operations.detect).toHaveBeenCalledExactlyOnceWith(id, source().id, 'v1', controller.signal)
  const detectionFailure = new RemoteError('gateway/internal', 'Unavailable detector', {})
  remote.operations.detect.mockResolvedValueOnce({ ok: false, error: detectionFailure })
  await expect(injected.detectShots(id, source().id, 'v1', controller.signal)).rejects.toBe(detectionFailure)
  const settings = ctx.slots.entries('settings.general.item')[0]?.inject?.() as PresentationSettingFace | undefined
  if (!settings) throw Error('Settings row has no persistent writer')
  form.set.mockResolvedValueOnce(false)
  await expect(settings.setEnabled(false)).rejects.toThrow('Session video setting was refused')
  expect(ctx.slots.entries('conversation.session.header.utilities')).toHaveLength(1)
  await settings.setEnabled(false)
  for (const slot of ['conversation.session.header.utilities', 'conversation.chat.pinned', 'conversation.input.dock', 'deliverables.video',
    'conversation.chat.turnTail', 'conversation.chat.markdown.resource-link'] as const) {
    expect(ctx.slots.entries(slot)).toHaveLength(0)
  }
  expect(ctx.uiConversation.headerPresentations.getSnapshot()).toBeUndefined()
  expect(ctx.uiConversation.userText.entries()).toEqual([])
  expect(ctx.slots.entries('conversation.user.text.node')).toHaveLength(0)
  await settings.setEnabled(true)
  expect(ctx.slots.entries('conversation.session.header.utilities')).toHaveLength(1)
  expect(ctx.slots.entries('conversation.session.header.utilities')[0]).not.toBe(overlay)
  await dispose()
  expect(form.listenerCount()).toBe(0)
  expect(ctx.slots.entries('settings.general.item')).toHaveLength(0)
  expect(ctx.slots.entries('conversation.session.header.utilities')).toHaveLength(0)
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
  const registration = vi.spyOn(ctx.sidebarRightTabs, 'register')
    .mockImplementationOnce(() => { throw Error('Video tab owner unavailable') })
  const dispose = await apply(ctx)
  await waitFor(() => { expect(error).toHaveBeenCalled() })
  expect(ctx.slots.entries('conversation.session.header.utilities')).toHaveLength(0)
  expect(ctx.get('remote.sessionVideo')).toBe(remote.operations)
  registration.mockRestore()
  act(() => { form.publish({ status: 'ready', writable: true, value: { enabled: true } }) })
  await waitFor(() => { expect(ctx.slots.entries('conversation.session.header.utilities')).toHaveLength(1) })
  await dispose()
  expect(remote.disposed).toHaveBeenCalledOnce()
})

it('routes native workspace titles, valid advice links and local menu actions through their owning conversation', async () => {
  const { ctx, locale, openResource, registerTab } = await fixture(true)
  const dispose = await apply(ctx)
  await waitFor(() => { expect(ctx.slots.entries('conversation.session.header.utilities')).toHaveLength(1) })
  const definition = registerTab.mock.calls[0]?.[0]
  if (definition === undefined) throw Error('Video tab definition is unavailable')
  const sessionId = inventory([]).sessionId, item = source()
  const address = videoWorkspaceAddress(sessionId, { kind: 'source', sourceId: item.id, sourceVersion: 'v1' })
  expect(definition.canOpen?.('sidebar://session-video')).toBe(true)
  expect(definition.canOpen?.(address)).toBe(true)
  expect(definition.canOpen?.('dsh-resource://other/item')).toBe(false)
  const t = locale.bind(NS)
  expect(definition.title(address)).toBe(t('library'))
  expect(definition.guide?.[0]?.title()).toBe(t('library'))
  const title = ctx.slots.entries('sidebar.right.pane.tab.title')[0]
  if (title === undefined) throw Error('Video title component is unavailable')
  const titleProps = { sessionId, t, useTabInfo: () => ({ tab: { navigation: { address } } }),
    useResource: () => ({ value: inventory([item]) }) }
  expect(Reflect.apply(title.component as () => string, undefined, [titleProps])).toBe(item.label)
  expect(Reflect.apply(title.component as () => string, undefined, [{ ...titleProps, useResource: () => ({}) }])).toBe(t('library'))
  expect(Reflect.apply(title.component as () => string, undefined, [{ ...titleProps,
    useTabInfo: () => ({ tab: { navigation: { address: 'invalid' } } }) }])).toBe(t('library'))
  const header = ctx.slots.entries('conversation.session.header.utilities')[0]
  if (header?.inject === undefined) throw Error('Video actions are unavailable')
  const actions = Reflect.apply(header.inject, undefined, [sessionId]) as VideoInjected
  actions.openWorkspace()
  actions.openWorkspace('float')
  const currentShot = shot(item)
  actions.openWorkspace('sidebar', currentShot, 'compare')
  actions.openWorkspace('sidebar', undefined, 'compare')
  expect(openResource.mock.calls.slice(-4)).toEqual([
    [videoWorkspaceAddress(sessionId), { kind: 'session-video', destination: 'sidebar' }],
    [videoWorkspaceAddress(sessionId), { kind: 'session-video', destination: 'float' }],
    [videoWorkspaceAddress(sessionId), { kind: 'session-video', destination: 'sidebar',
      params: { sessionId, target: currentShot, compareVersions: true } }],
    [videoWorkspaceAddress(sessionId), { kind: 'session-video', destination: 'sidebar' }],
  ])
  expect(ctx.slots.entries('conversation.input.dock').map(entry => entry.options.id)).toEqual(['muse-video-scope'])
  const adviceEntry = ctx.slots.entries('conversation.chat.markdown.resource-link')[0]
  if (adviceEntry?.inject === undefined) throw Error('Video advice actions are unavailable')
  const advice = Reflect.apply(adviceEntry.inject, undefined, [sessionId]) as VideoSuggestionLinkInjected
  openResource.mockClear()
  advice.openAdvice({ sessionId: inventory([]).sessionId, target: currentShot, seekSeconds: 5 })
  expect(openResource).toHaveBeenCalledExactlyOnceWith(videoWorkspaceAddress(sessionId), {
    kind: 'session-video', destination: 'sidebar', params: { sessionId, target: currentShot, seekSeconds: 5 },
  })
  advice.openAdvice({ sessionId: shotSessionId, target: currentShot, seekSeconds: 5 })
  expect(openResource).toHaveBeenCalledOnce()
  const entries = ctx.slots.entries('conversation.user.text.node')
  const selection = entries.find(entry => entry.options.key === 'muse-video-selection')
  const review = entries.find(entry => entry.options.key === 'muse-video-review')
  if (selection?.inject === undefined || review === undefined) throw Error('Video text contributions are unavailable')
  const selected = Reflect.apply(selection.inject, undefined, [sessionId]) as VideoSelectionTextInjected
  openResource.mockClear()
  selected.openVideoSelection('invalid')
  selected.openVideoSelection(address.replace(String(sessionId), 'another-conversation'))
  selected.openVideoSelection(address)
  expect(openResource).toHaveBeenCalledExactlyOnceWith(address, { kind: 'session-video', destination: 'sidebar' })
  expect(Reflect.apply(review.component as () => null, undefined, [])).toBeNull()
  await dispose()
})

it('adds source references to the retained composer once and refuses missing or unrelated removal targets', async () => {
  const { ctx, sessions } = await fixture(true)
  const dispose = await apply(ctx)
  await waitFor(() => { expect(ctx.slots.entries('conversation.session.header.utilities')).toHaveLength(1) })
  const sessionId = inventory([]).sessionId, item = source()
  const header = ctx.slots.entries('conversation.session.header.utilities')[0]
  if (header?.inject === undefined) throw Error('Video actions are unavailable')
  const actions = Reflect.apply(header.inject, undefined, [sessionId]) as VideoInjected
  const target = { kind: 'source' as const, sourceId: item.id, sourceVersion: 'v1' }
  expect(actions.addTargetReference(target, item.label, { start: 0, end: 0, draftRev: 0 })).toBe(false)
  expect(actions.addVideoAttachment()).toBe(false)
  await sessions.add({ id: sessionId })
  const held = sessions.retain(sessionId)
  onTestFinished(() => { held.release() })
  const binding = await held.ready
  const shell = new SessionInputShell({ actx: binding.ctx, defaultSink: async () => ({ kind: 'success' }),
    commandAttachments: { serialize: async () => [], release: () => {}, unsupportedNotice: token => token } })
  onTestFinished(() => { shell.dispose() })
  const input = vi.spyOn(ctx.conversation.input, 'for').mockReturnValue(shell)
  shell.setDraft('Change this. ')
  const openFile = vi.fn()
  const unbind = shell.bindFilePicker({ available: () => true, open: openFile })
  expect(actions.addVideoAttachment()).toBe(true)
  expect(openFile).toHaveBeenCalledOnce()
  expect(shell.snapshot.draft).toBe('Change this. ')
  unbind()
  expect(actions.addVideoAttachment()).toBe(false)
  const end = shell.snapshot.draft.length
  expect(actions.addTargetReference(target, item.label, { start: end, end, draftRev: shell.snapshot.draftRev })).toBe(true)
  const occurrence = shell.snapshot.occurrences[0]
  if (occurrence === undefined) throw Error('Composer has no inserted video reference')
  const original = shell.snapshot.draft
  expect(input).toHaveBeenCalledWith(binding.ctx)
  expect(actions.addTargetReference(target, item.label, { start: 0, end: 0, draftRev: -1 })).toBe(true)
  expect(shell.snapshot.draft).toBe(original)
  expect(shell.snapshot.occurrences).toHaveLength(1)
  expect(actions.removeTargetReference({ ...occurrence, source: 'other' })).toBe(false)
  expect(actions.removeTargetReference(occurrence)).toBe(true)
  expect(shell.snapshot.occurrences).toEqual([])
  held.release()
  await waitFor(() => { expect(sessions.binding(sessionId)).toBeUndefined() })
  expect(actions.removeTargetReference(occurrence)).toBe(false)
  await dispose()
})

it('keeps one localized removable review mode and clears it before editing without removing video references', async () => {
  const { ctx, sessions, locale, references } = await fixture(true)
  const dispose = await apply(ctx)
  await waitFor(() => { expect(ctx.slots.entries('conversation.session.header.utilities')).toHaveLength(1) })
  const sessionId = inventory([]).sessionId, item = source(), t = locale.bind(NS)
  const header = ctx.slots.entries('conversation.session.header.utilities')[0]
  if (header?.inject === undefined) throw Error('Video actions are unavailable')
  const actions = Reflect.apply(header.inject, undefined, [sessionId]) as VideoInjected
  expect(actions.setReviewMode(true, { start: 0, end: 0, draftRev: 0 })).toBe(false)
  expect(actions.setReviewMode(false, { start: 0, end: 0, draftRev: 0 })).toBe(false)
  await sessions.add({ id: sessionId })
  const held = sessions.retain(sessionId)
  onTestFinished(() => { held.release() })
  const binding = await held.ready
  const shell = new SessionInputShell({ actx: binding.ctx, defaultSink: async () => ({ kind: 'success' }),
    commandAttachments: { serialize: async () => [], release: () => {}, unsupportedNotice: token => token } })
  onTestFinished(() => { shell.dispose() })
  vi.spyOn(ctx.conversation.input, 'for').mockReturnValue(shell)
  const setMode = (enabled: boolean) => actions.setReviewMode(enabled, shell.actions.captureInsertion())
  shell.setDraft('Keep this unfinished instruction. ')
  expect(actions.addTargetReference({ kind: 'source', sourceId: item.id, sourceVersion: 'v1' },
    item.label, shell.actions.captureInsertion())).toBe(true)
  expect(setMode(true)).toBe(true)
  const original = shell.snapshot.draft
  const mode = shell.snapshot.occurrences.find(value => value.source === VIDEO_REVIEW_REFERENCE_SOURCE)
  if (mode === undefined) throw Error('Read-only mode is missing')
  expect(mode.label).toBe(t('readOnlyReview'))
  expect(mode.clipboardText).toBe(t('readOnlyReview'))
  expect(shell.snapshot.draft.startsWith('Keep this unfinished instruction. ')).toBe(true)
  expect(shell.snapshot.draft).not.toContain('muse-video-review')
  expect(setMode(true)).toBe(true)
  expect(shell.snapshot.draft).toBe(original)
  expect(shell.snapshot.occurrences).toHaveLength(2)
  const remove = vi.spyOn(shell, 'removeReference').mockReturnValueOnce(false)
  expect(setMode(false)).toBe(false)
  expect(shell.snapshot.occurrences).toHaveLength(2)
  expect(setMode(false)).toBe(true)
  expect(remove).toHaveBeenLastCalledWith(mode)
  expect(shell.snapshot.occurrences.map(value => value.source)).toEqual([VIDEO_REFERENCE_SOURCE])
  const insert = vi.spyOn(shell, 'insertReference').mockReturnValueOnce(false)
  expect(setMode(true)).toBe(false)
  locale.setLocale('zh')
  expect(setMode(true)).toBe(true)
  expect(insert.mock.calls.at(-1)?.[0].label).toBe(t('readOnlyReview'))
  const restored = shell.snapshot.occurrences.find(value => value.source === VIDEO_REVIEW_REFERENCE_SOURCE)
  if (restored === undefined) throw Error('Read-only mode was not reinserted')
  expect(shell.removeReference(restored)).toBe(true)
  expect(shell.snapshot.occurrences.map(value => value.source)).toEqual([VIDEO_REFERENCE_SOURCE])
  expect(setMode(false)).toBe(true)
  const codec = references.get(VIDEO_REVIEW_REFERENCE_SOURCE)?.codec
  if (codec === undefined) throw Error('Read-only mode serializer is missing')
  await expect(codec.serialize('invalid', new AbortController().signal)).rejects.toThrow(t('reviewModeInvalid'))
  held.release()
  await waitFor(() => { expect(sessions.binding(sessionId)).toBeUndefined() })
  expect(setMode(true)).toBe(false)
  await dispose()
})

it('retains inventory readers until cancellation and refreshes them through the registered workspace actions', async () => {
  const { ctx, sessions, remote, registerResource } = await fixture(true)
  const dispose = await apply(ctx)
  await waitFor(() => { expect(ctx.slots.entries('conversation.session.header.utilities')).toHaveLength(1) })
  const sessionId = inventory([]).sessionId
  await sessions.add({ id: sessionId })
  const provider = registerResource.mock.calls[0]?.[0] as ResourceProvider<'session-video'> | undefined
  const header = ctx.slots.entries('conversation.session.header.utilities')[0]
  if (provider === undefined || header?.inject === undefined) throw Error('Video resources are unavailable')
  const actions = Reflect.apply(header.inject, undefined, [sessionId]) as VideoInjected
  const controller = new AbortController()
  onTestFinished(() => { controller.abort() })
  const stream = provider.open(videoWorkspaceAddress(sessionId), { signal: controller.signal })[Symbol.asyncIterator]()
  try {
    expect((await stream.next()).value).toEqual({ ok: true, value: inventory([source()]) })
    expect(sessions.binding(sessionId)).toBeDefined()
    actions.refreshVideos()
    expect((await stream.next()).value).toEqual({ ok: true, value: inventory([source()]) })
    expect(remote.operations.list).toHaveBeenCalledTimes(2)
  } finally {
    controller.abort()
    await stream.return?.()
    await dispose()
  }
  expect(sessions.binding(sessionId)).toBeUndefined()
})

it.each([true, false])('exposes unopened conversation failures through the retained resource, explicit error=%s', async (explicit) => {
  const { ctx, sessions, registerResource } = await fixture(true)
  const dispose = await apply(ctx)
  await waitFor(() => { expect(ctx.slots.entries('conversation.session.header.utilities')).toHaveLength(1) })
  const sessionId = inventory([]).sessionId, error = new RemoteError('gateway/internal', 'Conversation cannot open', {})
  await sessions.add({ id: sessionId, snapshot: { openState: 'error', openError: explicit ? error : null } })
  const provider = registerResource.mock.calls[0]?.[0] as ResourceProvider<'session-video'> | undefined
  if (provider === undefined) throw Error('Video resources are unavailable')
  const controller = new AbortController()
  onTestFinished(() => { controller.abort() })
  const stream = provider.open(videoWorkspaceAddress(sessionId), { signal: controller.signal })[Symbol.asyncIterator]()
  try {
    expect((await stream.next()).value).toMatchObject({ ok: false, error: {
      message: explicit ? error.message : 'Session video conversation is not open',
    } })
  } finally {
    controller.abort()
    await stream.return?.()
    await dispose()
  }
})

it('localizes invalid and stale reference serialization failures on the persistent source codec', async () => {
  const { ctx, locale, references } = await fixture(true)
  const dispose = await apply(ctx)
  const codec = references.get(VIDEO_REFERENCE_SOURCE)?.codec
  if (codec === undefined) throw Error('Video reference codec is unavailable')
  const t = locale.bind(NS), signal = new AbortController().signal
  await expect(codec.serialize('invalid', signal)).rejects.toThrow(t('referenceInvalid'))
  await expect(codec.serialize(videoWorkspaceAddress(inventory([]).sessionId, {
    kind: 'source', sourceId: source().id, sourceVersion: 'replaced',
  }), signal)).rejects.toThrow(t('referenceStale'))
  await dispose()
})
