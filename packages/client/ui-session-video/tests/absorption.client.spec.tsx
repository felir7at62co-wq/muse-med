// @vitest-environment jsdom

import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { useCallback, useRef } from 'react'
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
const resizeListeners: { notify: () => void; disconnect: () => void; observe: ResizeObserver['observe'] }[] = []
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
      resizeListeners.push({ notify: () => { callback([], this) }, disconnect: this.disconnect, observe: this.observe })
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

interface OriginalSurface {
  readonly visibility?: 'visible' | 'collapse'
  readonly inert?: boolean
  readonly aria?: 'true' | 'false'
}

function Card({ original, ...input }: AbsorptionOptions & { original?: OriginalSurface | undefined }) {
  const ref = useRef<HTMLDivElement | null>(null)
  const attach = useCallback((element: HTMLDivElement | null) => {
    ref.current = element
    if (element) element.inert = original?.inert ?? false
  }, [original])
  const portal = useAbsorption(ref, input)
  return <div ref={attach} data-video-source aria-label="打开真实视频" style={{ visibility: original?.visibility }}
    aria-hidden={original?.aria}><video /><span>原卡片</span>{portal}</div>
}

function Fixture({ external = false, hasAnchor = true, siblingAnchor = false, delivered = false,
  sourceOriginal, deliveryOriginal, ...input }:
AbsorptionOptions & {
  external?: boolean
  hasAnchor?: boolean
  siblingAnchor?: boolean
  delivered?: boolean
  sourceOriginal?: OriginalSurface
  deliveryOriginal?: OriginalSurface
}) {
  const card = <Card {...input} original={sourceOriginal} />
  const target = hasAnchor && <button data-muse-video-anchor type="button" aria-label="视频气泡" />
  const content = <div data-chat-frame>
    {!siblingAnchor && target}
    <div data-chat-scroll>{delivered ? <div data-presented-file data-video="true"
      style={{ visibility: deliveryOriginal?.visibility }} aria-hidden={deliveryOriginal?.aria}
      ref={(element) => { if (element) element.inert = deliveryOriginal?.inert ?? false }}>
      <button type="button">Native file action</button>{card}
    </div> : card}</div>
  </div>
  const owner = siblingAnchor ? <div data-conversation-content>{target}{content}</div> : content
  return external ? <div data-conversation-scroll>{owner}</div> : owner
}

function deliveredElements(container: HTMLElement) {
  const delivery = container.querySelector<HTMLElement>('[data-presented-file][data-video="true"]')
  const card = container.querySelector<HTMLElement>('[data-video-source]')
  const scroll = container.querySelector<HTMLElement>('[data-chat-scroll]')
  if (delivery === null || card === null || scroll === null) throw new Error('Delivered video fixture is missing')
  return { delivery, card, scroll }
}

function inputs(): AbsorptionOptions { return { id: 'real-video', onCollect: vi.fn(), onOpen: vi.fn() } }

