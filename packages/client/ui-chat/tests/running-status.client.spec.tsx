// @vitest-environment jsdom

import { act, cleanup, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { zh as commonZh } from '@deepseek-ai/dsh-client-locale/src/locales/zh.ts'
import { RunningStatus } from '../src/client/chat/RunningStatus.tsx'
import type { RunningPhase } from '../src/client/chat/running-phase.ts'
import { en, zh } from '../src/client/locale.ts'

const t = makeTranslate(zh, commonZh)

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(5_000) })
afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals() })

function statusHarness(startTime?: number, phase: RunningPhase = 'working') {
  const view = render(<RunningStatus startTime={startTime} phase={phase} t={t} />)
  return {
    ...view,
    content: () => view.container.querySelector('[data-chat-running] > :last-child'),
    set: (nextStartTime?: number, nextPhase: RunningPhase = 'working') => {
      view.rerender(<RunningStatus startTime={nextStartTime} phase={nextPhase} t={t} />)
    },
  }
}

describe('RunningStatus', () => {
  it('announces phase changes without resetting the Turn clock or announcing elapsed ticks', () => {
    const view = statusHarness(1_000, 'preparing')
    const status = view.getByRole('status')
    const content = view.content()
    expect(status.textContent).toBe('正在准备请求')
    expect(content?.textContent).toBe('正在准备请求，总用时 4秒 ···')
    act(() => { vi.advanceTimersByTime(2_000) })
    view.set(1_000, 'waiting')
    expect(view.content()).toBe(content)
    expect(view.getByRole('status')).toBe(status)
    expect(status.textContent).toBe('正在等待回复')
    expect(content?.textContent).toBe('正在等待回复，总用时 6秒 ···')
    expect(vi.getTimerCount()).toBe(1)
    view.set(1_000, 'working')
    expect(status.textContent).toBe('深度求索中')
    expect(content?.textContent).toBe('深度求索中，用时 6秒 ···')
  })

  it.each([
    ['preparing', 'Preparing request'],
    ['waiting', 'Waiting for response'],
  ] as const)('localizes the untimed %s phase', (phase, label) => {
    const view = render(<RunningStatus startTime={undefined} phase={phase} t={makeTranslate(en)} />)
    expect(view.getByRole('status').textContent).toBe(label)
    expect(view.container.querySelector('[data-chat-running] > :last-child')?.textContent).toBe(label)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('waits for an open Turn start before allocating its clock', () => {
    const view = statusHarness()
    expect(view.content()?.textContent).toBe('深度求索中')
    expect(vi.getTimerCount()).toBe(0)
    view.set(1_000)
    expect(view.content()?.textContent).toMatch(/^深度求索中，用时 \d+秒 ···$/)
    expect(view.content()?.querySelectorAll('[data-shimmer="true"]')).toHaveLength(1)
    expect(vi.getTimerCount()).toBe(1)
    view.set()
    expect(view.content()?.textContent).toBe('深度求索中')
    expect(vi.getTimerCount()).toBe(0)
  })

  it('keeps the indicator mounted while a continuous run moves to the next Turn', () => {
    const view = statusHarness(1_000)
    const content = view.content()
    const status = view.getByRole('status')
    const initialText = content?.textContent
    act(() => { vi.advanceTimersByTime(2_000) })
    expect(content?.textContent).toMatch(/^深度求索中，用时 \d+秒 ···$/)
    expect(content?.textContent).not.toBe(initialText)
    view.set(7_000)
    expect(view.content()).toBe(content)
    expect(content?.textContent).toMatch(/^深度求索中，用时 \d+秒 ···$/)
    expect(vi.getTimerCount()).toBe(1)
    const nextTurnText = content?.textContent
    act(() => { vi.advanceTimersByTime(2_000) })
    expect(content?.textContent).toMatch(/^深度求索中，用时 \d+秒 ···$/)
    expect(content?.textContent).not.toBe(nextTurnText)
    expect(view.getByRole('status')).toBe(status)
    expect(status.textContent).toBe('深度求索中')
    view.unmount()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('keeps the duration nonnegative when the start is ahead of the local clock', () => {
    const view = statusHarness(6_000)
    expect(view.content()?.textContent).toMatch(/^深度求索中，用时 \d+秒 ···$/)
    expect(view.content()?.textContent).not.toContain('-')
    act(() => { vi.advanceTimersByTime(3_000) })
    expect(view.content()?.textContent).toMatch(/^深度求索中，用时 \d+秒 ···$/)
    expect(view.content()?.textContent).not.toContain('-')
  })

})
