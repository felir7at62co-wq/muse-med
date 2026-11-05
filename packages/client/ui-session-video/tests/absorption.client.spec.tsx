// @vitest-environment jsdom

import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { useRef } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { absorptionGeometry } from '../src/client/absorption.ts'
import type { AbsorptionOptions } from '../src/client/useAbsorption.tsx'
import { useAbsorption } from '../src/client/useAbsorption.tsx'

const source = { left: 200, top: 240, width: 400, height: 240 }
const viewport = { left: 100, top: 140, width: 600, height: 500 }
const anchor = { left: 350, top: 60, width: 100, height: 40 }

function at(progress: number, reducedMotion = false) {
  return absorptionGeometry({ source: { ...source, top: viewport.top + 44 - progress * (source.height * 0.9 + 44) },
    viewport, anchor, reducedMotion })
}

describe('absorptionGeometry', () => {
  it('keeps endpoints stable and reverses from the same measured scroll position', () => {
    expect(at(0).phase).toBe('idle')
    expect(at(0).collected).toBe(false)
    expect(at(0.25).phase).toBe('moving')
    expect(at(0.6).phase).toBe('merging')
    expect(at(0.9).phase).toBe('inside')
    expect(at(1).phase).toBe('collected')
    expect(at(0.984).collected).toBe(false)
    expect(at(0.985).collected).toBe(true)
  })

  it('forms an opaque neck before contact and overlaps the bubble before entering it', () => {
    const approaching = at(0.3)
    expect(approaching.neck).not.toBeNull()
    expect(approaching.neck?.opacity).toBe(1)
    expect(approaching.sprite.top - anchor.top - anchor.height).toBeLessThan(64)
    const touching = at(0.5)
    expect(touching.sprite.top).toBeCloseTo(anchor.top + anchor.height - 5)
    expect(touching.fusion).toBe(1)
    expect(at(0.1).neck).toBeNull()
    expect(at(1).neck).toBeNull()
  })

  it('clips the final sprite inside the bubble and fades its content before collection', () => {
    const entering = at(0.9)
    expect(entering.clip).toEqual({ left: 353, top: 63, width: 94, height: 34 })
    expect(entering.contentOpacity).toBe(0)
    expect(entering.borderOpacity).toBe(0)
    expect(at(0.85).clip).toBeNull()
    expect(at(0.3).contentOpacity).toBe(1)
  })

  it('honors reduced motion and refuses to collect into an unmeasurable anchor', () => {
    expect(at(0.5, true).phase).toBe('idle')
    expect(at(0.5, true).neck).toBeNull()
    expect(at(1, true).phase).toBe('collected')
    const missing = absorptionGeometry({ source, viewport, anchor: { ...anchor, height: 0 }, reducedMotion: false })
    expect(missing.phase).toBe('idle')
    expect(missing.collected).toBe(false)
    expect(absorptionGeometry({ source: { ...source, height: 0, width: 0 }, viewport, anchor, reducedMotion: false }).phase).toBe('idle')
  })
})

let sourceTop = source.top
let reduced = false
let frameId = 0
const frames = new Map<number, FrameRequestCallback>()
const motionListeners = new Set<() => void>()
const resizeListeners: { notify: () => void; disconnect: () => void }[] = []
const pauseVideo = vi.fn()
const canvasContext = {
  setTransform: vi.fn(), save: vi.fn(), restore: vi.fn(), beginPath: vi.fn(),
  moveTo: vi.fn(), bezierCurveTo: vi.fn(), lineTo: vi.fn(), closePath: vi.fn(),
  fill: vi.fn(), rect: vi.fn(), roundRect: vi.fn(), clip: vi.fn(),
  drawImage: vi.fn<(image: CanvasImageSource, ...coordinates: number[]) => void>(),
  getImageData: vi.fn<CanvasRenderingContext2D['getImageData']>(
    () => ({ data: new Uint8ClampedArray(4), width: 1, height: 1, colorSpace: 'srgb' })),
  fillStyle: '', globalAlpha: 1,
}
const browserContext: Pick<CanvasRenderingContext2D, keyof typeof canvasContext> = canvasContext

