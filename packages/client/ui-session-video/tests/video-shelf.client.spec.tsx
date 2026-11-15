// @vitest-environment jsdom
/** The shelf owns one Session's real media, detection requests and source-local redo ranges. */
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { bindSnapshotSelector, makeTranslate, sessionSnapshot } from '@deepseek-ai/dsh-client-test-runtime'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { SessionId } from '@deepseek-ai/dsh-session'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { SessionVideoSource, SessionVideoSourceId, SessionVideoShotId, SessionVideoAnalysis, SessionVideoInventory } from '@deepseek-ai/dsh-session-video'
import type { VideoPlayerProps } from '../src/client/VideoPlayer.tsx'
import { VideoShelf, VideoShelfSpacer } from '../src/client/VideoShelf.tsx'
import { createVideoStore } from '../src/client/store.ts'
import { en } from '../src/client/locales.ts'

const sessionId = SessionId('video-shelf-session')
type ShelfProps = Parameters<typeof VideoShelf>[0]
const observed = vi.hoisted(() => ({ player: undefined as VideoPlayerProps | undefined, redo: undefined as (() => void) | undefined }))
vi.mock('../src/client/VideoPlayer.tsx', async (original) => {
  const actual = await original<typeof import('../src/client/VideoPlayer.tsx')>()
  return { ...actual, VideoPlayer: (props: VideoPlayerProps) => {
    observed.player = props
    return <actual.VideoPlayer {...props} />
  } }
})
vi.mock('@deepseek-ai/dsh-client-ui-primitives', async (original) => {
  const actual = await original<typeof import('@deepseek-ai/dsh-client-ui-primitives')>()
  return { ...actual, Button: (props: React.ComponentProps<typeof actual.Button>) => {
    if (props.size === 'sm' && props.disabled !== undefined && props['aria-label'] === undefined && props.onClick !== undefined) {
      observed.redo = () => { Reflect.apply(props.onClick!, undefined, []) }
    }
    return <actual.Button {...props} />
  } }
})
let getAnimationsDescriptor: PropertyDescriptor | undefined
beforeEach(() => {
  observed.player = undefined; observed.redo = undefined
  getAnimationsDescriptor = Object.getOwnPropertyDescriptor(Element.prototype, 'getAnimations')
  Object.defineProperty(Element.prototype, 'getAnimations', { configurable: true, value: () => [] })
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {})
  vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(() => {})
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue()
})
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  if (getAnimationsDescriptor === undefined) Reflect.deleteProperty(Element.prototype, 'getAnimations')
  else Object.defineProperty(Element.prototype, 'getAnimations', getAnimationsDescriptor)
})

function source(id: string, overrides: Partial<SessionVideoSource> = {}): SessionVideoSource {
  return { id: brandString<SessionVideoSourceId>(id), label: `${id} video`, origin: 'generated', path: `/work/${id}.mp4`,
    eventSeq: 5, presentedIndex: null, callId: null, status: 'local', version: 'v1',
    playbackUrl: `/api/video/${id}`, remoteUrl: null, issue: null, ...overrides }
}
function analysis(video: SessionVideoSource, state: 'ready' | 'failed' = 'ready'): SessionVideoAnalysis {
  return { sourceId: video.id, sourceVersion: 'v1', state, durationSeconds: 4, width: 320, height: 180,
    method: 'ffmpeg-scene', threshold: 0.3, issue: state === 'failed' ? 'unavailable' : null,
    shots: state === 'failed' ? [] : [{ id: brandString<SessionVideoShotId>(`${video.id}-shot`), index: 1,
      startSeconds: 0, endSeconds: 4, thumbnail: null }] }
}
function setup(sources: SessionVideoSource[] = []) {
  const store = createVideoStore().create(sessionId)
  const inventory = (items = sources, issues: string[] = []): SessionVideoInventory => ({
    sessionId, sources: items, complete: issues.length === 0, issues,
  })
  store.actions.inventory(inventory())
  const session = createSnapshotStore(sessionSnapshot(sessionId))
  const chat = createSnapshotStore({ order: [] as string[] })
  const input = createSnapshotStore({ draft: 'My notes', draftRev: 7 })
  const inputActions = { insertText: vi.fn(() => true), persistDraft: vi.fn() }
  const listVideos = vi.fn<ShelfProps['listVideos']>(async () => inventory())
  const detectShots = vi.fn<ShelfProps['detectShots']>(async (_id, id) => analysis(sources.find(item => item.id === id)!))
  // This component consumes only these declared hooks; unrelated Session slots are absent.
  const props = { activeView: 'chat', sessionId, useStore: bindSnapshotSelector(store), actions: store.actions,
    useSession: bindSnapshotSelector(session), useChat: bindSnapshotSelector(chat), useInput: bindSnapshotSelector(input),
    inputActions, listVideos, detectShots, pixelsPerSecond: 48, t: makeTranslate(en) } as ShelfProps
  return { store, inventory, session, chat, inputActions, listVideos, detectShots, props }
}

