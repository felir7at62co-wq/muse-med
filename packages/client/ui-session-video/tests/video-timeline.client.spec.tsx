// @vitest-environment jsdom

import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { Suspense, type ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { VideoTimeline } from '../src/client/VideoTimeline.tsx'
import type { VideoTimelineProps } from '../src/client/VideoTimeline.tsx'

const observers: { notify: () => void; disconnect: () => void }[] = []

beforeEach(() => {
  observers.length = 0
  vi.stubGlobal('ResizeObserver', class implements ResizeObserver {
    constructor(callback: ResizeObserverCallback) {
      observers.push({ notify: () => { callback([], this) }, disconnect: this.disconnect })
    }

    observe = vi.fn()
    unobserve = vi.fn()
    disconnect = vi.fn()
  })
  vi.stubGlobal('PointerEvent', class extends MouseEvent {
    readonly pointerId: number
    readonly pointerType: string
    constructor(type: string, options: PointerEventInit = {}) {
      super(type, options)
      this.pointerId = options.pointerId ?? 1
      this.pointerType = options.pointerType ?? 'mouse'
    }
  })
})

afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks() })

function props(overrides: Partial<VideoTimelineProps> = {}): VideoTimelineProps {
  return {
    shots: [
      { id: 'first', index: 1, startSeconds: 0, endSeconds: 3, thumbnail: '/real-first.jpg' },
      { id: 'last', index: 2, startSeconds: 3, endSeconds: 10, thumbnail: null },
    ],
    duration: 10,
    currentTime: 0,
    selectedShotId: 'first',
    pixelsPerSecond: 20,
    onSeek: vi.fn(),
    onSelectShot: vi.fn(),
    labels: { timeline: '镜头时间轴', playhead: '选择针', shot: (index, start, end) => `镜头 ${index}，${start}–${end}` },
    ...overrides,
  }
}

function geometry(scroll: HTMLElement, width = 200, total = 622, scale = 1) {
  Object.defineProperty(scroll, 'clientWidth', { configurable: true, value: width })
  Object.defineProperty(scroll, 'scrollWidth', { configurable: true, value: total })
  const lane = scroll.firstElementChild as HTMLElement
  lane.getBoundingClientRect = () => new DOMRect(100 - scroll.scrollLeft * scale, 0, total * scale, 78 * scale)
  const track = lane.querySelector<HTMLElement>('[style*="width:"]')!
  track.getBoundingClientRect = () => new DOMRect(100 - scroll.scrollLeft * scale + 11 * scale, 30 * scale,
    Number.parseFloat(track.style.width) * scale, 42 * scale)
  const playhead = lane.querySelector<HTMLElement>('[role="slider"]')!
  playhead.getBoundingClientRect = () => new DOMRect(100 - scroll.scrollLeft * scale
    + (Number.parseFloat(lane.style.getPropertyValue('--video-playhead-position')) - 11) * scale, 0, 22 * scale, 76 * scale)
  return lane
}

function pointerCapture(target: HTMLElement) {
  const pointers = new Set<number>()
  const set = vi.fn((id: number) => { pointers.add(id) })
  const release = vi.fn((id: number) => { pointers.delete(id) })
  Object.defineProperties(target, {
    setPointerCapture: { configurable: true, value: set },
    hasPointerCapture: { configurable: true, value: (id: number) => pointers.has(id) },
    releasePointerCapture: { configurable: true, value: release },
  })
  return { set, release, pointers }
}