describe('useAbsorption', () => {
  it('leaves a card outside a Chat frame or without a scroll owner in place', () => {
    const input = inputs()
    const outside = render(<Card {...input} />)
    expect(outside.container.querySelector('[data-video-absorption]')).toBeNull()
    expect(frames.size).toBe(0)
    outside.unmount()
    const withoutScroll = render(<div data-chat-frame><Card {...input} /></div>)
    expect(withoutScroll.container.querySelector<HTMLElement>('[data-video-source]')?.style.visibility).toBe('')
    expect(frames.size).toBe(0)
    expect(resizeListeners).toHaveLength(0)
    expect(input.onCollect).not.toHaveBeenCalled()
  })

  it('draws the approaching material without a neck and clips it inside a colored receiving bubble', () => {
    setProgress(0.1)
    const view = render(<Fixture {...inputs()} />)
    const target = view.getByRole('button', { name: '视频气泡' })
    target.style.backgroundColor = 'rgb(10, 20, 30)'
    flushFrame()
    expect(canvasContext.fillStyle).toBe('rgb(10, 20, 30)')
    expect(canvasContext.bezierCurveTo).not.toHaveBeenCalled()
    expect(canvasContext.rect).toHaveBeenCalled()
    setProgress(0.9)
    fireEvent.resize(window)
    flushFrame()
    expect(canvasContext.roundRect).toHaveBeenCalledWith(353, 63, 94, 34, 17)
    expect(view.container.querySelector<HTMLElement>('[data-video-absorption]')?.dataset.phase).toBe('inside')
  })

  it('keeps the material when only the readable-frame snapshot lacks a canvas context', () => {
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(function (this: HTMLCanvasElement) {
      return this.isConnected ? browserContext as CanvasRenderingContext2D : null
    })
    setProgress(0.3)
    const view = render(<Fixture {...inputs()} />)
    const video = view.container.querySelector('video')!
    Object.defineProperty(video, 'readyState', { configurable: true, value: 2 })
    Object.defineProperty(video, 'videoWidth', { configurable: true, value: 1920 })
    flushFrame()
    expect(view.container.querySelector<HTMLElement>('[data-video-absorption]')?.hidden).toBe(false)
    expect(canvasContext.fill).toHaveBeenCalled()
    expect(canvasContext.drawImage).not.toHaveBeenCalled()
  })

  it('restores a collected card when its receiving anchor disappears', () => {
    const input = inputs()
    setProgress(1)
    const view = render(<Fixture {...input} />)
    flushFrame()
    expect(input.onCollect).toHaveBeenLastCalledWith(true)
    view.rerender(<Fixture {...input} hasAnchor={false} />)
    fireEvent.resize(window)
    flushFrame()
    expect(input.onCollect).toHaveBeenLastCalledWith(false)
    expect(view.container.querySelector<HTMLElement>('[data-video-source]')?.style.visibility).toBe('')
    expect(view.container.querySelector<HTMLElement>('[data-video-absorption]')?.hidden).toBe(true)
  })

  it('restores the anchor material it borrowed and leaves a newer collector in control on teardown', () => {
    const view = render(<Fixture {...inputs()} />)
    const target = view.getByRole('button', { name: '视频气泡' })
    target.style.setProperty('--muse-video-fusion', '0.2')
    setProgress(0.5)
    flushFrame()
    expect(target.style.getPropertyValue('--muse-video-fusion')).toBe('1')
    setProgress(0)
    fireEvent.resize(window)
    flushFrame()
    expect(target.style.getPropertyValue('--muse-video-fusion')).toBe('0.2')
    setProgress(0.5)
    fireEvent.resize(window)
    flushFrame()
    target.setAttribute('data-muse-video-fusion-owner', 'newer-video')
    target.style.setProperty('--muse-video-fusion', '0.7')
    view.unmount()
    expect(target.getAttribute('data-muse-video-fusion-owner')).toBe('newer-video')
    expect(target.style.getPropertyValue('--muse-video-fusion')).toBe('0.7')
  })

  it('collects into the conversation sibling anchor while retaining the portal in its Chat frame', () => {
    const view = render(<Fixture {...inputs()} siblingAnchor />)
    const card = view.container.querySelector<HTMLElement>('[data-video-source]')!
    const scroll = view.container.querySelector<HTMLElement>('[data-chat-scroll]')!
    const frame = view.container.querySelector<HTMLElement>('[data-chat-frame]')!
    const target = view.getByRole('button', { name: '视频气泡' })
    expect(frame.contains(target)).toBe(false)
    flushFrame()
    setProgress(0.5)
    fireEvent.scroll(scroll)
    flushFrame()
    expect(card.style.visibility).toBe('hidden')
    expect(target.style.getPropertyValue('--muse-video-fusion')).toBe('1')
    expect(view.container.querySelector('[data-video-absorption]')?.parentElement).toBe(frame)
    expect(resizeListeners[0]!.observe).toHaveBeenCalledWith(target)
    setProgress(0)
    fireEvent.scroll(scroll)
    flushFrame()
    expect(card.style.visibility).toBe('')
    expect(target.style.getPropertyValue('--muse-video-fusion')).toBe('')
  })

  it('does not collect into another conversation when its own sibling anchor is absent', () => {
    const input = inputs()
    setProgress(0.5)
    const view = render(<>
      <Fixture {...input} siblingAnchor hasAnchor={false} />
      <div data-conversation-content><button data-muse-video-anchor type="button" aria-label="Other conversation" /></div>
    </>)
    flushFrame()
    const other = view.getByRole('button', { name: 'Other conversation' })
    expect(view.container.querySelector<HTMLElement>('[data-video-source]')?.style.visibility).toBe('')
    expect(other.style.getPropertyValue('--muse-video-fusion')).toBe('')
    expect(input.onCollect).not.toHaveBeenCalled()
    expect(resizeListeners[0]!.observe).not.toHaveBeenCalledWith(other)
  })

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

  it('conceals the entire delivered card and native action while retaining its original inline geometry', () => {
    const view = render(<Fixture {...inputs()} delivered />)
    const { delivery, card, scroll } = deliveredElements(view.container)
    const action = view.getByRole('button', { name: 'Native file action' })
    const originalParent = delivery.parentElement
    const originalVideo = card.querySelector('video')
    flushFrame()
    setProgress(0.5)
    fireEvent.scroll(scroll)
    flushFrame()
    for (const surface of [delivery, card]) {
      expect(surface.style.visibility).toBe('hidden')
      expect(surface.inert).toBe(true)
      expect(surface.getAttribute('aria-hidden')).toBe('true')
    }
    expect(view.queryByRole('button', { name: 'Native file action' })).toBeNull()
    expect(view.container.querySelector('[data-video-absorption]')?.getAttribute('data-phase')).toBe('merging')
    expect(delivery.parentElement).toBe(originalParent)
    expect(delivery.contains(card)).toBe(true)
    expect(card.querySelector('video')).toBe(originalVideo)
    expect(card.getBoundingClientRect().height).toBe(source.height)
    setProgress(0)
    fireEvent.scroll(scroll)
    flushFrame()
    for (const surface of [delivery, card]) {
      expect(surface.style.visibility).toBe('')
      expect(surface.inert).toBe(false)
      expect(surface.hasAttribute('aria-hidden')).toBe(false)
    }
    expect(view.getByRole('button', { name: 'Native file action' })).toBe(action)
    expect(card.querySelector('video')).toBe(originalVideo)
  })

  it('restores original visibility, inertness and ARIA on both delivered surfaces after unmount', () => {
    const view = render(<Fixture {...inputs()} delivered
      sourceOriginal={{ visibility: 'visible', inert: true, aria: 'false' }}
      deliveryOriginal={{ visibility: 'collapse', inert: false, aria: 'true' }} />)
    const { delivery, card, scroll } = deliveredElements(view.container)
    flushFrame()
    setProgress(0.5)
    fireEvent.scroll(scroll)
    flushFrame()
    expect(delivery.style.visibility).toBe('hidden')
    expect(card.style.visibility).toBe('hidden')
    view.unmount()
    expect(card.style.visibility).toBe('visible')
    expect(card.inert).toBe(true)
    expect(card.getAttribute('aria-hidden')).toBe('false')
    expect(delivery.style.visibility).toBe('collapse')
    expect(delivery.inert).toBe(false)
    expect(delivery.getAttribute('aria-hidden')).toBe('true')
  })

  it('restores the complete delivered card to its prior state when canvas creation fails mid-flight', () => {
    const view = render(<Fixture {...inputs()} delivered
      sourceOriginal={{ visibility: 'visible', inert: false, aria: 'false' }}
      deliveryOriginal={{ visibility: 'visible', inert: true, aria: 'false' }} />)
    const { delivery, card, scroll } = deliveredElements(view.container)
    flushFrame()
    setProgress(0.5)
    fireEvent.scroll(scroll)
    flushFrame()
    expect(delivery.style.visibility).toBe('hidden')
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null)
    fireEvent.resize(window)
    flushFrame()
    expect(card.style.visibility).toBe('visible')
    expect(card.inert).toBe(false)
    expect(card.getAttribute('aria-hidden')).toBe('false')
    expect(delivery.style.visibility).toBe('visible')
    expect(delivery.inert).toBe(true)
    expect(delivery.getAttribute('aria-hidden')).toBe('false')
    expect(view.container.querySelector<HTMLElement>('[data-video-absorption]')?.hidden).toBe(true)
    expect(view.getByRole('button', { name: '视频气泡' }).style.getPropertyValue('--muse-video-fusion')).toBe('')
  })

})
