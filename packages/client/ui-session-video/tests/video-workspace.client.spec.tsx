// @vitest-environment jsdom
/** Episode browsing and scoped requests share the existing conversation input. */
import { useSyncExternalStore } from 'react'
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { allowAllAccess, contextMenuHook, bindSnapshotSelector, makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { DraftAttachmentId, InputState, Occurrence } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { ResourceSnapshot } from '@deepseek-ai/dsh-client-resources/client'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { PaneId, TabId } from '@deepseek-ai/dsh-client-ui-dockkit'
import type { SessionVideoAnalysis, SessionVideoInventory } from '@deepseek-ai/dsh-session-video/types'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { VideoWorkspace } from '../src/client/VideoWorkspace.tsx'
import type { VideoWorkspaceProps } from '../src/client/face.ts'
import { createVideoStore } from '../src/client/store.ts'
import { en } from '../src/client/locales.ts'
import { VIDEO_REFERENCE_SOURCE, VIDEO_REVIEW_REFERENCE_SOURCE, VIDEO_REVIEW_REFERENCE } from '../src/client/references.ts'
import { videoWorkspaceAddress, type VideoWorkspaceNavigation } from '../src/client/target-selection.ts'
import { authoredShots } from '../src/client/timeline.ts'
import { analysis } from './video-fixture.tsx'
import { inventory, sessionId, source, whole } from './selection-fixture.client.ts'

afterEach(() => { cleanup(); localStorage.clear(); vi.restoreAllMocks() })
const unused = (): never => { throw Error('Workspace accessed an unrelated framework seat') }

function setup(items = [source()], initial: Partial<InputState> = {}, overrides: Partial<VideoWorkspaceProps> = {}) {
  vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(() => {})
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {})
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue()
  const instance = createVideoStore().create()
  const resource = createSnapshotStore<ResourceSnapshot<SessionVideoInventory>>({ status: 'live', value: inventory(items), failure: undefined })
  const input = createSnapshotStore<InputState>({ draft: 'Keep the draft', draftRev: 1, occurrences: [], attachmentIds: [], phase: 'plain', queue: [], ...initial })
  const openResource = vi.fn()
  const tabInfo = createSnapshotStore<ReturnType<VideoWorkspaceProps['useTabInfo']>>({
    sidebar: { expanded: true, fullscreen: false }, panel: { id: brandString<PaneId>('video-pane'), isFloating: false },
    tab: { id: brandString<TabId>('video-tab'), kind: 'session-video', contentId: videoWorkspaceAddress(sessionId), title: 'Videos', visible: true,
      signal: new AbortController().signal, navigation: { address: videoWorkspaceAddress(sessionId), params: undefined, revision: 1 },
      actions: { bindCommands: vi.fn(() => vi.fn()), openResource, openTab: vi.fn(), close: vi.fn() } },
  })
  const inputActions = { insertQuote: unused, captureInsertion: vi.fn(() => ({ start: 0, end: 0, draftRev: 1 })),
    insertText: vi.fn(() => true), setDraft: unused, persistDraft: vi.fn(), addAttachments: unused, removeAttachment: unused,
    pruneAttachments: unused, submit: vi.fn() }
  const detectShots = vi.fn<VideoWorkspaceProps['detectShots']>().mockImplementation(async (_session, id) => {
    const item = items.find(value => value.id === id)
    if (item === undefined) throw Error('Unknown media')
    return analysis(item)
  })
  const addTargetReference = vi.fn(() => true), removeTargetReference = vi.fn(() => true),
    setReviewMode = vi.fn(() => true), refreshVideos = vi.fn(), addVideoAttachment = vi.fn(() => true)
  const subscribeResource = resource.subscribe.bind(resource), readResource = resource.getSnapshot.bind(resource)
  const subscribeTab = tabInfo.subscribe.bind(tabInfo), readTab = tabInfo.getSnapshot.bind(tabInfo)
  const props: VideoWorkspaceProps = {
    ...allowAllAccess, sessionId, useSession: unused, useProjection: unused, useConversation: unused,
    useChat: unused, useTrajectory: unused, usePanelInfo: unused, useSessions: unused, useSessionStatus: unused,
    useSessionRetainInfo: unused, useWorkspaces: unused, useContextMenu: contextMenuHook(),
    // This isolated resource provider serves the one namespace the workspace requests.
    useResource: (() => useSyncExternalStore(subscribeResource, readResource)) as VideoWorkspaceProps['useResource'],
    useInput: bindSnapshotSelector(input), inputActions, useStore: bindSnapshotSelector(instance.store), actions: instance.actions,
    useTabInfo: () => useSyncExternalStore(subscribeTab, readTab),
    detectShots, addTargetReference, removeTargetReference, setReviewMode, refreshVideos, addVideoAttachment,
    openWorkspace: vi.fn(), pixelsPerSecond: 48, t: makeTranslate(en),
    ...overrides,
  }
  const view = render(<VideoWorkspace {...props} />)
  return { view, instance, input, resource, tabInfo, props, inputActions, detectShots, openResource,
    addTargetReference, removeTargetReference, setReviewMode, refreshVideos, addVideoAttachment }
}

function reference(item = source()): Occurrence {
  return { occurrenceId: 1, source: VIDEO_REFERENCE_SOURCE, ref: videoWorkspaceAddress(sessionId, whole(item)),
    label: item.label, clipboardText: item.label, offset: 0, length: 1 }
}