describe('VideoTimeline', () => {
  it('names real shots and renders separate proportional filmstrips without inventing missing thumbnails', () => {
    const view = render(<VideoTimeline {...props()} />)
    const first = view.getByRole('button', { name: '镜头 1，0–3' })
    const last = view.getByRole('button', { name: '镜头 2，3–10' })
    expect(first.getAttribute('aria-pressed')).toBe('true')
    expect(last.getAttribute('aria-pressed')).toBe('false')
    expect(first.style.getPropertyValue('--video-shot-width')).toBe('57px')
    expect(last.style.getPropertyValue('--video-shot-width')).toBe('140px')
    expect(last.style.getPropertyValue('--video-shot-left')).toBe('60px')
    expect(first.style.getPropertyValue('--video-shot-thumbnail')).toBe('url("/real-first.jpg")')
    expect(last.style.getPropertyValue('--video-shot-thumbnail')).toBe('none')
    const slider = view.getByRole('slider', { name: '选择针' })
    expect(slider.getAttribute('aria-valuemin')).toBe('0')
    expect(slider.getAttribute('aria-valuemax')).toBe('10')
    expect(slider.getAttribute('aria-valuenow')).toBe('0')
  })

  it('selects a keyboard-activated shot at its start and seeks the exact mouse position inside it', () => {
    const input = props()
    const view = render(<VideoTimeline {...input} />)
    geometry(view.getByRole('group', { name: '镜头时间轴' }))
    const last = view.getByRole('button', { name: '镜头 2，3–10' })
    fireEvent.click(last)
    expect(input.onSelectShot).toHaveBeenLastCalledWith('last')
    expect(input.onSeek).toHaveBeenLastCalledWith(3)
    fireEvent.click(last, { detail: 1, clientX: 231 })
    expect(input.onSeek).toHaveBeenLastCalledWith(6)
    expect(input.onSelectShot).toHaveBeenCalledTimes(2)
  })

  it('seeks ruler and gap clicks using the scrolled lane position, clamped to media endpoints', () => {
    const input = props()
    const view = render(<VideoTimeline {...input} />)
    const scroll = view.getByRole('group', { name: '镜头时间轴' })
    const lane = geometry(scroll)
    scroll.scrollLeft = 40
    fireEvent.click(lane, { clientX: 171 })
    expect(input.onSeek).toHaveBeenLastCalledWith(5)
    fireEvent.click(lane, { clientX: 0 })
    expect(input.onSeek).toHaveBeenLastCalledWith(0)
    fireEvent.click(lane, { clientX: 900 })
    expect(input.onSeek).toHaveBeenLastCalledWith(10)
    const count = vi.mocked(input.onSeek).mock.calls.length
    fireEvent.click(view.getByRole('slider'))
    expect(input.onSeek).toHaveBeenCalledTimes(count)
  })

  it('moves the focused playhead by keyboard and retains the complete first and last handle', () => {
    const input = props({ currentTime: 0.5 })
    const view = render(<VideoTimeline {...input} />)
    const scroll = view.getByRole('group', { name: '镜头时间轴' })
    const lane = geometry(scroll, 100, 222)
    const slider = view.getByRole('slider')
    expect(fireEvent.keyDown(slider, { key: 'ArrowLeft' })).toBe(false)
    expect(input.onSeek).toHaveBeenLastCalledWith(0)
    fireEvent.keyDown(slider, { key: 'ArrowRight' })
    expect(input.onSeek).toHaveBeenLastCalledWith(1.5)
    fireEvent.keyDown(slider, { key: 'Home' })
    expect(input.onSeek).toHaveBeenLastCalledWith(0)
    fireEvent.keyDown(slider, { key: 'End' })
    expect(input.onSeek).toHaveBeenLastCalledWith(10)
    expect(fireEvent.keyDown(slider, { key: 'Tab' })).toBe(true)
    expect(input.onSeek).toHaveBeenCalledTimes(4)
    view.rerender(<VideoTimeline {...input} currentTime={10} />)
    expect(scroll.scrollLeft).toBe(122)
    expect(lane.style.getPropertyValue('--video-timeline-width')).toBe('222px')
    expect(lane.style.getPropertyValue('--video-playhead-position')).toBe('211px')
    fireEvent.keyDown(slider, { key: 'ArrowRight' })
    expect(input.onSeek).toHaveBeenLastCalledWith(10)
    view.rerender(<VideoTimeline {...input} currentTime={0} />)
    expect(scroll.scrollLeft).toBe(0)
    expect(lane.style.getPropertyValue('--video-playhead-position')).toBe('11px')
  })

  it('drags by mouse beyond the handle, ignores other pointers, and releases on pointerup', () => {
    const input = props()
    const view = render(<VideoTimeline {...input} />)
    geometry(view.getByRole('group'))
    const slider = view.getByRole('slider')
    const capture = pointerCapture(slider)
    fireEvent.pointerDown(slider, { pointerId: 1, button: 2, clientX: 111 })
    expect(input.onSeek).not.toHaveBeenCalled()
    fireEvent.pointerDown(slider, { pointerId: 1, button: 0, clientX: 111 })
    expect(document.activeElement).toBe(slider)
    expect(input.onSeek).not.toHaveBeenCalled()
    expect(capture.set).toHaveBeenCalledWith(1)
    fireEvent.pointerDown(slider, { pointerId: 2, button: 0, clientX: 300 })
    fireEvent.pointerMove(window, { pointerId: 2, clientX: 260 })
    fireEvent.pointerUp(window, { pointerId: 2, clientX: 260 })
    expect(input.onSeek).not.toHaveBeenCalled()
    fireEvent.pointerMove(window, { pointerId: 1, clientX: 211 })
    expect(input.onSeek).toHaveBeenLastCalledWith(5)
    fireEvent.pointerUp(window, { pointerId: 1, clientX: 900 })
    expect(input.onSeek).toHaveBeenLastCalledWith(10)
    fireEvent.pointerMove(window, { pointerId: 1, clientX: 111 })
    expect(input.onSeek).toHaveBeenCalledTimes(2)
    expect(capture.release).toHaveBeenCalledWith(1)
  })

  it('scrubs by touch and cancels on pointercancel, window blur, and unmount', () => {
    const input = props({ currentTime: 2 })
    const view = render(<VideoTimeline {...input} />)
    geometry(view.getByRole('group'))
    const slider = view.getByRole('slider')
    const capture = pointerCapture(slider)
    fireEvent.pointerDown(slider, { pointerId: 4, pointerType: 'touch', clientX: 151 })
    fireEvent.pointerMove(window, { pointerId: 4, pointerType: 'touch', clientX: 191 })
    expect(input.onSeek).toHaveBeenLastCalledWith(4)
    fireEvent.pointerCancel(window, { pointerId: 4 })
    fireEvent.pointerMove(window, { pointerId: 4, clientX: 900 })
    expect(input.onSeek).toHaveBeenCalledTimes(1)
    fireEvent.pointerDown(slider, { pointerId: 5, pointerType: 'touch', clientX: 151 })
    fireEvent.blur(window)
    fireEvent.pointerMove(window, { pointerId: 5, clientX: 900 })
    expect(input.onSeek).toHaveBeenCalledTimes(1)
    fireEvent.pointerDown(slider, { pointerId: 6, pointerType: 'touch', clientX: 151 })
    view.unmount()
    fireEvent.pointerMove(window, { pointerId: 6, clientX: 900 })
    expect(input.onSeek).toHaveBeenCalledTimes(1)
    expect(observers[0]!.disconnect).toHaveBeenCalledTimes(1)
    expect(capture.release.mock.calls).toEqual([[4], [5], [6]])
  })

  it('retains capture through controlled callback changes and stops after losing it', () => {
    const input = props()
    const view = render(<VideoTimeline {...input} />)
    geometry(view.getByRole('group'))
    const slider = view.getByRole('slider')
    const capture = pointerCapture(slider)
    fireEvent.pointerDown(slider, { pointerId: 8, button: 0, clientX: 111 })
    const nextSeek = vi.fn()
    view.rerender(<VideoTimeline {...input} currentTime={2} onSeek={nextSeek} />)
    expect(capture.release).not.toHaveBeenCalled()
    expect(capture.pointers.has(8)).toBe(true)
    fireEvent.pointerMove(window, { pointerId: 8, clientX: 211 })
    expect(nextSeek).toHaveBeenLastCalledWith(5)
    fireEvent.lostPointerCapture(slider, { pointerId: 9 })
    fireEvent.pointerMove(window, { pointerId: 8, clientX: 231 })
    expect(nextSeek).toHaveBeenLastCalledWith(6)
    fireEvent.lostPointerCapture(slider, { pointerId: 8 })
    fireEvent.pointerMove(window, { pointerId: 8, clientX: 251 })
    expect(nextSeek).toHaveBeenCalledTimes(2)
    expect(capture.release).toHaveBeenCalledWith(8)
  })

  it('fades only edges with real remaining scroll travel, including fractional positions and resize', () => {
    const view = render(<VideoTimeline {...props()} />)
    const scroll = view.getByRole('group')
    geometry(scroll)
    const before = view.container.querySelector<HTMLElement>('[data-timeline-fade="start"]')!
    const after = view.container.querySelector<HTMLElement>('[data-timeline-fade="end"]')!
    fireEvent.scroll(scroll)
    expect(before.hidden).toBe(true)
    expect(after.hidden).toBe(false)
    scroll.scrollLeft = 0.25
    fireEvent.scroll(scroll)
    fireEvent.scroll(scroll)
    expect(before.hidden).toBe(false)
    expect(after.hidden).toBe(false)
    scroll.scrollLeft = 422
    fireEvent.scroll(scroll)
    expect(before.hidden).toBe(false)
    expect(after.hidden).toBe(true)
    geometry(scroll, 622, 622)
    scroll.scrollLeft = 0
    act(() => { observers[0]!.notify() })
    expect(before.hidden).toBe(true)
    expect(after.hidden).toBe(true)
  })

  it('keeps resize and empty-media keyboard handling available without ResizeObserver', () => {
    vi.stubGlobal('ResizeObserver', undefined)
    const input = props({ shots: [], duration: 0, currentTime: 5 })
    const view = render(<VideoTimeline {...input} />)
    const slider = view.getByRole('slider')
    expect(slider.getAttribute('aria-valuenow')).toBe('0')
    expect(view.getAllByText('00:00')).toHaveLength(1)
    fireEvent.keyDown(slider, { key: 'End' })
    expect(input.onSeek).toHaveBeenLastCalledWith(0)
    fireEvent.resize(window)
    view.unmount()
    fireEvent.resize(window)
  })
})