beforeEach(() => {
  sourceTop = source.top
  reduced = false
  frameId = 0
  frames.clear()
  motionListeners.clear()
  resizeListeners.length = 0
  vi.clearAllMocks()
  canvasContext.getImageData.mockReset().mockReturnValue({ data: new Uint8ClampedArray(4), width: 1, height: 1, colorSpace: 'srgb' })
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { frames.set(++frameId, callback); return frameId })
  vi.stubGlobal('cancelAnimationFrame', (id: number) => { frames.delete(id) })
  vi.stubGlobal('matchMedia', () => ({
    get matches() { return reduced },
    addEventListener: (_type: string, listener: () => void) => { motionListeners.add(listener) },
    removeEventListener: (_type: string, listener: () => void) => { motionListeners.delete(listener) },
  }))
  vi.stubGlobal('ResizeObserver', class implements ResizeObserver {
    constructor(callback: ResizeObserverCallback) {
      resizeListeners.push({ notify: () => { callback([], this) }, disconnect: this.disconnect })
    }

    observe = vi.fn()
    unobserve = vi.fn()
    disconnect = vi.fn()
  })
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    if (this.hasAttribute('data-video-source') || this instanceof HTMLVideoElement) {
      return new DOMRect(source.left, sourceTop, source.width, source.height)
    }
    if (this.hasAttribute('data-muse-video-anchor')) return new DOMRect(anchor.left, anchor.top, anchor.width, anchor.height)
    if (this.hasAttribute('data-chat-frame')) return new DOMRect(100, 50, 600, 600)
    return new DOMRect(viewport.left, viewport.top, viewport.width, viewport.height)
  })
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(pauseVideo)
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(() => browserContext as CanvasRenderingContext2D)
})

afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals() })

function flushFrame() {
  const callbacks = [...frames.values()]
  frames.clear()
  act(() => { for (const callback of callbacks) callback(0) })
}

function setProgress(progress: number) {
  sourceTop = viewport.top + 44 - progress * (source.height * 0.9 + 44)
}

function Card(input: AbsorptionOptions) {
  const ref = useRef<HTMLDivElement>(null)
  const portal = useAbsorption(ref, input)
  return <div ref={ref} data-video-source aria-label="打开真实视频"><video /><span>原卡片</span>{portal}</div>
}

function Fixture({ external = false, hasAnchor = true, ...input }: AbsorptionOptions & { external?: boolean; hasAnchor?: boolean }) {
  const content = <div data-chat-frame>
    {hasAnchor && <button data-muse-video-anchor type="button" aria-label="视频气泡" />}
    <div data-chat-scroll><Card {...input} /></div>
  </div>
  return external ? <div data-conversation-scroll>{content}</div> : content
}

function inputs(): AbsorptionOptions { return { id: 'real-video', onCollect: vi.fn(), onOpen: vi.fn() } }