function openSuggestion(h: ReturnType<typeof setup>, address: string, revision = 2) {
  const url = new URL(address)
  url.searchParams.set('suggestion', 'Keep the reaction for another beat.')
  const current = h.tabInfo.getSnapshot()
  act(() => { h.tabInfo.set({ ...current, tab: { ...current.tab, contentId: url.toString(),
    navigation: { address: url.toString(), params: undefined, revision } } }) })
}

function navigateWorkspace(h: ReturnType<typeof setup>, params: VideoWorkspaceNavigation, revision: number) {
  const current = h.tabInfo.getSnapshot()
  const address = videoWorkspaceAddress(sessionId)
  act(() => { h.tabInfo.set({ ...current, tab: { ...current.tab, contentId: address, navigation: { address, params, revision } } }) })
}

it('browses episodes, selects an observed authored shot, and preserves its navigation when floating', async () => {
  const item = { ...source(), production: { scriptId: 10, episodeNumber: 2, packageIndex: 3, shotNumbers: [10, 11],
    shotRanges: [{ shotNumber: 10, startSeconds: 0, endSeconds: 2 }] } }
  const h = setup([item, source('unassigned')])
  await waitFor(() => { expect(h.instance.getSnapshot().analyses[item.id]).toBeDefined() })
  const episode = h.view.getByRole('combobox', { name: 'Choose episode' })
  expect(h.view.getByRole('heading', { name: 'Conversation videos' })).toBeDefined()
  fireEvent.click(h.view.getByRole('button', { name: 'Video selection' }))
  fireEvent.change(episode, { target: { value: '2' } })
  fireEvent.keyDown(h.view.getByRole('group', { name: 'Video selection' }), { key: 'a' })
  fireEvent.keyDown(episode, { key: 'Escape' })
  expect(document.activeElement).toBe(h.view.getByRole('button', { name: 'Video selection' }))
  fireEvent.click(h.view.getByRole('button', { name: 'Shot 10' }))
  expect(h.instance.getSnapshot().seek?.time).toBe(0)
  expect(h.view.getByRole('button', { name: 'Shot 11' }).hasAttribute('disabled')).toBe(true)
  fireEvent.click(h.view.getByRole('button', { name: 'Add selected segment' }))
  expect(h.addTargetReference).toHaveBeenCalledWith(expect.objectContaining({ startSeconds: 0, endSeconds: 2 }),
    'Episode 2 · Shot 10 · 0.00–2.00 s · Video first', expect.anything())
  fireEvent.click(h.view.getByRole('button', { name: 'Whole video' }))
  fireEvent.click(h.view.getByRole('button', { name: 'Float video preview' }))
  expect(h.openResource).toHaveBeenCalledWith(videoWorkspaceAddress(sessionId), expect.objectContaining({ destination: 'float' }))
  act(() => { h.tabInfo.set({ ...h.tabInfo.getSnapshot(), panel: { ...h.tabInfo.getSnapshot().panel, isFloating: true } }) })
  fireEvent.click(h.view.getByRole('button', { name: 'Dock video preview' }))
  fireEvent.click(h.view.getByRole('button', { name: 'Video selection' }))
  fireEvent.change(h.view.getByRole('combobox', { name: 'Choose episode' }), { target: { value: 'unassigned' } })
  fireEvent.click(h.view.getByRole('button', { name: 'Switch video: Video unassigned' }))
  expect(h.instance.getSnapshot().selected).toBe('unassigned')
})

it('captures an authored thumbnail from the observed interval and keeps visual cuts available separately', async () => {
  const created = vi.spyOn(document, 'createElement')
  const drawImage = vi.fn<(image: CanvasImageSource, dx: number, dy: number, ...coordinates: number[]) => void>()
  const context: Pick<CanvasRenderingContext2D, 'drawImage'> = { drawImage }
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(context as CanvasRenderingContext2D)
  vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL').mockReturnValue('data:image/jpeg;base64,shot-frame')
  const item = { ...source(), production: { scriptId: 10, episodeNumber: 2, packageIndex: 3, shotNumbers: [10, 11],
    shotRanges: [{ shotNumber: 10, startSeconds: 1.25, endSeconds: 2.5 }] } }
  const h = setup([item])
  const video = h.view.getByLabelText(item.label)
  Object.defineProperty(video, 'duration', { value: 3.5 })
  fireEvent.loadedMetadata(video)
  expect(h.view.getByRole('slider', { name: 'Playback position' }).getAttribute('max')).toBe('3.5')
  const media: HTMLVideoElement[] = []
  for (const result of created.mock.results) if (result.value instanceof HTMLVideoElement) media.push(result.value)
  const capture = media.find(video => !video.isConnected)
  if (capture === undefined) throw Error('Missing authored thumbnail decoder')
  Object.defineProperties(capture, { videoWidth: { value: 720 }, videoHeight: { value: 1280 } })
  await act(async () => { fireEvent.loadedMetadata(capture) })
  expect(capture.currentTime).toBe(1.875)
  await act(async () => { fireEvent.seeked(capture) })
  expect(drawImage).toHaveBeenCalledWith(capture, 0, 437.5, 720, 405, 0, 0, 240, 135)
  expect(h.view.getByRole('button', { name: 'Shot 10' }).querySelector('img')?.getAttribute('src'))
    .toBe('data:image/jpeg;base64,shot-frame')
  expect(h.view.getByRole('button', { name: 'Shot 11' }).querySelector('img')).toBeNull()
  fireEvent.click(h.view.getByRole('button', { name: 'Shot 10' }))
  expect(h.view.getByText('Episode 2 · Shot 10 · 00:01.25–00:02.50').hasAttribute('data-muse-preview-scope')).toBe(true)
  expect(h.view.queryByRole('button', { name: /^Video segment 1/u })).toBeNull()
  fireEvent.click(h.view.getByText(en.timeline))
  await waitFor(() => { expect(h.view.getByRole('button', { name: /^Video segment 1/u })).toBeDefined() })
  expect(h.view.getByRole('button', { name: en.zoomIn })).toBeDefined()
})

