// @vitest-environment jsdom
/** Inline players retain source identity, native controls, and bounded observation. */
import { act, cleanup, fireEvent, render, within } from '@testing-library/react'
import type { ComponentProps } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { SessionVideoSource, SessionVideoSourceId, SessionVideoShotId } from '@deepseek-ai/dsh-session-video'
import { DeliveredVideoCard, GeneratedVideoCards, InlineVideoCard } from '../src/client/InlineVideoCard.tsx'
import type { VideoState } from '../src/client/store.ts'
import { en } from '../src/client/locales.ts'

type Props = ComponentProps<typeof InlineVideoCard>
const source = (id: string, url: string | null): SessionVideoSource => ({
  id: brandString<SessionVideoSourceId>(id), label: id, origin: 'generated', path: `/work/${id}.mp4`, eventSeq: 4,
  presentedIndex: null, callId: null, status: 'local', version: 'v1', playbackUrl: url, remoteUrl: null, issue: null,
})
const first = source('first', '/video/first'), second = source('second', '/video/second')
let state: VideoState
let notifyVisibility: ((visible: boolean) => void)[]
let actions: Props['actions']
const input: Parameters<Parameters<Props['useInput']>[0]>[0] = {
  draft: 'existing', attachmentIds: [], draftRev: 7, phase: 'plain', occurrences: [], queue: [],
}
const insertText = vi.fn(() => true), persistDraft = vi.fn(), submit = vi.fn()
const loadVideo = vi.fn(), pauseVideo = vi.fn()
const inputActions: Props['inputActions'] = {
  insertQuote: vi.fn(), captureInsertion: vi.fn(() => ({ start: 0, end: 0, draftRev: 7 })), insertText,
  setDraft: vi.fn(), persistDraft, addAttachments: vi.fn(), removeAttachment: vi.fn(), pruneAttachments: vi.fn(), submit,
}
function shared(): Omit<Props, 'source' | 'sourceUrl' | 'label'> {
  return { useStore: selector => selector(state), actions, useInput: selector => selector(input), inputActions,
    pixelsPerSecond: 48, listVideos: vi.fn(), detectShots: vi.fn(), t: makeTranslate(en) }
}
function props(original: SessionVideoSource | undefined, sourceUrl = original?.playbackUrl ?? '/original'): Props {
  return { source: original, sourceUrl, label: original?.label ?? 'Original', ...shared() }
}
beforeEach(() => {
  vi.clearAllMocks()
  state = { sources: [first, second], analyses: {}, detectErrors: {}, open: false, selected: null,
    observed: {}, issue: null, inventoryRevision: 0 }
  actions = { inventory: vi.fn(), analysis: vi.fn(), detectionFailed: vi.fn(), retryFailed: vi.fn(), toggle: vi.fn(),
    openSource: vi.fn(), observe: vi.fn(), refreshInventory: vi.fn() }
  notifyVisibility = []
  vi.stubGlobal('IntersectionObserver', class implements IntersectionObserver {
    readonly root = null
    readonly rootMargin = '0px'
    readonly scrollMargin = '0px'
    readonly thresholds = [0]
    constructor(callback: IntersectionObserverCallback) {
      notifyVisibility.push((visible) => {
        callback([{ isIntersecting: visible } as IntersectionObserverEntry], this)
      })
    }
    observe() {}
    unobserve() {}
    takeRecords(): IntersectionObserverEntry[] { return [] }
    disconnect() {}
  })
  vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(loadVideo)
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(pauseVideo)
})
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals() })

it('keeps each original source and source selection independent', () => {
  const view = render(<><InlineVideoCard {...props(first)} /><InlineVideoCard {...props(second)} /></>)
  const cards = view.container.querySelectorAll<HTMLElement>('[data-muse-inline-video]')
  expect(cards).toHaveLength(2)
  expect(within(cards[0]!).getByLabelText('first').getAttribute('src')).toBe('/video/first')
  expect(within(cards[1]!).getByLabelText('second').getAttribute('src')).toBe('/video/second')
  fireEvent.change(within(cards[1]!).getByLabelText(en.library), { target: { value: first.id } })
  expect(within(cards[0]!).getByLabelText('first').getAttribute('src')).toBe('/video/first')
  expect(within(cards[1]!).getByLabelText('first').getAttribute('src')).toBe('/video/first')
})