it('keeps a grabbed cap in place without seeking, and ignores its release click before the next track gesture', () => {
  const input = props({ currentTime: 4 })
  const view = render(<VideoTimeline {...input} />)
  const lane = geometry(view.getByRole('group'))
  const slider = view.getByRole('slider')
  pointerCapture(slider)
  fireEvent.pointerDown(slider, { pointerId: 1, clientX: 196, button: 0 })
  fireEvent.pointerUp(window, { pointerId: 1, clientX: 196 })
  fireEvent.click(lane, { clientX: 196, detail: 1 })
  expect(input.onSeek).not.toHaveBeenCalled()
  fireEvent.pointerDown(lane, { pointerId: 2, clientX: 211, button: 0 })
  fireEvent.click(lane, { clientX: 211, detail: 1 })
  expect(input.onSeek).toHaveBeenLastCalledWith(5)
})

it('retains the grabbed offset and uses rendered media width under page scaling and scrolling', () => {
  const input = props({ currentTime: 4 })
  const view = render(<VideoTimeline {...input} />)
  const scroll = view.getByRole('group')
  const lane = geometry(scroll, 200, 622, .8)
  const slider = view.getByRole('slider')
  pointerCapture(slider)
  scroll.scrollLeft = 20
  fireEvent.pointerDown(slider, { pointerId: 1, clientX: 159.8, button: 0 })
  expect(input.onSeek).not.toHaveBeenCalled()
  fireEvent.pointerMove(window, { pointerId: 1, clientX: 175.8 })
  expect(vi.mocked(input.onSeek).mock.lastCall?.[0]).toBeCloseTo(5, 10)
  fireEvent.pointerUp(window, { pointerId: 1, clientX: 175.8 })
  fireEvent.click(lane, { clientX: 175.8, detail: 1 })
  expect(input.onSeek).toHaveBeenCalledTimes(2)
  expect(vi.mocked(input.onSeek).mock.lastCall?.[0]).toBeCloseTo(5, 10)
})