it('submits a current-video review only with an empty draft and no attachments', async () => {
  const h = setup([source()], { draft: '' })
  await waitFor(() => { expect(h.detectShots).toHaveBeenCalledOnce() })
  fireEvent.click(h.view.getByRole('button', { name: 'Review selected videos' }))
  expect(h.setReviewMode).toHaveBeenCalledWith(true, expect.anything())
  expect(h.inputActions.insertText).toHaveBeenCalledWith(`\n\n${en.requestReview}`, expect.anything())
  expect(h.inputActions.submit).toHaveBeenCalledOnce()
  h.inputActions.submit.mockClear()
  act(() => { h.input.set({ ...h.input.getSnapshot(), draft: 'unfinished' }) })
  fireEvent.click(h.view.getByRole('button', { name: 'Review selected videos' }))
  expect(h.inputActions.submit).not.toHaveBeenCalled()
  h.addTargetReference.mockReturnValueOnce(false)
  fireEvent.click(h.view.getByRole('button', { name: 'Review selected videos' }))
  expect(h.view.getByRole('status').textContent).toContain(en.draftRefused)
  h.inputActions.insertText.mockReturnValueOnce(false)
  fireEvent.click(h.view.getByRole('button', { name: 'Review selected videos' }))
  expect(h.view.getByRole('status').textContent).toContain(en.draftRefused)
  h.setReviewMode.mockReturnValueOnce(false)
  const inserted = h.inputActions.insertText.mock.calls.length
  fireEvent.click(h.view.getByRole('button', { name: 'Review selected videos' }))
  expect(h.inputActions.insertText).toHaveBeenCalledTimes(inserted)
  expect(h.view.getByRole('status').textContent).toContain(en.draftRefused)
})

it('keeps one trailing review request when the action is repeated with retained references', () => {
  const item = source(), draft = `\ufffc Keep the pacing.\n\n${en.requestReview}\n`
  const h = setup([item], { draft, occurrences: [reference(item)] })
  fireEvent.click(h.view.getByRole('button', { name: 'Review selected videos' }))
  fireEvent.click(h.view.getByRole('button', { name: 'Review selected videos' }))
  expect(h.setReviewMode).toHaveBeenCalledTimes(2)
  expect(h.inputActions.insertText).not.toHaveBeenCalled()
  expect(h.inputActions.persistDraft).toHaveBeenCalledTimes(2)
  expect(h.inputActions.submit).not.toHaveBeenCalled()
  expect(h.input.getSnapshot().draft).toBe(draft)
})

it('opens the conversation attachment flow from an empty video workspace', () => {
  const h = setup([])
  fireEvent.click(h.view.getByRole('button', { name: 'Add video' }))
  expect(h.addVideoAttachment).toHaveBeenCalledOnce()
  expect(h.inputActions.submit).not.toHaveBeenCalled()
  expect(h.input.getSnapshot().draft).toBe('Keep the draft')
})

it('retains the empty workspace when its conversation refuses to open the attachment picker', () => {
  const h = setup([])
  h.addVideoAttachment.mockReturnValue(false)
  fireEvent.click(h.view.getByRole('button', { name: 'Add video' }))
  expect(h.view.getByText(en.draftRefused)).toBeDefined()
  expect(h.input.getSnapshot().draft).toBe('Keep the draft')
})

it('keeps reference context while browsing another episode and distinguishes preview from the draft', async () => {
  const first = { ...source(), production: { scriptId: 10, episodeNumber: 1 } }
  const second = { ...source('next'), production: { scriptId: 10, episodeNumber: 2 } }
  const retained = reference(first)
  const h = setup([first, second], { draft: '\ufffc unfinished', occurrences: [retained] })
  await waitFor(() => { expect(h.detectShots).toHaveBeenCalledOnce() })
  fireEvent.click(h.view.getByRole('button', { name: 'Video selection' }))
  expect(h.view.getByText(en.pickerHint)).toBeDefined()
  fireEvent.change(h.view.getByRole('combobox', { name: 'Choose episode' }), { target: { value: '2' } })
  expect(h.view.getByRole('button', { name: 'Switch video: Video next' }).getAttribute('aria-pressed')).toBe('true')
  expect(h.input.getSnapshot().occurrences).toEqual([retained])
  expect(h.removeTargetReference).not.toHaveBeenCalled()
  expect(h.addTargetReference).not.toHaveBeenCalled()
  expect(h.view.getAllByText('1 selected in chat')).toHaveLength(2)
})