it('retains the authorized delivery URL and native controls when the matched source cannot resolve a playback URL', () => {
  const missing = source('missing', null)
  state = { ...state, sources: [missing] }
  const view = render(<InlineVideoCard {...props(missing, '/authorized/delivery')} />)
  const video = view.getByLabelText('missing') as HTMLVideoElement
  expect(video.getAttribute('src')).toBe('/authorized/delivery')
  expect(video.controls).toBe(true)
})

it('keeps the original authorized player while the source inventory is unresolved', () => {
  const view = render(<InlineVideoCard {...props(undefined, '/authorized/delivery')} />)
  const video = view.getByLabelText('Original') as HTMLVideoElement
  expect(video.getAttribute('src')).toBe('/authorized/delivery')
  expect(video.controls).toBe(true)
})

it('does not request observation until visible and releases it when hidden or unmounted', () => {
  const view = render(<InlineVideoCard {...props(first)} />)
  expect(actions.observe).not.toHaveBeenCalled()
  act(() => { notifyVisibility[0]!(true) })
  expect(actions.observe).toHaveBeenLastCalledWith(first.id, 1)
  act(() => { notifyVisibility[0]!(false) })
  expect(actions.observe).toHaveBeenLastCalledWith(first.id, -1)
  act(() => { notifyVisibility[0]!(true) })
  view.unmount()
  expect(actions.observe).toHaveBeenLastCalledWith(first.id, -1)
})

it('keeps source selection available when a chosen video disappears from the inventory', () => {
  const input = props(first)
  const view = render(<InlineVideoCard {...input} />)
  fireEvent.change(view.getByLabelText(en.library), { target: { value: second.id } })
  state = { ...state, sources: [first] }
  view.rerender(<InlineVideoCard {...input} />)
  expect(view.getByRole('alert').textContent).toContain(en.unavailable)
  fireEvent.change(view.getByLabelText(en.library), { target: { value: first.id } })
  expect(view.getByLabelText('first').getAttribute('src')).toBe('/video/first')
})

it('retains native playback and offers retry when cut detection fails', () => {
  state = { ...state, detectErrors: { [first.id]: 'v1' } }
  const view = render(<InlineVideoCard {...props(first)} />)
  const video = view.getByLabelText('first') as HTMLVideoElement
  expect(video.controls).toBe(true)
  expect(view.getByRole('status').textContent).toContain(en.detectionFailed)
  fireEvent.click(view.getByRole('button', { name: en.retry }))
  expect(actions.retryFailed).toHaveBeenCalledOnce()
})

it('lets the viewer return to the authorized original when the entire inventory disappears', () => {
  const input = props(first, '/authorized/original')
  const view = render(<InlineVideoCard {...input} />)
  fireEvent.change(view.getByLabelText(en.library), { target: { value: second.id } })
  state = { ...state, sources: [] }
  view.rerender(<InlineVideoCard {...input} />)
  expect(view.getByRole('alert').textContent).toContain(en.unavailable)
  fireEvent.click(view.getByRole('button', { name: en.originalVideo }))
  expect(view.getByLabelText(first.label).getAttribute('src')).toBe('/authorized/original')
})

it('appends the selected source-local range to the existing revision-guarded draft', () => {
  state = { ...state, analyses: { [second.id]: { sourceId: second.id, sourceVersion: 'v1', state: 'ready',
    durationSeconds: 4, width: 320, height: 180, method: 'ffmpeg-scene', threshold: 0.3, issue: null, shots: [
      { id: brandString<SessionVideoShotId>('second-shot'), index: 1, startSeconds: 1, endSeconds: 3, thumbnail: null },
    ] } } }
  const view = render(<InlineVideoCard {...props(second)} />)
  fireEvent.click(view.getByRole('button', { name: /^Shot 1/u }))
  fireEvent.click(view.getByRole('button', { name: en.redo }))
  expect(insertText).toHaveBeenCalledWith(expect.stringContaining('/work/second.mp4'), { start: 8, end: 8, draftRev: 7 })
  expect(insertText).toHaveBeenCalledWith(expect.stringContaining('second-shot'), expect.anything())
  expect(insertText).toHaveBeenCalledWith(expect.stringContaining('1.000–3.000'), expect.anything())
  expect(persistDraft).toHaveBeenCalledOnce()
  expect(submit).not.toHaveBeenCalled()
  fireEvent.change(view.getByLabelText(en.library), { target: { value: first.id } })
  expect((view.getByRole('button', { name: en.redo }) as HTMLButtonElement).disabled).toBe(true)
})

