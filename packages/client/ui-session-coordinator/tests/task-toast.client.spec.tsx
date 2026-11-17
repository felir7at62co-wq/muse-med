// @vitest-environment jsdom
/** The task toast reports a settled task action outside any task card. */
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { zh as commonZh } from '@deepseek-ai/dsh-client-locale/src/locales/zh.ts'
import { TaskToast, type TaskNotice } from '../src/client/TaskToast.tsx'
import { zh } from '../src/client/locales.ts'

afterEach(cleanup)

function toast(notice: TaskNotice | null, dismiss = vi.fn()) {
  const props = {
    useTaskNotice: <T,>(select: (value: TaskNotice | null) => T): T => select(notice),
    dismiss, t: makeTranslate(zh, commonZh),
  } as Parameters<typeof TaskToast>[0]
  return <TaskToast {...props} />
}

it('renders no overlay while there is no notice', () => {
  const view = render(toast(null))
  expect(screen.queryByRole('alert')).toBeNull()
  expect(view.container.innerHTML).toBe('')
})

it('shows a success notice with the success icon and its localized text', () => {
  render(toast({ seq: 1, key: 'stopRequested', success: true }))
  const alert = screen.getByRole('alert')
  expect(alert.textContent).toBe('已请求停止任务')
  expect(alert.querySelector('span[aria-hidden]')).toBeTruthy()
})

it('shows a failure notice without the success icon and dismisses it when the banner fades', () => {
  vi.useFakeTimers()
  try {
    const dismiss = vi.fn()
    render(toast({ seq: 2, key: 'failedStop', success: false }, dismiss))
    const alert = screen.getByRole('alert')
    expect(alert.textContent).toBe('未能停止此任务')
    expect(alert.querySelector('span[aria-hidden]')).toBeNull()
    vi.runAllTimers()
    expect(dismiss).toHaveBeenCalledOnce()
  } finally { vi.useRealTimers() }
})
