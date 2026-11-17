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
import { VIDEO_REFERENCE_SOURCE } from '../src/client/references.ts'
import { videoWorkspaceAddress } from '../src/client/target-selection.ts'
import { analysis } from './video-fixture.tsx'
import { inventory, sessionId, source, whole } from './selection-fixture.client.ts'

afterEach(() => { cleanup(); vi.restoreAllMocks() })
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
  const addTargetReference = vi.fn(() => true), removeTargetReference = vi.fn(() => true), refreshVideos = vi.fn()
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
    detectShots, addTargetReference, removeTargetReference, refreshVideos,
    openWorkspace: vi.fn(), pixelsPerSecond: 48, t: makeTranslate(en),
    ...overrides,
  }
  const view = render(<VideoWorkspace {...props} />)
  return { view, instance, input, resource, tabInfo, props, inputActions, detectShots, openResource,
    addTargetReference, removeTargetReference, refreshVideos }
}

function reference(item = source()): Occurrence {
  return { occurrenceId: 1, source: VIDEO_REFERENCE_SOURCE, ref: videoWorkspaceAddress(sessionId, whole(item)),
    label: item.label, clipboardText: item.label, offset: 0, length: 1 }
}

it('browses episodes, selects an observed authored shot, and preserves its navigation when floating', async () => {
  const item = { ...source(), production: { scriptId: 10, episodeNumber: 2, packageIndex: 3, shotNumbers: [10, 11],
    shotRanges: [{ shotNumber: 10, startSeconds: 0, endSeconds: 2 }] } }
  const h = setup([item, source('unassigned')])
  await waitFor(() => { expect(h.instance.getSnapshot().analyses[item.id]).toBeDefined() })
  fireEvent.click(h.view.getByRole('button', { name: 'Video selection' }))
  fireEvent.change(h.view.getByRole('combobox', { name: 'Choose episode' }), { target: { value: '2' } })
  fireEvent.keyDown(h.view.getByRole('group', { name: 'Video selection' }), { key: 'a' })
  fireEvent.keyDown(h.view.getByRole('group', { name: 'Video selection' }), { key: 'Escape' })
  fireEvent.click(h.view.getByRole('button', { name: 'Shot 10' }))
  expect(h.instance.getSnapshot().seek?.time).toBe(0)
  expect(h.view.getByRole('button', { name: 'Shot 11' }).hasAttribute('disabled')).toBe(true)
  fireEvent.click(h.view.getByRole('button', { name: 'Add selected segment' }))
  expect(h.addTargetReference).toHaveBeenCalledWith(expect.objectContaining({ startSeconds: 0, endSeconds: 2 }),
    expect.any(String), expect.anything())
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

it('submits a current-video review only with an empty draft and no attachments', async () => {
  const h = setup([source()], { draft: '' })
  await waitFor(() => { expect(h.detectShots).toHaveBeenCalledOnce() })
  fireEvent.click(h.view.getByRole('button', { name: 'Review selected videos' }))
  expect(h.inputActions.insertText).toHaveBeenCalledWith(expect.stringContaining('muse-video-review'), expect.anything())
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
})

it('keeps selected references in the composer and reports refused edits or stale media', async () => {
  const h = setup([source()], { draft: '\ufffc', occurrences: [reference()] })
  await waitFor(() => { expect(h.detectShots).toHaveBeenCalledOnce() })
  fireEvent.click(h.view.getByRole('button', { name: 'Prepare edit' }))
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
  expect(h.view.getByText('Video segment 1 · 0.00–4.00')).toBeDefined()
  act(() => { h.resource.set({ ...h.resource.getSnapshot(), status: 'loading' }) })
  expect(h.view.queryByRole('status', { name: en.loading })).toBeNull()
  act(() => { h.resource.set({ ...h.resource.getSnapshot(), status: 'live' }) })
  fireEvent.click(h.view.getByRole('button', { name: 'Whole video' }))
  expect(h.instance.getSnapshot().selectedEpisode).toBe(2)
  navigate(videoWorkspaceAddress(sessionId, { kind: 'shot', sourceId: item.id, sourceVersion: 'v1',
    shotId: shot.id, startSeconds: 0, endSeconds: 4.1 }), 3)
  expect(h.view.getByText(en.navigationStale)).toBeDefined()
  navigate(videoWorkspaceAddress(sessionId, { ...whole(item), sourceVersion: 'old' }), 4)
  expect(h.view.getByText(en.navigationStale)).toBeDefined()
  act(() => { h.resource.set({ ...h.resource.getSnapshot(), status: 'loading' }) })
  expect(h.view.getByRole('status', { name: en.loading })).toBeDefined()
  act(() => { h.resource.set({ ...h.resource.getSnapshot(), status: 'live' }) })
  navigate(videoWorkspaceAddress(sessionId, whole(source('next'))), 5)
  expect(h.view.getByRole('button', { name: 'Video selection' }).textContent).toContain('Unassigned')
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