it('compares observed same-shot versions at the same relative position and adopts only a local preference', async () => {
  const original = { ...source(), eventSeq: 10, production: { scriptId: 10, episodeNumber: 2, packageIndex: 1,
    shotNumbers: [7], shotRanges: [{ shotNumber: 7, startSeconds: 1, endSeconds: 3 }] } }
  const revised = { ...source('revised'), eventSeq: 20, production: { ...original.production,
    shotRanges: [{ shotNumber: 7, startSeconds: 4, endSeconds: 8 }] } }
  const retained = reference(original)
  const h = setup([original, revised], { draft: '\ufffc unfinished', occurrences: [retained] })
  await waitFor(() => { expect(h.instance.getSnapshot().analyses[original.id]).toBeDefined() })
  fireEvent.click(h.view.getByRole('button', { name: 'Shot 7' }))
  fireEvent.change(h.view.getByRole('slider', { name: 'Playback position' }), { target: { value: '1.5' } })
  expect(h.instance.getSnapshot().seek?.time).toBe(1.5)
  fireEvent.timeUpdate(h.view.getByLabelText(original.label), { target: { currentTime: 2 } })
  fireEvent.click(h.view.getByRole('button', { name: 'New V2' }))
  expect(h.instance.getSnapshot().seek).toMatchObject({ sourceId: revised.id, time: 6 })
  fireEvent.click(h.view.getByRole('button', { name: 'Original V1' }))
  expect(h.instance.getSnapshot().seek).toMatchObject({ sourceId: original.id, time: 2 })
  fireEvent.click(h.view.getByRole('button', { name: 'New V2' }))
  expect(h.instance.getSnapshot().seek).toMatchObject({ sourceId: revised.id, time: 6 })
  expect(h.view.getByRole('button', { name: 'New V2' }).getAttribute('aria-pressed')).toBe('true')
  expect(h.input.getSnapshot().occurrences).toEqual([retained])
  expect(h.addTargetReference).not.toHaveBeenCalled()
  fireEvent.click(h.view.getByRole('button', { name: 'Add selected segment' }))
  expect(h.addTargetReference).toHaveBeenCalledWith(expect.objectContaining({ sourceId: revised.id, startSeconds: 4, endSeconds: 8 }),
    'Episode 2 · Shot 7 · 4.00–8.00 s · Video revised · Version 2', expect.anything())
  const save = vi.spyOn(Storage.prototype, 'setItem').mockImplementationOnce(() => { throw Error('Storage denied') })
  fireEvent.click(h.view.getByRole('button', { name: 'Adopt new version' }))
  expect(h.view.getByText(en.adoptFailed)).toBeDefined()
  save.mockRestore()
  fireEvent.click(h.view.getByRole('button', { name: 'Adopt new version' }))
  expect(h.view.getByRole('button', { name: 'Adopted' }).hasAttribute('disabled')).toBe(true)
  expect(h.view.getByRole('button', { name: 'Adopted' }).getAttribute('title')).toBe(en.adoptionHint)
  fireEvent.click(h.view.getByRole('button', { name: 'Whole video' }))
  fireEvent.click(h.view.getByRole('button', { name: 'Video selection' }))
  fireEvent.click(h.view.getByRole('button', { name: 'Switch video: Video first' }))
  expect(h.instance.getSnapshot().selected).toBe(original.id)
  fireEvent.click(h.view.getByRole('button', { name: 'Shot 7' }))
  expect(h.instance.getSnapshot().selected).toBe(revised.id)
  fireEvent.click(h.view.getByRole('button', { name: 'Original V1' }))
  expect(h.instance.getSnapshot().seek).toMatchObject({ sourceId: original.id, time: 1 })
  expect(h.inputActions.submit).not.toHaveBeenCalled()
})

it('opens a returned comparison at the last aligned position or at the midpoint without a matching seek', async () => {
  const production = { scriptId: 10, episodeNumber: 2, packageIndex: 1,
    shotRanges: [{ shotNumber: 7, startSeconds: 1, endSeconds: 3 }] }
  const original = { ...source(), eventSeq: 10, production }
  const revised = { ...source('revised'), eventSeq: 20, production: { ...production,
    shotRanges: [{ shotNumber: 7, startSeconds: 4, endSeconds: 8 }] } }
  const from = authoredShots(original)[0], to = authoredShots(revised)[0]
  if (from === undefined || to === undefined) throw Error('Expected bound comparison intervals')
  const unrelated = source('unrelated')
  const h = setup([original, revised, unrelated])
  await waitFor(() => { expect(h.instance.getSnapshot().analyses[original.id]).toBeDefined() })
  const target = { kind: 'shot' as const, sourceId: revised.id, sourceVersion: 'v1', shotId: to.id,
    startSeconds: to.localStart, endSeconds: to.localEnd }
  const compare = { sessionId, target, compareVersions: true as const }
  navigateWorkspace(h, compare, 2)
  expect(h.instance.getSnapshot().seek?.time).toBe(6)
  for (const [index, time, expected] of [[3, 1, 6], [4, 3, 6], [5, 1.5, 5]] as const) {
    act(() => { h.instance.actions.selectShot({ sourceId: original.id, shotId: from.id, time }) })
    navigateWorkspace(h, compare, index)
    expect(h.instance.getSnapshot().seek?.time).toBe(expected)
  }
  fireEvent.timeUpdate(h.view.getByLabelText(revised.label), { target: { currentTime: 7 } })
  act(() => { h.instance.actions.seekTo({ sourceId: revised.id, time: 5.5 }) })
  fireEvent.click(h.view.getByRole('button', { name: 'Original V1' }))
  expect(h.instance.getSnapshot().seek?.time).toBe(1.75)
  act(() => { h.instance.actions.seekTo({ sourceId: unrelated.id, time: 2 }) })
  fireEvent.click(h.view.getByRole('button', { name: 'New V2' }))
  expect(h.instance.getSnapshot().seek).toMatchObject({ sourceId: revised.id, time: 4 })
  act(() => { h.instance.actions.selectShot({ sourceId: unrelated.id, shotId: from.id, time: 1.5 }) })
  navigateWorkspace(h, compare, 6)
  expect(h.instance.getSnapshot().seek?.time).toBe(6)
})

