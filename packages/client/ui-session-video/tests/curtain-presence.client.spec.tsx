// @vitest-environment jsdom
/** Closing media remains mounted for real transition completion and ignores obsolete completion callbacks. */
import { useRef } from 'react'
import type { Dispatch, SetStateAction } from 'react'
import { act, cleanup, render } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { useCurtainPresence } from '../src/client/useCurtainPresence.ts'

const stateWrites = vi.hoisted(() => vi.fn())
vi.mock('react', async (importOriginal) => {
  const original = await importOriginal<typeof import('react')>()
  function useObservedState<S>(initial: S | (() => S)): [S, Dispatch<SetStateAction<S>>] {
    const [value, setValue] = original.useState(initial)
    const write = original.useCallback((next: SetStateAction<S>) => { stateWrites(next); setValue(next) }, [setValue])
    return [value, write]
  }
  return { ...original, useState: useObservedState }
})

let getAnimationsDescriptor: PropertyDescriptor | undefined
beforeEach(() => {
  getAnimationsDescriptor = Object.getOwnPropertyDescriptor(Element.prototype, 'getAnimations')
  Object.defineProperty(Element.prototype, 'getAnimations', { configurable: true, writable: true, value: () => [] })
  stateWrites.mockClear()
})
afterEach(() => {
  try { cleanup() } finally {
    vi.restoreAllMocks()
    if (getAnimationsDescriptor === undefined) Reflect.deleteProperty(Element.prototype, 'getAnimations')
    else Object.defineProperty(Element.prototype, 'getAnimations', getAnimationsDescriptor)
  }
})

function Fixture({ open }: { open: boolean }) {
  const owner = useRef<HTMLDivElement | null>(null)
  const present = useCurtainPresence(open, owner)
  return <div ref={owner} data-testid="curtain">{present && <span>Mounted media</span>}</div>
}

/** Browser-owned completion controlled without test-clock assumptions. */
function transition() {
  const done = Promise.withResolvers<Animation>()
  const animation = { finished: done.promise } as Animation
  return { animation, finish: () => { done.resolve(animation) },
    cancel: () => { done.reject(new DOMException('Transition canceled', 'AbortError')) } }
}

it('starts closed without briefly mounting media and mounts when opened', () => {
  const view = render(<Fixture open={false} />)
  expect(view.queryByText('Mounted media')).toBeNull()
  view.rerender(<Fixture open />)
  expect(view.getByText('Mounted media')).toBeTruthy()
})

it('retains closing media until every transition settles, including cancellation', async () => {
  const view = render(<Fixture open />)
  const size = transition(), opacity = transition()
  vi.spyOn(view.getByTestId('curtain'), 'getAnimations').mockReturnValue([size.animation, opacity.animation])
  view.rerender(<Fixture open={false} />)
  const media = view.getByText('Mounted media')
  await act(async () => { size.finish(); await size.animation.finished })
  expect(view.getByText('Mounted media')).toBe(media)
  await act(async () => { opacity.cancel(); await Promise.allSettled([opacity.animation.finished]) })
  expect(view.queryByText('Mounted media')).toBeNull()
})

it('reopening invalidates the old close and a later close waits for its own transition', async () => {
  const view = render(<Fixture open />)
  const first = transition(), second = transition()
  const animations = vi.spyOn(view.getByTestId('curtain'), 'getAnimations').mockReturnValue([first.animation])
  view.rerender(<Fixture open={false} />)
  const media = view.getByText('Mounted media')
  view.rerender(<Fixture open />)
  stateWrites.mockClear()
  await act(async () => { first.finish(); await first.animation.finished })
  expect(stateWrites).not.toHaveBeenCalled()
  expect(view.getByText('Mounted media')).toBe(media)
  animations.mockReturnValue([second.animation])
  view.rerender(<Fixture open={false} />)
  expect(view.getByText('Mounted media')).toBe(media)
  await act(async () => { second.finish(); await second.animation.finished })
  expect(view.queryByText('Mounted media')).toBeNull()
})

it('does not write state when a closing transition finishes after unmount', async () => {
  const view = render(<Fixture open />)
  const closing = transition()
  vi.spyOn(view.getByTestId('curtain'), 'getAnimations').mockReturnValue([closing.animation])
  view.rerender(<Fixture open={false} />)
  view.unmount()
  stateWrites.mockClear()
  await act(async () => { closing.finish(); await closing.animation.finished })
  expect(stateWrites).not.toHaveBeenCalled()
})

it('unmounts immediately when reduced-motion CSS leaves no transitions', () => {
  const view = render(<Fixture open />)
  const animations = vi.spyOn(view.getByTestId('curtain'), 'getAnimations').mockReturnValue([])
  view.rerender(<Fixture open={false} />)
  expect(animations).toHaveBeenCalledOnce()
  expect(view.queryByText('Mounted media')).toBeNull()
})