it('does not persist a modification rejected by the draft revision guard', () => {
  state = { ...state, analyses: { [first.id]: { sourceId: first.id, sourceVersion: 'v1', state: 'ready',
    durationSeconds: 3, width: 320, height: 180, method: 'ffmpeg-scene', threshold: 0.3, issue: null, shots: [
      { id: brandString<SessionVideoShotId>('first-shot'), index: 1, startSeconds: 0, endSeconds: 3, thumbnail: null },
    ] } } }
  insertText.mockReturnValueOnce(false)
  const view = render(<InlineVideoCard {...props(first)} />)
  fireEvent.click(view.getByRole('button', { name: /^Shot 1/u }))
  fireEvent.click(view.getByRole('button', { name: en.redo }))
  expect(persistDraft).not.toHaveBeenCalled()
  expect(submit).not.toHaveBeenCalled()
})

it('keeps the same player and position when the original source appears in the inventory', () => {
  state = { ...state, sources: [] }
  const view = render(<InlineVideoCard {...props(undefined, '/authorized/original')} />)
  const original = view.getByLabelText('Original') as HTMLVideoElement
  original.currentTime = 1.25
  fireEvent.seeking(original)
  fireEvent.timeUpdate(original)
  pauseVideo.mockClear()
  loadVideo.mockClear()
  state = { ...state, sources: [first] }
  view.rerender(<InlineVideoCard {...props(first, '/authorized/original')} />)
  const matched = view.getByLabelText(first.label) as HTMLVideoElement
  expect(matched).toBe(original)
  expect(matched.currentTime).toBe(1.25)
  expect(matched.getAttribute('src')).toBe('/authorized/original')
  expect(pauseVideo).not.toHaveBeenCalled()
  expect(loadVideo).not.toHaveBeenCalled()
})

it('does not show stale cuts or enable modification when the source file version changes', () => {
  state = { ...state, analyses: { [first.id]: { sourceId: first.id, sourceVersion: 'v1', state: 'ready',
    durationSeconds: 3, width: 320, height: 180, method: 'ffmpeg-scene', threshold: 0.3, issue: null, shots: [
      { id: brandString<SessionVideoShotId>('v1-shot'), index: 1, startSeconds: 0, endSeconds: 3, thumbnail: null },
    ] } } }
  const view = render(<InlineVideoCard {...props(first, '/delivery/unversioned')} />)
  expect(view.getByLabelText('first').getAttribute('src')).toBe('/video/first')
  fireEvent.click(view.getByRole('button', { name: /^Shot 1/u }))
  const changed = { ...first, version: 'v2', playbackUrl: '/video/first?version=v2' }
  state = { ...state, sources: [changed, second] }
  view.rerender(<InlineVideoCard {...props(changed, '/delivery/unversioned')} />)
  expect(view.getByLabelText('first').getAttribute('src')).toBe('/video/first?version=v2')
  expect(view.queryByRole('button', { name: /^Shot 1/u })).toBeNull()
  expect((view.getByRole('button', { name: en.redo }) as HTMLButtonElement).disabled).toBe(true)
})

