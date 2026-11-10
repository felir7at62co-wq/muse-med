/** Static media queries and initial resize delivery for jsdom; geometry/timing suites supply their own observers. */
import { afterAll, beforeEach } from 'vitest'

const original = Object.getOwnPropertyDescriptor(globalThis, 'ResizeObserver')
const originalMatchMedia = Object.getOwnPropertyDescriptor(globalThis, 'matchMedia')
let installed = false
let installedMatchMedia = false

class TestResizeObserver implements ResizeObserver {
  private readonly targets = new Set<Element>()

  constructor(private readonly callback: ResizeObserverCallback) {}

  observe(target: Element): void {
    if (this.targets.has(target)) return
    this.targets.add(target)
    const width = target instanceof HTMLElement ? target.offsetWidth : 0
    const height = target instanceof HTMLElement ? target.offsetHeight : 0
    const size = [{ inlineSize: width, blockSize: height }]
    this.callback([{
      target, contentRect: new DOMRectReadOnly(0, 0, width, height),
      borderBoxSize: size, contentBoxSize: size, devicePixelContentBoxSize: size,
    }], this)
  }

  unobserve(target: Element): void { this.targets.delete(target) }

  disconnect(): void { this.targets.clear() }
}

beforeEach(() => {
  if (typeof document !== 'undefined' && typeof matchMedia === 'undefined') {
    Object.defineProperty(globalThis, 'matchMedia', { configurable: true, writable: true,
      value: (media: string): MediaQueryList => Object.assign(new EventTarget(), {
        media, matches: false, onchange: null, addListener() {}, removeListener() {},
      }),
    })
    installedMatchMedia = true
  }
  if (typeof document !== 'undefined' && typeof ResizeObserver === 'undefined') {
    // Establish the per-environment default, so vi.unstubAllGlobals restores it.
    Object.defineProperty(globalThis, 'ResizeObserver', { configurable: true, writable: true, value: TestResizeObserver })
    installed = true
  }
})

afterAll(() => {
  if (installedMatchMedia) {
    if (originalMatchMedia === undefined) Reflect.deleteProperty(globalThis, 'matchMedia')
    else Object.defineProperty(globalThis, 'matchMedia', originalMatchMedia)
  }
  if (!installed) return
  if (original === undefined) Reflect.deleteProperty(globalThis, 'ResizeObserver')
  else Object.defineProperty(globalThis, 'ResizeObserver', original)
})