it('keeps shot selection without inventing media time when the track has no measurable width', () => {
  const input = props(), view = render(<VideoTimeline {...input} />)
  fireEvent.click(view.getByRole('button', { name: '镜头 2，3–10' }), { detail: 1, clientX: 10, clientY: 40 })
  expect(input.onSelectShot).toHaveBeenCalledExactlyOnceWith('last')
  expect(input.onSeek).not.toHaveBeenCalled()
})

it('does not seek a stationary grabbed pointer even when its vertical coordinate changes', () => {
  const input = props(), view = render(<VideoTimeline {...input} />)
  geometry(view.getByRole('group'))
  const slider = view.getByRole('slider'), capture = pointerCapture(slider)
  fireEvent.pointerDown(slider, { pointerId: 3, button: 0, clientX: 151, clientY: 1 })
  fireEvent.pointerMove(window, { pointerId: 3, clientX: 151, clientY: 40 })
  fireEvent.pointerUp(window, { pointerId: 3, clientX: 151, clientY: 40 })
  expect(input.onSeek).not.toHaveBeenCalled()
  expect(capture.release).toHaveBeenCalledExactlyOnceWith(3)
})

it('distinguishes a real viewport-left mouse click from keyboard activation', () => {
  const input = props(), view = render(<VideoTimeline {...input} />)
  const scroll = view.getByRole('group')
  geometry(scroll)
  scroll.scrollLeft = 200
  fireEvent.click(view.getByRole('button', { name: '镜头 2，3–10' }), { detail: 1, clientX: 0, clientY: 40 })
  expect(input.onSelectShot).toHaveBeenCalledExactlyOnceWith('last')
  expect(vi.mocked(input.onSeek).mock.lastCall?.[0]).toBeCloseTo(4.45)
})