it('requires a deliberate switch before using cuts after unbound playback has started', () => {
  state = { ...state, sources: [] }
  const view = render(<InlineVideoCard {...props(undefined, '/delivery/unversioned')} />)
  const video = view.getByLabelText('Original') as HTMLVideoElement
  fireEvent.play(video)
  state = { ...state, sources: [first], analyses: { [first.id]: { sourceId: first.id, sourceVersion: 'v1', state: 'ready',
    durationSeconds: 3, width: 320, height: 180, method: 'ffmpeg-scene', threshold: 0.3, issue: null, shots: [
      { id: brandString<SessionVideoShotId>('v1-shot'), index: 1, startSeconds: 0, endSeconds: 3, thumbnail: null },
    ] } } }
  view.rerender(<InlineVideoCard {...props(first, '/delivery/unversioned')} />)
  expect(view.getByLabelText('first').getAttribute('src')).toBe('/delivery/unversioned')
  expect(view.queryByRole('button', { name: /^Shot 1/u })).toBeNull()
  expect((view.getByRole('button', { name: en.redo }) as HTMLButtonElement).disabled).toBe(true)
  fireEvent.click(view.getByRole('button', { name: en.bindVideo }))
  expect(view.getByLabelText('first').getAttribute('src')).toBe('/video/first')
  expect(view.getByRole('button', { name: /^Shot 1/u })).toBeTruthy()
})

it('keeps remote playback while refusing unbound cuts and offering an inventory retry', () => {
  const remote = { ...first, status: 'remote-only' as const, version: 'url:v1', playbackUrl: 'https://example.test/video.mp4' }
  state = { ...state, sources: [remote], analyses: { [remote.id]: { sourceId: remote.id, sourceVersion: 'url:v1', state: 'ready',
    durationSeconds: 3, width: 320, height: 180, method: 'ffmpeg-scene', threshold: 0.3, issue: null, shots: [
      { id: brandString<SessionVideoShotId>('remote-shot'), index: 1, startSeconds: 0, endSeconds: 3, thumbnail: null },
    ] } } }
  const view = render(<InlineVideoCard {...props(remote)} />)
  expect(view.getByLabelText('first').getAttribute('src')).toBe(remote.playbackUrl)
  expect(view.queryByRole('button', { name: /^Shot 1/u })).toBeNull()
  expect((view.getByRole('button', { name: en.redo }) as HTMLButtonElement).disabled).toBe(true)
  expect(view.getByRole('status').textContent).toContain(en.awaitBoundVideo)
  fireEvent.click(view.getByRole('button', { name: en.retry }))
  expect(actions.refreshInventory).toHaveBeenCalledOnce()
})

it('returns to the original delivery after an unbound selected source disappears', () => {
  const remote = { ...second, status: 'remote-only' as const, version: 'url:v1', playbackUrl: 'https://example.test/second.mp4' }
  state = { ...state, sources: [first, remote] }
  const input = props(first, '/authorized/original')
  const view = render(<InlineVideoCard {...input} />)
  fireEvent.change(view.getByLabelText(en.library), { target: { value: remote.id } })
  fireEvent.play(view.getByLabelText(remote.label))
  state = { ...state, sources: [] }
  view.rerender(<InlineVideoCard {...input} />)
  fireEvent.click(view.getByRole('button', { name: en.originalVideo }))
  expect(view.getByLabelText(first.label).getAttribute('src')).toBe('/authorized/original')
})

it('keeps ongoing remote playback when a generated source becomes locally version bound', () => {
  const remote = { ...first, status: 'remote-only' as const, version: 'url:v1', playbackUrl: 'https://example.test/first.mp4' }
  state = { ...state, sources: [remote] }
  const view = render(<InlineVideoCard {...props(remote)} />)
  const video = view.getByLabelText(remote.label) as HTMLVideoElement
  video.currentTime = 1.25
  fireEvent.play(video)
  pauseVideo.mockClear()
  loadVideo.mockClear()
  const local = { ...remote, status: 'local' as const, playbackUrl: '/video/first?version=url-v1' }
  state = { ...state, sources: [local] }
  view.rerender(<InlineVideoCard {...props(local)} />)
  const retained = view.getByLabelText(local.label) as HTMLVideoElement
  expect(retained).toBe(video)
  expect(retained.currentTime).toBe(1.25)
  expect(retained.getAttribute('src')).toBe(remote.playbackUrl)
  expect(pauseVideo).not.toHaveBeenCalled()
  expect(loadVideo).not.toHaveBeenCalled()
  fireEvent.click(view.getByRole('button', { name: en.bindVideo }))
  expect(retained.getAttribute('src')).toBe(local.playbackUrl)
})