it('keeps the pinned spacer and makes no requests outside the Chat view', () => {
  const h = setup()
  const view = render(<><VideoShelfSpacer /><VideoShelf {...h.props} activeView="trajectory" /></>)
  expect(view.container.querySelector('[data-muse-video-spacer]')?.getAttribute('aria-hidden')).toBe('true')
  expect(view.queryByRole('button')).toBeNull()
  expect(h.listVideos).not.toHaveBeenCalled()
})

it('loads an empty shelf on demand and cancels an obsolete inventory request', async () => {
  const h = setup(), pending = Promise.withResolvers<SessionVideoInventory>()
  h.listVideos.mockImplementationOnce(() => pending.promise)
  const view = render(<VideoShelf {...h.props} />)
  fireEvent.click(view.getByRole('button', { name: en.library }))
  expect(view.getByText(en.empty)).toBeTruthy()
  const signal = h.listVideos.mock.calls[0]![1]
  view.unmount()
  expect(signal.aborted).toBe(true)
  await act(async () => { pending.resolve(h.inventory([source('late')])) })
  expect(h.store.getSnapshot().sources).toEqual([])
})

it('ignores inventory failure reported after the shelf has unmounted', async () => {
  const h = setup(), pending = Promise.withResolvers<SessionVideoInventory>()
  h.listVideos.mockImplementationOnce(() => pending.promise)
  const view = render(<VideoShelf {...h.props} />)
  view.unmount()
  await act(async () => { pending.reject(new Error('request aborted')) })
  expect(h.store.getSnapshot().issue).toBeNull()
})

it('ignores detection rejection after closing', async () => {
  const video = source('first'), h = setup([video]), pending = Promise.withResolvers<SessionVideoAnalysis>()
  h.detectShots.mockImplementationOnce(() => pending.promise)
  const view = render(<VideoShelf {...h.props} />)
  fireEvent.click(view.getByRole('button', { name: en.library }))
  expect(h.store.getSnapshot().selected).toBe(video.id)
  fireEvent.click(view.getByRole('button', { name: en.library }))
  await act(async () => { pending.reject(new Error('request aborted')) })
  expect(view.queryByText(en.detectionFailed)).toBeNull()
})

it('keeps collection and explicit open actions within their own Session store', () => {
  const first = createVideoStore().create('first'), second = createVideoStore().create('second')
  first.actions.collect('video-1', true)
  first.actions.openSource('video-1')
  expect(first.getSnapshot()).toMatchObject({ selected: 'video-1', open: true, collected: { 'video-1': true } })
  first.actions.collect('video-1', false)
  expect(first.getSnapshot().collected['video-1']).toBe(false)
  expect(second.getSnapshot()).toMatchObject({ selected: null, open: false, collected: {} })
})

it('retries a failed inventory and keeps partial inventory visible', async () => {
  const h = setup()
  h.listVideos.mockRejectedValueOnce(new Error('unavailable')).mockResolvedValueOnce(h.inventory([], ['one source unreadable']))
  const view = render(<VideoShelf {...h.props} />)
  fireEvent.click(view.getByRole('button', { name: en.library }))
  await waitFor(() => { expect(view.getAllByText(en.unavailable)).toHaveLength(2) })
  fireEvent.click(view.getByRole('button', { name: en.retry }))
  await waitFor(() => { expect(view.getByText(en.incomplete)).toBeTruthy() })
  expect(h.listVideos).toHaveBeenCalledTimes(2)
})

it('selects real shots and seeks source-local time before inserting a redo request', async () => {
  const first = source('first'), second = source('second', { path: null })
  const h = setup([first, second])
  h.store.actions.analysis(analysis(first)); h.store.actions.analysis(analysis(second))
  const view = render(<VideoShelf {...h.props} />)
  fireEvent.click(view.getByRole('button', { name: en.library }))
  await waitFor(() => { expect(h.listVideos).toHaveBeenCalledOnce() })
  expect((view.getByRole('button', { name: en.redo }) as HTMLButtonElement).disabled).toBe(true)
  fireEvent.click(view.getByRole('button', { name: /^Shot 2/u }))
  expect(h.store.getSnapshot().selected).toBe(second.id)
  const video = view.getByLabelText(second.label) as HTMLVideoElement
  Object.defineProperty(video, 'readyState', { configurable: true, value: 1 })
  fireEvent.loadedMetadata(video)
  expect(video.currentTime).toBe(0)
  fireEvent.keyDown(view.getByRole('slider', { name: en.playhead }), { key: 'End' })
  expect(video.currentTime).toBe(4)
  fireEvent.click(view.getByRole('button', { name: en.redo }))
  expect(h.inputActions.insertText).toHaveBeenLastCalledWith(expect.stringContaining('Source: second; shot ID: second-shot; original range: 0.000–4.000'),
    { start: 8, end: 8, draftRev: 7 })
  expect(h.inputActions.persistDraft).toHaveBeenCalledOnce()
  h.inputActions.insertText.mockReturnValue(false)
  fireEvent.click(view.getByRole('button', { name: en.redo }))
  expect(h.inputActions.persistDraft).toHaveBeenCalledOnce()
  fireEvent.change(view.getByRole('combobox', { name: en.library }), { target: { value: first.id } })
  expect(h.store.getSnapshot().selected).toBe(first.id)
  expect((view.getByRole('button', { name: en.redo }) as HTMLButtonElement).disabled).toBe(true)
  expect(h.detectShots).not.toHaveBeenCalled()
})