it('bounds a whole-video advice seek to the observed duration', async () => {
  const item = source(), observed = analysis(item), pending = Promise.withResolvers<SessionVideoAnalysis>()
  const h = setup([item], {}, { detectShots: vi.fn<VideoWorkspaceProps['detectShots']>().mockReturnValue(pending.promise) })
  const target = whole(item)
  navigateWorkspace(h, { sessionId, target, seekSeconds: 3.5 }, 2)
  expect(h.instance.getSnapshot().seek).toBeNull()
  await act(async () => { pending.resolve({ ...observed, durationSeconds: null }) })
  expect(h.view.getByText(en.navigationStale)).toBeDefined()
  act(() => { h.instance.actions.analysis(observed) })
  expect(h.instance.getSnapshot().seek).toMatchObject({ sourceId: item.id, time: 3.5 })
  navigateWorkspace(h, { sessionId, target, seekSeconds: 4 }, 3)
  expect(h.view.getByText(en.navigationStale)).toBeDefined()
  expect(h.instance.getSnapshot().seek?.time).toBe(3.5)
  expect(h.inputActions.submit).not.toHaveBeenCalled()
})

it('dismisses unprocessed annotation navigation when the user selects the whole source', async () => {
  const item = { ...source(), production: { scriptId: 10, episodeNumber: 2,
    shotRanges: [{ shotNumber: 7, startSeconds: 1, endSeconds: 3 }] } }
  const cut = authoredShots(item)[0]
  if (cut === undefined) throw Error('Expected bound annotation interval')
  const h = setup([item])
  await waitFor(() => { expect(h.instance.getSnapshot().analyses[item.id]?.state).toBe('ready') })
  act(() => { h.resource.set({ ...h.resource.getSnapshot(), status: 'loading' }) })
  navigateWorkspace(h, { sessionId, target: { kind: 'shot', sourceId: item.id, sourceVersion: 'v1', shotId: cut.id,
    startSeconds: cut.localStart, endSeconds: cut.localEnd }, seekSeconds: 1.5 }, 2)
  expect(h.instance.getSnapshot().selectedShot).toBeNull()
  fireEvent.click(h.view.getByRole('button', { name: 'Whole video' }))
  expect(h.instance.getSnapshot()).toMatchObject({ selectedEpisode: 2, selected: item.id, selectedShot: null })
  act(() => { h.resource.set({ ...h.resource.getSnapshot(), status: 'live' }) })
  expect(h.view.container.querySelector('[data-muse-preview-scope]')).toBeNull()
})

it('brings a published shot suggestion into the current draft once without sending it', async () => {
  const item = { ...source(), production: { scriptId: 10, episodeNumber: 2,
    shotRanges: [{ shotNumber: 7, startSeconds: 1, endSeconds: 3 }] } }
  const h = setup([item])
  await waitFor(() => { expect(h.instance.getSnapshot().analyses[item.id]).toBeDefined() })
  const observed = authoredShots(item)[0]
  if (observed === undefined) throw Error('Expected an observed fixture shot')
  const address = new URL(videoWorkspaceAddress(sessionId, { kind: 'shot', sourceId: item.id,
    sourceVersion: 'v1', shotId: observed.id, startSeconds: 1, endSeconds: 3 }))
  address.searchParams.set('suggestion', 'Keep the reaction for another beat.')
  const current = h.tabInfo.getSnapshot()
  act(() => { h.tabInfo.set({ ...current, tab: { ...current.tab, contentId: address.toString(),
    navigation: { address: address.toString(), params: undefined, revision: 2 } } }) })
  await waitFor(() => { expect(h.addTargetReference).toHaveBeenCalledOnce() })
  expect(h.setReviewMode).toHaveBeenCalledWith(false, expect.anything())
  expect(h.inputActions.insertText).toHaveBeenCalledWith('\nKeep the reaction for another beat.', expect.anything())
  expect(h.inputActions.submit).not.toHaveBeenCalled()
  expect(h.input.getSnapshot().draft).toBe('Keep the draft')
  act(() => { h.input.set({ ...h.input.getSnapshot(), draftRev: 2 }) })
  expect(h.addTargetReference).toHaveBeenCalledOnce()
})

it('brings a whole-video suggestion into the draft without assigning an unknown episode', async () => {
  const item = source('unassigned'), h = setup([source(), item])
  openSuggestion(h, videoWorkspaceAddress(sessionId, whole(item)))
  await waitFor(() => { expect(h.addTargetReference).toHaveBeenCalledOnce() })
  expect(h.instance.getSnapshot().selected).toBe(item.id)
  expect(h.instance.getSnapshot().selectedEpisode).toBe('unassigned')
  expect(h.view.getByText(en.draftReady)).toBeDefined()
  expect(h.inputActions.submit).not.toHaveBeenCalled()
})

it.each(['stale', 'foreign', 'busy'] as const)('reports a %s suggestion without changing the draft', async (failure) => {
  const item = source(), h = setup([item], failure === 'busy' ? { phase: 'sending' } : {})
  const owner = failure === 'foreign' ? brandString<SessionId>('different-session') : sessionId
  const target = failure === 'stale' ? { ...whole(item), sourceVersion: 'obsolete-bytes' } : whole(item)
  openSuggestion(h, videoWorkspaceAddress(owner, target))
  const expected = failure === 'foreign' ? en.suggestionInvalid : failure === 'stale' ? en.selectionStale : en.draftRefused
  await waitFor(() => { expect(h.view.getByText(expected)).toBeDefined() })
  expect(h.addTargetReference).not.toHaveBeenCalled()
  expect(h.inputActions.insertText).not.toHaveBeenCalled()
  expect(h.input.getSnapshot().draft).toBe('Keep the draft')
})