it('blocks shot modification after a bound playback error and restores it only after media recovery', () => {
  state = { ...state, analyses: { [first.id]: { sourceId: first.id, sourceVersion: 'v1', state: 'ready',
    durationSeconds: 3, width: 320, height: 180, method: 'ffmpeg-scene', threshold: 0.3, issue: null, shots: [
      { id: brandString<SessionVideoShotId>('first-shot'), index: 1, startSeconds: 0, endSeconds: 3, thumbnail: null },
    ] } } }
  const view = render(<InlineVideoCard {...props(first)} />)
  fireEvent.click(view.getByRole('button', { name: /^Shot 1/u }))
  expect((view.getByRole('button', { name: en.redo }) as HTMLButtonElement).disabled).toBe(false)
  const video = view.getByLabelText('first') as HTMLVideoElement
  fireEvent.error(video)
  expect((view.getByRole('button', { name: en.redo }) as HTMLButtonElement).disabled).toBe(true)
  expect(view.queryByRole('button', { name: /^Shot 1/u })).toBeNull()
  fireEvent.click(within(view.getByRole('status')).getByRole('button', { name: en.retry }))
  expect(actions.refreshInventory).toHaveBeenCalledOnce()
  fireEvent.loadedMetadata(video)
  expect(view.getByRole('button', { name: /^Shot 1/u })).toBeTruthy()
  expect((view.getByRole('button', { name: en.redo }) as HTMLButtonElement).disabled).toBe(false)
})

const readyAnalysis = (target: SessionVideoSource, shots: [number, number][]) => ({ sourceId: target.id,
  sourceVersion: target.version ?? '', state: 'ready' as const, durationSeconds: 4, width: 320, height: 180,
  method: 'ffmpeg-scene' as const, threshold: 0.3, issue: null, shots: shots.map(([start, end], index) => ({
    id: brandString<SessionVideoShotId>(`${target.id}-shot-${index + 1}`), index: index + 1, startSeconds: start,
    endSeconds: end, thumbnail: null })) })

it('treats the card as visible and requests observation immediately when IntersectionObserver is unavailable', () => {
  vi.stubGlobal('IntersectionObserver', undefined)
  const view = render(<InlineVideoCard {...props(first)} />)
  expect(actions.observe).toHaveBeenCalledWith(first.id, 1)
  expect(view.getByRole('status').textContent).toContain(en.detecting)
})

it('selects the owning source and its cut when the viewer picks a shot from another source', () => {
  state = { ...state, analyses: { [second.id]: readyAnalysis(second, [[0, 2]]) } }
  const view = render(<InlineVideoCard {...props(first)} />)
  fireEvent.click(view.getByRole('button', { name: /^Shot 1/u }))
  expect((view.getByLabelText(en.library) as HTMLSelectElement).value).toBe(second.id)
  expect(view.getByLabelText('second').getAttribute('src')).toBe('/video/second')
  expect((view.getByRole('button', { name: en.redo }) as HTMLButtonElement).disabled).toBe(false)
})

it('moves to the last shot on End and ignores a seek to a gap before the first shot', () => {
  state = { ...state, sources: [first, second], analyses: {
    [first.id]: readyAnalysis(first, [[1, 3]]), [second.id]: readyAnalysis(second, [[0, 2]]) } }
  const view = render(<InlineVideoCard {...props(first)} />)
  const slider = view.getByRole('slider', { name: en.playhead })
  fireEvent.keyDown(slider, { key: 'Home' })
  expect(view.getAllByRole('button', { name: /^Shot \d/u }).every(button => button.getAttribute('aria-pressed') === 'false')).toBe(true)
  expect((view.getByLabelText(en.library) as HTMLSelectElement).value).toBe(first.id)
  fireEvent.keyDown(slider, { key: 'End' })
  expect((view.getByLabelText(en.library) as HTMLSelectElement).value).toBe(second.id)
  expect(view.getByRole('button', { name: /^Shot 2/u }).getAttribute('aria-pressed')).toBe('true')
})

