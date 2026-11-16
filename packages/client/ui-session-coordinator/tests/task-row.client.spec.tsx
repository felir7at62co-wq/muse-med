// @vitest-environment jsdom
/** Coordinator badges follow assignment identities and do not alter row navigation. */
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { zh as commonZh } from '@deepseek-ai/dsh-client-locale/src/locales/zh.ts'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { MessageId } from '@deepseek-ai/dsh-llm/brand'
import type { CoordinationTask, CoordinationTaskId } from '@deepseek-ai/dsh-session-coordinator/types'
import type { ResourceSnapshot } from '@deepseek-ai/dsh-client-resources/client'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import { TaskRowStatus } from '../src/client/TaskRowStatus.tsx'
import { zh } from '../src/client/locales.ts'

afterEach(cleanup)

const worker = SessionId('worker-1')
const main = SessionId('main/owner')
const task: CoordinationTask = {
  id: brandString<CoordinationTaskId>('task-1'), owner: main, title: '第二集', createdAt: 1,
  attempts: [{ revision: 1, key: 'first', requestHash: 'a'.repeat(64), instructions: '', reason: '', sourceSeq: 1,
    messageId: brandString<MessageId>('message'), briefId: brandString<MessageId>('brief'), forwardedIds: [],
    noticeId: brandString<MessageId>('notice'), sessionId: worker, createSession: false, cwd: '/worker', sourceCwd: null,
    videoKey: null, status: 'running', issue: null, notifiedStatus: null, report: null }],
}

function props(value: ResourceSnapshot<CoordinationTask[]> = { status: 'live', value: [task], failure: undefined }) {
  return {
    sessionId: worker,
    useCoordinatorMain: <T,>(select: (id: SessionId | null) => T): T => select(main),
    useResource: vi.fn(() => value),
    t: makeTranslate(zh, commonZh),
  } satisfies Parameters<typeof TaskRowStatus>[0]
}

it('uses the owner resource and displays only the exact current execution session', () => {
  const bindings = props()
  const view = render(<TaskRowStatus {...bindings} />)
  expect(bindings.useResource).toHaveBeenCalledWith('dsh-resource://muse-tasks/main%2Fowner')
  expect(screen.getByText('执行中')).toBeTruthy()
  view.rerender(<TaskRowStatus {...bindings} sessionId={SessionId('other')} />)
  expect(view.container.innerHTML).toBe('')
})

it('moves the badge to a retry target and reflects its explicit status, never a session idle flag', () => {
  const retry = { ...task, attempts: [...task.attempts, { ...task.attempts[0]!, sessionId: SessionId('worker-2'), revision: 2, status: 'needs-input' as const }] }
  const bindings = props({ status: 'live', value: [retry], failure: undefined })
  const view = render(<TaskRowStatus {...bindings} />)
  expect(view.container.innerHTML).toBe('')
  view.rerender(<TaskRowStatus {...bindings} sessionId={SessionId('worker-2')} />)
  expect(screen.getByText('需要补充信息')).toBeTruthy()
  expect(screen.queryByText('执行会话已完成')).toBeNull()
})

it('keeps reconciliation visible as work in progress instead of a completed report', () => {
  const reconciling: CoordinationTask = { ...task, attempts: [{ ...task.attempts[0]!, status: 'reconciling' }] }
  const view = render(<TaskRowStatus {...props({ status: 'live', value: [reconciling], failure: undefined })} />)
  expect(screen.getByText('准备核对')).toBeTruthy()
  expect(view.container.querySelector('[data-task-status="reconciling"][data-working]')).toBeTruthy()
  expect(screen.queryByText('执行会话已完成')).toBeNull()
})

it('keeps multiple task statuses available to assistive technology and prioritizes attention', () => {
  const second: CoordinationTask = { ...task, id: brandString<CoordinationTaskId>('task-2'), title: '第三集', createdAt: 2,
    attempts: [{ ...task.attempts[0]!, status: 'blocked' }] }
  render(<TaskRowStatus {...props({ status: 'live', value: [task, second], failure: undefined })} />)
  expect(screen.getByText('遇到阻碍 +1')).toBeTruthy()
  expect(screen.getByText('执行任务: 第三集: 遇到阻碍; 第二集: 执行中')).toBeTruthy()
})

it('hides stale status on failed resource or lost owner access and leaves row clicks intact', () => {
  const bindings = props()
  const open = vi.fn()
  const view = render(<button type="button" onClick={open}><TaskRowStatus {...bindings} /></button>)
  fireEvent.click(screen.getByText('执行中'))
  expect(open).toHaveBeenCalledTimes(1)
  view.rerender(<TaskRowStatus {...props({ status: 'failed', value: [task], failure: undefined })} />)
  expect(view.container.innerHTML).toBe('')
  const withoutOwner = { ...bindings, useCoordinatorMain: <T,>(select: (id: SessionId | null) => T): T => select(null) }
  bindings.useResource.mockClear()
  view.rerender(<TaskRowStatus {...withoutOwner} />)
  expect(view.container.innerHTML).toBe('')
  expect(bindings.useResource).not.toHaveBeenCalled()
})

it('orders tasks of equal priority by newest creation time', () => {
  const newer: CoordinationTask = { ...task, id: brandString<CoordinationTaskId>('task-2'), title: '第三集', createdAt: 2 }
  render(<TaskRowStatus {...props({ status: 'live', value: [task, newer], failure: undefined })} />)
  expect(screen.getByText('执行任务: 第三集: 执行中; 第二集: 执行中')).toBeTruthy()
  expect(screen.getByText('执行中 +1')).toBeTruthy()
})