it.each(['resolve', 'reject'] as const)('waits for detected advice ranges to %s before preparing a suggestion', async (outcome) => {
  const item = source(), observed = analysis(item), shot = observed.shots[0]
  if (shot === undefined) throw Error('Expected a detected fixture interval')
  const pending = Promise.withResolvers<SessionVideoAnalysis>()
  const h = setup([item], {}, { detectShots: vi.fn<VideoWorkspaceProps['detectShots']>().mockReturnValue(pending.promise) })
  openSuggestion(h, videoWorkspaceAddress(sessionId, { kind: 'shot', sourceId: item.id, sourceVersion: 'v1',
    shotId: shot.id, startSeconds: shot.startSeconds, endSeconds: shot.endSeconds }))
  expect(h.addTargetReference).not.toHaveBeenCalled()
  await act(async () => {
    if (outcome === 'resolve') pending.resolve(observed)
    else pending.reject(Error('The source could not be inspected'))
  })
  if (outcome === 'resolve') expect(h.addTargetReference).toHaveBeenCalledOnce()
  else {
    expect(h.view.getByText(en.selectionStale)).toBeDefined()
    expect(h.addTargetReference).not.toHaveBeenCalled()
  }
  expect(h.inputActions.submit).not.toHaveBeenCalled()
})

it('keeps selected references in the composer and reports refused edits or stale media', async () => {
  const h = setup([source()], { draft: '\ufffc', occurrences: [reference()] })
  await waitFor(() => { expect(h.detectShots).toHaveBeenCalledOnce() })
  fireEvent.click(h.view.getByRole('button', { name: 'Prepare edit' }))
  expect(h.setReviewMode).toHaveBeenCalledWith(false, expect.anything())
  expect(h.inputActions.insertText).toHaveBeenCalledWith(expect.stringContaining(en.requestEdit), expect.anything())
  fireEvent.click(h.view.getByRole('button', { name: 'Review selected videos' }))
  expect(h.inputActions.submit).toHaveBeenCalledOnce()
  h.removeTargetReference.mockReturnValueOnce(false)
  fireEvent.click(h.view.getByRole('button', { name: 'Target remove: Video first' }))
  expect(h.view.getByRole('status').textContent).toContain(en.draftRefused)
  fireEvent.click(h.view.getByRole('button', { name: 'Target remove: Video first' }))
  h.removeTargetReference.mockReturnValueOnce(false)
  fireEvent.click(h.view.getByRole('button', { name: 'Clear selection' }))
  fireEvent.click(h.view.getByRole('button', { name: 'Clear selection' }))
  act(() => { h.resource.set({ status: 'live', failure: undefined, value: inventory([{ ...source(), version: 'changed' }]) }) })
  fireEvent.click(h.view.getByRole('button', { name: 'Prepare edit' }))
  expect(h.view.getByText(en.selectionStale)).toBeDefined()
})

it('counts only video targets and excludes the removable mode from an otherwise empty review draft', async () => {
  const mode: Occurrence = { occurrenceId: 2, source: VIDEO_REVIEW_REFERENCE_SOURCE, ref: VIDEO_REVIEW_REFERENCE,
    label: en.readOnlyReview, clipboardText: en.readOnlyReview, offset: 1, length: 1 }
  const h = setup([source()], { draft: '\ufffc\ufffc', occurrences: [reference(), mode] })
  expect(h.view.getByText('1 selected in chat')).toBeDefined()
  expect(h.view.queryByText('2 selected in chat')).toBeNull()
  fireEvent.click(h.view.getByRole('button', { name: 'Review selected videos' }))
  expect(h.inputActions.insertText).toHaveBeenCalledWith(`\n\n${en.requestReview}`, expect.anything())
  expect(h.inputActions.submit).toHaveBeenCalledOnce()
  fireEvent.click(h.view.getByRole('button', { name: 'Clear selection' }))
  expect(h.removeTargetReference).toHaveBeenCalledExactlyOnceWith(reference())
  h.setReviewMode.mockReturnValueOnce(false)
  fireEvent.click(h.view.getByRole('button', { name: 'Prepare edit' }))
  expect(h.setReviewMode).toHaveBeenLastCalledWith(false, expect.anything())
  expect(h.inputActions.insertText).toHaveBeenCalledOnce()
  expect(h.view.getByText(en.draftRefused)).toBeDefined()
})

it('exposes incomplete, unavailable, loading, empty and failed inventory states', () => {
  const h = setup([{ ...source(), playbackUrl: null, version: null }])
  expect(h.view.getByRole('alert').textContent).toContain(en.unavailable)
  fireEvent.click(h.view.getByRole('button', { name: 'Video selection' }))
  expect(h.view.getByRole('checkbox', { name: 'Select video: Video first' }).hasAttribute('disabled')).toBe(true)
  fireEvent.keyDown(h.view.getByRole('group', { name: 'Video selection' }), { key: 'Escape' })
  act(() => { h.resource.set({ status: 'loading', value: undefined, failure: undefined }) })
  expect(h.view.getByRole('status', { name: en.loading })).toBeDefined()
  act(() => { h.resource.set({ status: 'live', value: inventory([]), failure: undefined }) })
  expect(h.view.getByRole('status').textContent).toBe(en.empty)
  act(() => { h.resource.set({ status: 'live', value: { ...inventory([]), complete: false }, failure: undefined }) })
  expect(h.view.getAllByRole('status').some(node => node.textContent === en.incomplete)).toBe(true)
})