it('names the redo range by source id when the source has no file path', () => {
  const unnamed = { ...first, path: null }
  state = { ...state, sources: [unnamed], analyses: { [unnamed.id]: readyAnalysis(unnamed, [[0, 3]]) } }
  const view = render(<InlineVideoCard {...props(unnamed)} />)
  fireEvent.click(view.getByRole('button', { name: /^Shot 1/u }))
  fireEvent.click(view.getByRole('button', { name: en.redo }))
  const prompt = makeTranslate(en)('redoPrompt', { name: unnamed.label, source: unnamed.id, id: `${unnamed.id}-shot-1`,
    start: '0.000', end: '3.000' })
  expect(insertText).toHaveBeenCalledWith(`\n\n${prompt}`, { start: 8, end: 8, draftRev: 7 })
})

it('keeps a bound source bound when the viewer interacts with its player', () => {
  state = { ...state, analyses: { [first.id]: readyAnalysis(first, [[0, 3]]) } }
  const view = render(<InlineVideoCard {...props(first)} />)
  fireEvent.play(view.getByLabelText('first'))
  expect(view.queryByRole('button', { name: en.bindVideo })).toBeNull()
  expect(view.getByRole('button', { name: /^Shot 1/u })).toBeTruthy()
})

const deliveredProps = (seq: number, index: number) => ({ ...shared(), sourceUrl: '/authorized/delivery',
  label: 'Delivered', path: '/work/out.mp4', seq, index }) as ComponentProps<typeof DeliveredVideoCard>

it('binds a delivered video card to the presented source declared at its event and index', () => {
  const presented = { ...first, origin: 'presented' as const, eventSeq: 5, presentedIndex: 1 }
  state = { ...state, sources: [second, presented] }
  const view = render(<DeliveredVideoCard {...deliveredProps(5, 1)} />)
  expect((view.getByLabelText(en.library) as HTMLSelectElement).value).toBe(presented.id)
  expect(view.getByLabelText('first').getAttribute('src')).toBe('/video/first')
})

const generated = (id: string, overrides: Partial<SessionVideoSource>): SessionVideoSource =>
  ({ ...source(id, `/video/${id}`), ...overrides })
const tailProps = (turn: { start?: number; end?: number }, seq: number) => ({ ...shared(), seq,
  turn: { start: turn.start === undefined ? undefined : { seq: turn.start },
    end: turn.end === undefined ? undefined : { seq: turn.end } } }) as ComponentProps<typeof GeneratedVideoCards>

it('lists only generated, unpresented, playable videos recorded inside the closing Turn', () => {
  const presented = generated('presented', { origin: 'presented', presentedIndex: 0, path: '/work/shared.mp4', eventSeq: 4 })
  state = { ...state, sources: [
    generated('kept', { eventSeq: 4 }),
    generated('before', { eventSeq: 1 }),
    generated('after', { eventSeq: 9 }),
    generated('workspace', { origin: 'workspace' }),
    generated('delivered', { presentedIndex: 2, path: '/work/delivered.mp4' }),
    generated('unplayable', { playbackUrl: null }),
    generated('duplicate', { path: '/work/shared.mp4' }),
    presented,
  ] }
  const view = render(<GeneratedVideoCards {...tailProps({ start: 3, end: 6 }, 6)} />)
  expect(view.container.querySelectorAll('[data-muse-inline-video]')).toHaveLength(1)
  expect(view.getByLabelText('kept').getAttribute('src')).toBe('/video/kept')
})

it('uses the tail event as the Turn end while the Turn is still open', () => {
  state = { ...state, sources: [generated('open', { eventSeq: 8 }), generated('later', { eventSeq: 12 })] }
  const view = render(<GeneratedVideoCards {...tailProps({ start: 3 }, 10)} />)
  expect(view.getByLabelText('open')).toBeTruthy()
  expect(view.queryByLabelText('later')).toBeNull()
})

it('renders nothing for a Turn without a recorded start', () => {
  state = { ...state, sources: [generated('orphan', { eventSeq: 4 })] }
  const view = render(<GeneratedVideoCards {...tailProps({}, 6)} />)
  expect(view.container.querySelector('[data-muse-inline-video]')).toBeNull()
})
