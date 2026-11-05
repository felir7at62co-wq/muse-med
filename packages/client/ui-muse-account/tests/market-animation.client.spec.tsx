// @vitest-environment jsdom
/** Playback controls and sprite clipping for prebuilt market characters. */
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { MarketAnimation } from '../src/client/MarketAnimation.tsx'
import { directorAnimation } from './character-generation-fixture.client.ts'

afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals() })

it('plays only visible media, switches to introduction frames, and respects reduced motion and errors', async () => {
  vi.useFakeTimers()
  const motion = Object.assign(new EventTarget(), { matches: false })
  vi.stubGlobal('matchMedia', vi.fn(() => motion))
  let hidden = false
  vi.spyOn(document, 'hidden', 'get').mockImplementation(() => hidden)
  let visible: (value: boolean) => void = () => {}
  const disconnect = vi.fn(), observe = vi.fn()
  vi.stubGlobal('IntersectionObserver', class {
    constructor(callback: (entries: { isIntersecting: boolean }[]) => void) {
      visible = (value) => { callback([{ isIntersecting: value }]) }
    }
    observe = observe
    disconnect = disconnect
  })
  const props = { animation: directorAnimation, introducing: false, label: 'Director', fallback: <img src="/poster.png" alt="Static director" />, framing: undefined }
  const view = render(<MarketAnimation {...props} />)
  const sprite = view.container.querySelector('image')!
  fireEvent.load(sprite)
  expect(screen.getByRole('img', { name: 'Static director' })).toBeDefined()
  act(() => { visible(true) })
  expect(sprite.closest('span')?.hidden).toBe(false)
  await act(async () => { await vi.advanceTimersByTimeAsync(3500) })
  expect(sprite.getAttribute('x')).toBe('-627')
  await act(async () => { await vi.advanceTimersByTimeAsync(160) })
  expect(sprite.getAttribute('x')).toBe('0')
  view.rerender(<MarketAnimation {...props} introducing />)
  expect(sprite.closest('span')?.hidden).toBe(false)
  expect(screen.queryByRole('img', { name: 'Static director' })).toBeNull()
  expect(view.container.querySelector('image')).toBe(sprite)
  expect(observe).toHaveBeenCalledTimes(1)
  expect(disconnect).not.toHaveBeenCalled()
  expect(sprite.getAttribute('y')).toBe('-627')
  for (const introducing of [false, true, false, true]) {
    view.rerender(<MarketAnimation {...props} introducing={introducing} />)
    expect(sprite.closest('span')?.hidden).toBe(false)
    expect(sprite.getAttribute('x')).toBe('0')
    expect(sprite.getAttribute('y')).toBe(introducing ? '-627' : '0')
    expect(screen.queryByRole('img', { name: 'Static director' })).toBeNull()
    expect(view.container.querySelector('image')).toBe(sprite)
  }
  expect(observe).toHaveBeenCalledTimes(1)
  expect(vi.getTimerCount()).toBe(1)
  act(() => { hidden = true; document.dispatchEvent(new Event('visibilitychange')) })
  expect(vi.getTimerCount()).toBe(0)
  expect(screen.getByRole('img', { name: 'Static director' })).toBeDefined()
  act(() => { hidden = false; document.dispatchEvent(new Event('visibilitychange')) })
  expect(sprite.closest('span')?.hidden).toBe(false)
  act(() => { visible(false) })
  expect(vi.getTimerCount()).toBe(0)
  act(() => { visible(true); motion.matches = true; motion.dispatchEvent(new Event('change')) })
  expect(screen.getByRole('img', { name: 'Static director' })).toBeDefined()
  expect(vi.getTimerCount()).toBe(0)
  act(() => { motion.matches = false; motion.dispatchEvent(new Event('change')) })
  fireEvent.error(sprite)
  expect(screen.getByRole('img', { name: 'Static director' })).toBeDefined()
  expect(vi.getTimerCount()).toBe(0)
  view.unmount(); expect(disconnect).toHaveBeenCalled()
})

it('clips each sprite to its own source cell with independent IDs across portrait instances', () => {
  const wide = { ...directorAnimation, sheetUrl: '/wide-sheet.png', cellWidth: 400, cellHeight: 300 }
  const view = render(<>
    <MarketAnimation animation={directorAnimation} introducing label="Director" fallback={<span />} framing={undefined} />
    <MarketAnimation animation={wide} introducing={false} label="Wide character" fallback={<span />} framing={undefined} />
  </>)
  const clips = [...view.container.querySelectorAll('clipPath')]
  expect(clips).toHaveLength(2)
  expect(clips[0]!.id).not.toBe(clips[1]!.id)
  for (const [index, animation] of [directorAnimation, wide].entries()) {
    const clip = clips[index]!, rectangle = clip.querySelector('rect')!
    expect(clip.getAttribute('clipPathUnits')).toBe('userSpaceOnUse')
    expect(rectangle.getAttribute('x')).toBe('0'); expect(rectangle.getAttribute('y')).toBe('0')
    expect(rectangle.getAttribute('width')).toBe(String(animation.cellWidth))
    expect(rectangle.getAttribute('height')).toBe(String(animation.cellHeight))
    const image = view.container.querySelectorAll('image')[index]!
    expect(image.parentElement?.getAttribute('clip-path')).toBe(`url(#${clip.id})`)
  }
})

it('keeps the static portrait when visibility is unknown or the sequence is empty', () => {
  const motion = Object.assign(new EventTarget(), { matches: false })
  vi.stubGlobal('matchMedia', () => motion)
  vi.stubGlobal('IntersectionObserver', undefined)
  const props = { label: 'Director', fallback: <span>Static director</span>, framing: undefined }
  const view = render(<MarketAnimation {...props} animation={directorAnimation} introducing={false} />)
  fireEvent.load(view.container.querySelector('image')!)
  expect(screen.getByText('Static director')).toBeDefined()
  view.rerender(<MarketAnimation {...props} animation={{ ...directorAnimation, introduce: [] }} introducing />)
  expect(screen.getByText('Static director')).toBeDefined()
  expect(view.container.querySelector('image')?.getAttribute('x')).toBe('0')
  expect(view.container.querySelector('image')?.getAttribute('y')).toBe('0')
})