it('ignores a queued resize observation after the timeline has unmounted', () => {
  const input = props(), view = render(<VideoTimeline {...input} />)
  const observer = observers[0]!
  view.unmount()
  expect(observer.disconnect).toHaveBeenCalledOnce()
  expect(() => { act(() => { observer.notify() }) }).not.toThrow()
  expect(input.onSeek).not.toHaveBeenCalled()
})

it('releases an active pointer when Suspense hides the timeline and accepts a fresh gesture after reveal', async () => {
  const pending = Promise.withResolvers<undefined>(), input = props()
  function Pending({ blocked, children }: { blocked: boolean; children: ReactNode }) {
    if (blocked) throw pending.promise
    return children
  }
  const tree = (blocked: boolean) => <Suspense fallback={<span>Waiting for media</span>}>
    <Pending blocked={blocked}><VideoTimeline {...input} /></Pending>
  </Suspense>
  const view = render(tree(false))
  const lane = geometry(view.getByRole('group'))
  const slider = view.getByRole('slider'), capture = pointerCapture(slider)
  fireEvent.pointerDown(slider, { pointerId: 7, button: 0, clientX: 151 })
  view.rerender(tree(true))
  expect(view.getByText('Waiting for media')).toBeDefined()
  expect(capture.release).toHaveBeenCalledExactlyOnceWith(7)
  fireEvent.resize(window)
  fireEvent.pointerMove(window, { pointerId: 7, clientX: 211 })
  fireEvent.click(lane, { detail: 1, clientX: 211, clientY: 40 })
  expect(input.onSeek).not.toHaveBeenCalled()
  view.rerender(tree(false))
  expect(view.getByRole('slider')).toBe(slider)
  fireEvent.pointerMove(window, { pointerId: 7, clientX: 231 })
  expect(input.onSeek).not.toHaveBeenCalled()
  fireEvent.pointerDown(slider, { pointerId: 8, button: 0, clientX: 151 })
  fireEvent.pointerMove(window, { pointerId: 8, clientX: 191 })
  expect(input.onSeek).toHaveBeenCalledExactlyOnceWith(2)
  view.unmount()
  await act(async () => { pending.resolve(undefined) })
})

it('retains a non-grid media endpoint when the ruler uses a coarse scale', () => {
  const input = props({ pixelsPerSecond: 8, duration: 10.1, currentTime: 20 })
  const view = render(<VideoTimeline {...input} />)
  expect(view.getByRole('slider').getAttribute('aria-valuenow')).toBe('10.1')
  const end = view.container.querySelector<HTMLElement>('[data-end="true"]')!
  expect(end.getAttribute('data-major')).toBe('true')
  expect(end.style.getPropertyValue('--video-tick-left')).toBe('80.8px')
  expect(end.textContent).toBe('00:10')
})