it('ignores unavailable shot callbacks without changing selection or the draft', async () => {
  const video = source('first'), h = setup([video])
  h.store.actions.analysis(analysis(video))
  const view = render(<VideoShelf {...h.props} />)
  fireEvent.click(view.getByRole('button', { name: en.library }))
  await waitFor(() => { expect(h.listVideos).toHaveBeenCalledOnce() })
  expect(observed.player).toBeDefined()
  expect(observed.redo).toBeDefined()
  // Observe the real child interface without replacing its rendering or event behavior.
  act(() => {
    observed.player!.onSelectShot('removed-shot')
    observed.player!.onSeek(-1)
    observed.redo!()
  })
  expect(h.store.getSnapshot().selected).toBe(video.id)
  expect(h.inputActions.insertText).not.toHaveBeenCalled()
  expect(h.inputActions.persistDraft).not.toHaveBeenCalled()
})

it('detects open playable sources and refreshes remote inventory before accepting the analysis', async () => {
  const remote = source('remote', { status: 'remote-only', path: null })
  const local = { ...remote, status: 'local' as const, path: '/work/remote.mp4' }
  const h = setup([remote])
  h.listVideos.mockResolvedValueOnce(h.inventory()).mockResolvedValueOnce(h.inventory([local]))
  const view = render(<VideoShelf {...h.props} />)
  fireEvent.click(view.getByRole('button', { name: en.library }))
  await waitFor(() => { expect(h.store.getSnapshot().analyses[remote.id]?.state).toBe('ready') })
  expect(h.listVideos).toHaveBeenCalledTimes(2)
  expect(h.store.getSnapshot().sources[0]?.path).toBe('/work/remote.mp4')
  expect(h.detectShots).toHaveBeenCalledExactlyOnceWith(sessionId, remote.id, 'v1', expect.any(AbortSignal))
})

it('retains a provider playback URL when the optional post-detection inventory refresh fails', async () => {
  const remote = source('remote', { status: 'remote-only', path: null })
  const h = setup([remote])
  h.listVideos.mockResolvedValueOnce(h.inventory()).mockRejectedValueOnce(new Error('refresh failed'))
  const view = render(<VideoShelf {...h.props} />)
  fireEvent.click(view.getByRole('button', { name: en.library }))
  await waitFor(() => { expect(h.store.getSnapshot().analyses[remote.id]?.state).toBe('ready') })
  expect((view.getByLabelText(remote.label) as HTMLVideoElement).getAttribute('src')).toBe('/api/video/remote')
})

it('shows detection failures, retries them and ignores a result arriving after close', async () => {
  const video = source('first'), h = setup([video])
  h.detectShots.mockRejectedValueOnce(new Error('detector failed'))
  const pending = Promise.withResolvers<SessionVideoAnalysis>()
  h.detectShots.mockImplementationOnce(() => pending.promise)
  const view = render(<VideoShelf {...h.props} />)
  fireEvent.click(view.getByRole('button', { name: en.library }))
  await waitFor(() => { expect(view.getByText(en.detectionFailed)).toBeTruthy() })
  fireEvent.click(view.getByRole('button', { name: en.retry }))
  await waitFor(() => { expect(h.detectShots).toHaveBeenCalledTimes(2) })
  const signal = h.detectShots.mock.calls[1]![3]
  fireEvent.click(view.getByRole('button', { name: en.library }))
  expect(signal.aborted).toBe(true)
  await act(async () => { pending.resolve(analysis(video)) })
  expect(h.store.getSnapshot().analyses[video.id]).toBeUndefined()
})

it('shows missing playback without starting detection and can retry a failed recorded analysis', async () => {
  const missing = source('missing', { playbackUrl: null, version: null })
  const playable = source('playable')
  const h = setup([missing, playable])
  h.store.actions.analysis(analysis(playable, 'failed'))
  const view = render(<VideoShelf {...h.props} />)
  fireEvent.click(view.getByRole('button', { name: en.library }))
  await waitFor(() => { expect(h.listVideos).toHaveBeenCalledOnce() })
  expect(view.getByRole('alert').textContent).toBe(en.unavailable)
  fireEvent.change(view.getByRole('combobox', { name: en.library }), { target: { value: playable.id } })
  expect(view.getByText(en.detectionFailed)).toBeTruthy()
  fireEvent.click(view.getByRole('button', { name: en.retry }))
  await waitFor(() => { expect(h.store.getSnapshot().analyses[playable.id]?.state).toBe('ready') })
})