it('retries a failed detector and refreshes the inventory after downloading remote media', async () => {
  const item = { ...source(), status: 'remote-only' as const }
  const pending = Promise.withResolvers<SessionVideoAnalysis>()
  const detect = vi.fn<VideoWorkspaceProps['detectShots']>().mockReturnValueOnce(pending.promise).mockResolvedValue(analysis(item))
  const h = setup([item], {}, { detectShots: detect })
  expect(h.view.getByText(en.detecting)).toBeDefined()
  await act(async () => { pending.reject(Error('Download interrupted')) })
  expect(h.view.getByText(en.detectionFailed)).toBeDefined()
  fireEvent.click(h.view.getByRole('button', { name: 'Retry' }))
  await waitFor(() => { expect(h.refreshVideos).toHaveBeenCalledTimes(2) })
  expect(h.instance.getSnapshot().analyses[item.id]?.state).toBe('ready')
})

it.each(['resolve', 'reject'] as const)('discards detector %s after its tab is hidden', async (outcome) => {
  const pending = Promise.withResolvers<SessionVideoAnalysis>()
  const detect = vi.fn<VideoWorkspaceProps['detectShots']>().mockReturnValue(pending.promise)
  const h = setup([source()], {}, { detectShots: detect })
  const snapshot = h.tabInfo.getSnapshot()
  act(() => { h.tabInfo.set({ ...snapshot, tab: { ...snapshot.tab, visible: false } }) })
  await act(async () => {
    if (outcome === 'resolve') pending.resolve(analysis(source()))
    else pending.reject(Error('Cancelled download'))
  })
  expect(h.instance.getSnapshot().analyses).toEqual({})
  expect(h.refreshVideos).not.toHaveBeenCalled()
})

it('follows an exact advice range, reports stale and foreign links, and dismisses navigation on an explicit choice', async () => {
  const item = { ...source(), production: { scriptId: 10, episodeNumber: 2 } }
  const h = setup([item, source('next')])
  await waitFor(() => { expect(h.instance.getSnapshot().analyses[item.id]).toBeDefined() })
  const shot = analysis(item).shots[0]
  if (shot === undefined) throw Error('Missing detected interval')
  const navigate = (address: string, revision: number) => {
    const current = h.tabInfo.getSnapshot()
    act(() => { h.tabInfo.set({ ...current, tab: { ...current.tab, contentId: address,
      navigation: { address, params: undefined, revision } } }) })
  }
  const address = videoWorkspaceAddress(sessionId, { kind: 'shot', sourceId: item.id, sourceVersion: 'v1',
    shotId: shot.id, startSeconds: 0, endSeconds: 4 })
  navigate(address, 2)
  expect(h.instance.getSnapshot()).toMatchObject({ selected: item.id, selectedShot: shot.id })
  expect(h.view.getByText('Episode 2 · Video segment 1 · 00:00–00:04').hasAttribute('data-muse-preview-scope')).toBe(true)
  act(() => { h.resource.set({ ...h.resource.getSnapshot(), status: 'loading' }) })
  expect(h.view.queryByRole('status', { name: en.loading })).toBeNull()
  act(() => { h.resource.set({ ...h.resource.getSnapshot(), status: 'live' }) })
  fireEvent.click(h.view.getByRole('button', { name: 'Whole video' }))
  expect(h.instance.getSnapshot().selectedEpisode).toBe(2)
  act(() => { h.instance.actions.dismissNavigation('another-video-tab/1') })
  expect(h.view.container.querySelector('[data-muse-preview-scope]')).toBeNull()
  navigate(videoWorkspaceAddress(sessionId, { kind: 'shot', sourceId: item.id, sourceVersion: 'v1',
    shotId: shot.id, startSeconds: 0, endSeconds: 4.1 }), 3)
  expect(h.view.getByText(en.navigationStale)).toBeDefined()
  navigate(videoWorkspaceAddress(sessionId, { ...whole(item), sourceVersion: 'old' }), 4)
  expect(h.view.getByText(en.navigationStale)).toBeDefined()
  act(() => { h.resource.set({ ...h.resource.getSnapshot(), status: 'loading' }) })
  expect(h.view.getByRole('status', { name: en.loading })).toBeDefined()
  act(() => { h.resource.set({ ...h.resource.getSnapshot(), status: 'live' }) })
  navigate(videoWorkspaceAddress(sessionId, whole(source('next'))), 5)
  expect(h.instance.getSnapshot()).toMatchObject({ selected: 'next', selectedShot: null })
  expect(h.view.getByRole('combobox', { name: 'Choose episode' })).toHaveProperty('value', 'unassigned')
  expect(h.view.getByRole('button', { name: 'Video selection' }).textContent).toBe('Video next')
  navigate(videoWorkspaceAddress(brandString<SessionId>('foreign-session'), whole(item)), 6)
  expect(h.view.getByText(en.navigationForeign)).toBeDefined()
  navigate('invalid-video-address', 7)
  fireEvent.click(h.view.getByRole('button', { name: 'Float video preview' }))
  expect(h.openResource).toHaveBeenLastCalledWith(videoWorkspaceAddress(sessionId), expect.anything())
})

