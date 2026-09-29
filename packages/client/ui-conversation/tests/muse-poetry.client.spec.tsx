// @vitest-environment jsdom
import { act, cleanup, render } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { zh as commonZh } from '@deepseek-ai/dsh-client-locale/src/locales/zh.ts'
import { zh } from '../src/client/locales.ts'
import { HeroShell, type HeroShellProps } from '../src/client/skeleton/EmptyHero.tsx'

afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals() })

function mount(reduced = false) {
  vi.useFakeTimers()
  vi.stubGlobal('dshDesktop', { productName: 'muse-med' })
  const media = new EventTarget()
  Object.assign(media, { matches: reduced })
  vi.stubGlobal('matchMedia', () => media)
  const renderSlot = vi.fn<HeroShellProps['renderSlot']>(() => null)
  const view = render(<HeroShell t={makeTranslate(zh, commonZh)} renderSlot={renderSlot} />)
  return { ...view, media }
}

it('types, pauses, erases, and advances through the web poetry without the preview badge', () => {
  const view = mount()
  expect(view.queryByText('探索未至之境')).toBeNull()
  expect(view.queryByText('预览版')).toBeNull()
  const line = view.container.querySelector('[data-muse-poetry-line]')!
  expect(line.textContent).toBe('')
  act(() => vi.advanceTimersByTime(550))
  expect(line.textContent).toBe('你')
  const verse = '你站在桥上看风景，'
  act(() => vi.advanceTimersByTime((Array.from(verse).length - 1) * 105))
  expect(line.textContent).toBe(verse)
  act(() => vi.advanceTimersByTime(3200))
  expect(line.textContent).toBe('你站在桥上看风景')
  act(() => vi.advanceTimersByTime(Array.from(verse).length * 45 + 550))
  expect(line.textContent).toBe('看')
  view.unmount()
  expect(vi.getTimerCount()).toBe(0)
})

it('shows a complete static verse and responds to reduced-motion changes', () => {
  const view = mount(true)
  const line = view.container.querySelector('[data-muse-poetry-line]')!
  expect(line.textContent).toBe('你站在桥上看风景，')
  expect(vi.getTimerCount()).toBe(0)
  expect(view.container.querySelector('[data-muse-caret]')).toBeNull()
  expect(view.container.firstChild).toMatchSnapshot()
  act(() => { Object.assign(view.media, { matches: false }); view.media.dispatchEvent(new Event('change')) })
  act(() => vi.advanceTimersByTime(550))
  expect(line.textContent).toBe('你')
  view.unmount()
  expect(vi.getTimerCount()).toBe(0)
})