describe('useAbsorption', () => {
  it('keeps source nodes in React layout, pauses once when hidden, and restores them on reverse scroll', () => {
    const input = inputs()
    const view = render(<Fixture {...input} />)
    const sourceElement = view.container.querySelector<HTMLElement>('[data-video-source]')!
    const video = sourceElement.querySelector('video')!
    const parent = sourceElement.parentElement
    const scroll = view.container.querySelector<HTMLElement>('[data-chat-scroll]')!
    flushFrame()
    expect(sourceElement.style.visibility).toBe('')
    setProgress(0.5)
    fireEvent.scroll(scroll)
    fireEvent.scroll(scroll)
    expect(frames.size).toBe(1)
    flushFrame()
    expect(sourceElement.style.visibility).toBe('hidden')
    expect(sourceElement.parentElement).toBe(parent)
    expect(sourceElement.querySelector('video')).toBe(video)
    expect(pauseVideo).toHaveBeenCalledTimes(1)
    expect(view.container.querySelector('[data-video-absorption]')?.getAttribute('data-phase')).toBe('merging')
    fireEvent.click(view.getByRole('button', { name: '打开真实视频' }))
    expect(input.onOpen).toHaveBeenCalledTimes(1)
    fireEvent.scroll(scroll)
    flushFrame()
    expect(pauseVideo).toHaveBeenCalledTimes(1)
    setProgress(0)
    fireEvent.scroll(scroll)
    flushFrame()
    expect(sourceElement.style.visibility).toBe('')
    expect(sourceElement.hasAttribute('aria-hidden')).toBe(false)
    expect(sourceElement.querySelector('video')).toBe(video)
  })

  it('announces collection only when it changes and restores fusion and listeners on unmount', () => {
    const input = inputs()
    const view = render(<Fixture {...input} />)
    const scroll = view.container.querySelector<HTMLElement>('[data-chat-scroll]')!
    flushFrame()
    expect(input.onCollect).not.toHaveBeenCalled()
    setProgress(0.5)
    fireEvent.scroll(scroll)
    flushFrame()
    const target = view.getByRole('button', { name: '视频气泡' })
    expect(target.style.getPropertyValue('--muse-video-fusion')).toBe('1')
    setProgress(1)
    fireEvent.scroll(scroll)
    flushFrame()
    expect(target.style.getPropertyValue('--muse-video-fusion')).toBe('')
    expect(input.onCollect).toHaveBeenCalledExactlyOnceWith(true)
    fireEvent.resize(window)
    flushFrame()
    expect(input.onCollect).toHaveBeenCalledTimes(1)
    fireEvent.resize(window)
    expect(frames.size).toBe(1)
    view.unmount()
    expect(frames.size).toBe(0)
    expect(motionListeners.size).toBe(0)
    expect(resizeListeners[0]!.disconnect).toHaveBeenCalledTimes(1)
    expect(input.onCollect).toHaveBeenLastCalledWith(false)
    fireEvent.scroll(scroll)
    fireEvent.resize(window)
    expect(frames.size).toBe(0)
  })

  it('uses the enclosing conversation scroll owner and honors live reduced-motion changes', () => {
    const input = inputs()
    const view = render(<Fixture {...input} external />)
    const outer = view.container.querySelector<HTMLElement>('[data-conversation-scroll]')!
    const inner = view.container.querySelector<HTMLElement>('[data-chat-scroll]')!
    const card = view.container.querySelector<HTMLElement>('[data-video-source]')!
    flushFrame()
    setProgress(0.5)
    fireEvent.scroll(inner)
    expect(frames.size).toBe(0)
    fireEvent.scroll(outer)
    flushFrame()
    expect(card.style.visibility).toBe('hidden')
    reduced = true
    act(() => { for (const listener of motionListeners) listener() })
    flushFrame()
    expect(card.style.visibility).toBe('')
    setProgress(1)
    fireEvent.scroll(outer)
    flushFrame()
    expect(card.style.visibility).toBe('hidden')
    expect(input.onCollect).toHaveBeenLastCalledWith(true)
    setProgress(0)
    resizeListeners[0]!.notify()
    flushFrame()
    expect(card.style.visibility).toBe('')
    expect(input.onCollect).toHaveBeenLastCalledWith(false)
  })

  it('draws only real readable video frames and retains material when CORS prevents capture', () => {
    setProgress(0.5)
    const view = render(<Fixture {...inputs()} />)
    const video = view.container.querySelector('video')!
    Object.defineProperty(video, 'readyState', { configurable: true, value: 2 })
    Object.defineProperty(video, 'videoWidth', { configurable: true, value: 1920 })
    flushFrame()
    expect(canvasContext.drawImage.mock.calls.some(call => call[0] === video)).toBe(true)
    expect(canvasContext.drawImage.mock.calls.some(call => call[0] instanceof HTMLCanvasElement)).toBe(true)
    canvasContext.drawImage.mockClear()
    canvasContext.getImageData.mockImplementation(() => { throw new DOMException('Cross origin', 'SecurityError') })
    fireEvent.resize(window)
    flushFrame()
    expect(canvasContext.drawImage.mock.calls.some(call => call[0] === video)).toBe(true)
    expect(canvasContext.drawImage.mock.calls.some(call => call[0] instanceof HTMLCanvasElement)).toBe(false)
  })

  it('retains the card when its anchor is absent and tolerates optional browser observers', () => {
    vi.stubGlobal('ResizeObserver', undefined)
    vi.stubGlobal('matchMedia', undefined)
    const input = inputs()
    setProgress(0.5)
    const view = render(<Fixture {...input} hasAnchor={false} />)
    flushFrame()
    const card = view.container.querySelector<HTMLElement>('[data-video-source]')!
    expect(card.style.visibility).toBe('')
    expect(input.onCollect).not.toHaveBeenCalled()
    view.rerender(<Fixture {...input} />)
    fireEvent.resize(window)
    flushFrame()
    expect(card.style.visibility).toBe('hidden')
  })

  it('keeps the original visible when the browser cannot create a canvas context', () => {
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null)
    setProgress(0.5)
    const view = render(<Fixture {...inputs()} />)
    flushFrame()
    expect(view.container.querySelector<HTMLElement>('[data-video-source]')?.style.visibility).toBe('')
    expect(view.container.querySelector<HTMLElement>('[data-video-absorption]')?.hidden).toBe(true)
  })
})