it('preserves unrelated references and attachments while sorting selected video ranges for a review draft', async () => {
  const first = { ...source(), production: { scriptId: 10, episodeNumber: 3 } }
  const second = { ...source('next'), production: { scriptId: 10, episodeNumber: 1 } }
  const refs = [reference(first), { ...reference(second), occurrenceId: 2, offset: 1 },
    { ...reference(), occurrenceId: 3, source: 'other-reference', offset: 2 },
    { ...reference(), occurrenceId: 4, ref: 'invalid-reference', offset: 3 }]
  const h = setup([first, second], { draft: '\ufffc\ufffc\ufffc\ufffc', occurrences: refs })
  await waitFor(() => { expect(h.instance.getSnapshot().analyses[first.id]).toBeDefined() })
  fireEvent.click(h.view.getByRole('button', { name: 'Review selected videos' }))
  expect(h.inputActions.submit).not.toHaveBeenCalled()
  fireEvent.click(h.view.getByRole('button', { name: 'Video selection' }))
  expect(h.view.getAllByRole('option').map(item => item.textContent)).toEqual(['All episodes', 'Episode 1', 'Episode 3', 'Unassigned'])
  act(() => { h.input.set({ ...h.input.getSnapshot(), draft: '', occurrences: [],
    attachmentIds: [brandString<DraftAttachmentId>('attached')] }) })
  fireEvent.keyDown(h.view.getByRole('group', { name: 'Video selection' }), { key: 'Escape' })
  fireEvent.click(h.view.getByRole('button', { name: 'Review selected videos' }))
  expect(h.inputActions.submit).not.toHaveBeenCalled()
})

it('routes timeline selections, seeks and playback retries through the retained workspace', async () => {
  const item = source(), ready = analysis(item), first = ready.shots[0]
  if (first === undefined) throw Error('Missing synthetic interval')
  const second = { ...first, id: brandString<typeof first.id>('second-cut'), index: 2, startSeconds: 2, endSeconds: 4 }
  const detect = vi.fn<VideoWorkspaceProps['detectShots']>().mockResolvedValue({ ...ready,
    shots: [{ ...first, endSeconds: 2 }, second] })
  const h = setup([item], {}, { detectShots: detect })
  await waitFor(() => { expect(h.instance.getSnapshot().analyses[item.id]).toBeDefined() })
  const segment = h.view.getByRole('button', { name: 'Video segment 2 · 2.00–4.00' })
  fireEvent.click(segment)
  expect(h.instance.getSnapshot().selectedShot).toBe(second.id)
  fireEvent.keyDown(h.view.getByRole('slider', { name: 'Playback position' }), { key: 'ArrowRight' })
  expect(h.instance.getSnapshot().seek?.time).toBeGreaterThanOrEqual(0)
  fireEvent.error(h.view.getByLabelText(item.label))
  fireEvent.click(h.view.getByRole('button', { name: 'Retry' }))
  expect(h.refreshVideos).toHaveBeenCalledOnce()
})

it('retries an explicit failed analysis and a failed inventory without removing conversation references', async () => {
  const item = source(), ready = analysis(item)
  const detect = vi.fn<VideoWorkspaceProps['detectShots']>().mockResolvedValueOnce({ ...ready, state: 'failed', shots: [] })
    .mockResolvedValue(ready)
  const h = setup([item], {}, { detectShots: detect })
  await waitFor(() => { expect(h.view.getByText(en.detectionFailed)).toBeDefined() })
  fireEvent.click(h.view.getByRole('button', { name: 'Retry' }))
  await waitFor(() => { expect(h.instance.getSnapshot().analyses[item.id]?.state).toBe('ready') })
  act(() => { h.resource.set({ ...h.resource.getSnapshot(), status: 'failed' }) })
  expect(h.view.getByText(en.inventoryFailed)).toBeDefined()
  fireEvent.click(h.view.getByRole('button', { name: 'Retry' }))
  expect(h.refreshVideos).toHaveBeenCalledTimes(2)
  act(() => { h.resource.set({ status: 'live', value: inventory([]), failure: undefined })
    h.input.set({ ...h.input.getSnapshot(), occurrences: [reference(item)] }) })
  fireEvent.click(h.view.getByRole('button', { name: 'Review selected videos' }))
  expect(h.view.getByText(en.selectionStale)).toBeDefined()
})

it('toggles whole-video references across episode filters and retains refused checkbox edits', async () => {
  const item = source(), h = setup([item], { occurrences: [reference(item)] })
  await waitFor(() => { expect(h.instance.getSnapshot().analyses[item.id]).toBeDefined() })
  expect(h.view.getByRole('button', { name: 'Add current video to chat' }).hasAttribute('disabled')).toBe(true)
  fireEvent.click(h.view.getByRole('button', { name: 'Video selection' }))
  h.removeTargetReference.mockReturnValueOnce(false)
  fireEvent.click(h.view.getByRole('checkbox', { name: 'Select video: Video first' }))
  expect(h.view.getByText(en.draftRefused)).toBeDefined()
  fireEvent.click(h.view.getByRole('checkbox', { name: 'Select video: Video first' }))
  act(() => { h.input.set({ ...h.input.getSnapshot(), occurrences: [] }) })
  fireEvent.click(h.view.getByRole('checkbox', { name: 'Select video: Video first' }))
  expect(h.addTargetReference).toHaveBeenCalledOnce()
  fireEvent.change(h.view.getByRole('combobox', { name: 'Choose episode' }), { target: { value: '99' } })
  expect(h.view.getAllByText(en.emptyEpisode)).toHaveLength(2)
  fireEvent.change(h.view.getByRole('combobox', { name: 'Choose episode' }), { target: { value: 'all' } })
  expect(h.view.getByRole('button', { name: 'Switch video: Video first' })).toBeDefined()
})
