// @vitest-environment jsdom
/** Real inline media and its Session-scoped inventory retain playback and delivery identity. */
import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { bindSnapshotSelector, makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { brandString } from '@deepseek-ai/dsh-brand'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { SessionVideoSource, SessionVideoSourceId } from '@deepseek-ai/dsh-session-video'
import { DeliveredVideoCard, GeneratedVideoCards, InlineVideoCard } from '../src/client/InlineVideoCard.tsx'
import { createVideoStore } from '../src/client/store.ts'
import { en } from '../src/client/locales.ts'

let top = 240, nextFrame = 0, paused = 0
const frames = new Map<number, FrameRequestCallback>()
const context = {
  setTransform: vi.fn(), save: vi.fn(), restore: vi.fn(), beginPath: vi.fn(), moveTo: vi.fn(),
  bezierCurveTo: vi.fn(), lineTo: vi.fn(), closePath: vi.fn(), fill: vi.fn(), rect: vi.fn(),
  roundRect: vi.fn(), clip: vi.fn(), globalAlpha: 1, fillStyle: '',
}
beforeEach(() => {
  top = 240; nextFrame = 0; paused = 0; frames.clear()
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { frames.set(++nextFrame, callback); return nextFrame })
  vi.stubGlobal('cancelAnimationFrame', (id: number) => { frames.delete(id) })
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => { paused++ })
  vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(() => {})
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(() => context as CanvasRenderingContext2D)
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    if (this.hasAttribute('data-muse-inline-video')) return new DOMRect(200, top, 400, 240)
    if (this.hasAttribute('data-muse-video-anchor')) return new DOMRect(350, 60, 100, 40)
    if (this.hasAttribute('data-chat-frame')) return new DOMRect(100, 50, 600, 600)
    return new DOMRect(100, 140, 600, 500)
  })
})
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals() })

function source(id: string, value: Partial<SessionVideoSource> = {}): SessionVideoSource {
  return { id: brandString<SessionVideoSourceId>(id), label: id, origin: 'generated', path: `/work/${id}.mp4`,
    eventSeq: 3, presentedIndex: null, callId: null, status: 'local', version: 'v1', playbackUrl: `/api/${id}`,
    remoteUrl: null, issue: null, ...value }
}
function shared(items: SessionVideoSource[] = []) {
  const store = createVideoStore().create(SessionId('inline-video'))
  store.actions.inventory({ sessionId: SessionId('inline-video'), sources: items, complete: true, issues: [] })
  return { useStore: bindSnapshotSelector(store), actions: store.actions, store, t: makeTranslate(en),
    listVideos: vi.fn(), detectShots: vi.fn(), pixelsPerSecond: 48 }
}
function scrollTo(view: ReturnType<typeof render>, progress: number) {
  top = 184 - progress * 260
  const scroll = view.container.querySelector('[data-chat-scroll]')
  if (scroll === null) throw new Error('Missing conversation scroller')
  fireEvent.scroll(scroll)
  const callbacks = [...frames.values()]; frames.clear()
  act(() => { for (const callback of callbacks) callback(0) })
}
function wrap(card: React.ReactNode) {
  return <div data-chat-frame><button data-muse-video-anchor>Library</button><div data-chat-scroll>{card}</div></div>
}

it.each([true, false])('collects and opens only an authorized source (bound=%s)', (bound) => {
  const value = source('clip'), state = shared([value])
  const view = render(wrap(<InlineVideoCard {...state} source={bound ? value : undefined} sourceUrl="/api/clip" label="Clip" />))
  scrollTo(view, 0.5)
  fireEvent.click(view.getByRole('button', { name: en.collected }))
  expect(state.store.getSnapshot().open).toBe(bound)
  scrollTo(view, 1)
  expect(state.store.getSnapshot().collected[bound ? value.id : '/api/clip']).toBe(true)
  view.unmount()
  expect(state.store.getSnapshot().collected[bound ? value.id : '/api/clip']).toBe(false)
})

it('retries the same source and releases the previous URL on replacement and unmount', () => {
  const state = shared(), value = source('first')
  const view = render(<InlineVideoCard {...state} source={value} sourceUrl="/api/first" label="First" />)
  const video = view.getByLabelText('First') as HTMLVideoElement
  fireEvent.error(video)
  expect(view.getByRole('alert').textContent).toContain(en.unavailable)
  fireEvent.click(view.getByRole('button', { name: en.retry }))
  expect(view.queryByRole('alert')).toBeNull()
  expect(video.getAttribute('src')).toBe('/api/first')
  view.rerender(<InlineVideoCard {...state} source={source('second')} sourceUrl="/api/second" label="Second" />)
  expect(view.getByLabelText('Second')).toBe(video)
  expect(video.getAttribute('src')).toBe('/api/second')
  expect(paused).toBeGreaterThan(0)
  view.unmount()
  expect(video.hasAttribute('src')).toBe(false)
})

it('matches delivered cards by both event sequence and presented index', () => {
  const expected = source('matched', { eventSeq: 7, presentedIndex: 2 })
  const state = shared([source('wrong-seq', { presentedIndex: 2 }), source('wrong-index', { eventSeq: 7, presentedIndex: 1 }), expected])
  const input = { ...state, sourceUrl: '/delivered', label: 'Delivered', path: '/work/matched.mp4', seq: 7, index: 2 }
  const view = render(wrap(<DeliveredVideoCard {...input as Parameters<typeof DeliveredVideoCard>[0]} />))
  scrollTo(view, 0.5)
  fireEvent.click(view.getByRole('button', { name: en.collected }))
  expect(state.store.getSnapshot().selected).toBe(expected.id)
})

it('shows only unpresented generated videos in the completed turn and suppresses matching delivered paths', () => {
  const values = [source('visible'), source('before', { eventSeq: 1 }), source('after', { eventSeq: 9 }),
    source('remote', { origin: 'presented' }), source('presented', { presentedIndex: 1 }),
    source('no-playback', { playbackUrl: null }), source('duplicate', { path: '/same.mp4' }),
    source('delivery', { path: '/same.mp4', presentedIndex: 2 }), source('null-path', { path: null })]
  const state = shared(values)
  const turn = { start: { seq: 2 }, end: { seq: 5 } } as Parameters<typeof GeneratedVideoCards>[0]['turn']
  const input = { ...state, turn, seq: 8 }
  const view = render(<GeneratedVideoCards {...input as Parameters<typeof GeneratedVideoCards>[0]} />)
  expect([...view.container.querySelectorAll('video')].map(video => video.getAttribute('src'))).toEqual(['/api/visible', '/api/null-path'])
  const missingStart = { ...input, turn: { start: undefined, end: undefined } } as Parameters<typeof GeneratedVideoCards>[0]
  view.rerender(<GeneratedVideoCards {...missingStart} />)
  expect(view.container.querySelector('video')).toBeNull()
  const openTurn = { ...input, turn: { start: { seq: 2 }, end: undefined } } as Parameters<typeof GeneratedVideoCards>[0]
  view.rerender(<GeneratedVideoCards {...openTurn} />)
  expect(view.container.querySelectorAll('video')).toHaveLength(2)
})
