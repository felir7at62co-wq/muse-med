// @vitest-environment jsdom
/** Task-card behavior keeps worker identity, revision and native UI isolation. */
import { render, screen, fireEvent, cleanup, act } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { zh as commonZh } from '@deepseek-ai/dsh-client-locale/src/locales/zh.ts'
import { MainEntry } from '../src/client/MainEntry.tsx'
import { TaskCards } from '../src/client/TaskCards.tsx'
import { zh } from '../src/client/locales.ts'
import type { MessageId } from '@deepseek-ai/dsh-llm/brand'
import type { CoordinationTask, CoordinationTaskId } from '@deepseek-ai/dsh-session-coordinator/types'
import type { SessionListState } from '@deepseek-ai/dsh-api-session-controller/client'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import { brandString } from '@deepseek-ai/dsh-brand'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'

afterEach(cleanup)

const task: CoordinationTask = {
  id: brandString<CoordinationTaskId>('task-1'), owner: SessionId('main'), title: '修改第二集', createdAt: 1,
  attempts: [{ revision: 3, key: 'revision-3', requestHash: 'a'.repeat(64), instructions: '原文不动', reason: '复用已有项目', sourceSeq: 5,
    messageId: brandString<MessageId>('message-1'), briefId: brandString<MessageId>('brief-1'),
    forwardedIds: [brandString<MessageId>('message-1')], noticeId: brandString<MessageId>('notice-1'), sessionId: SessionId('worker-1'),
    createSession: false, cwd: '/worker', sourceCwd: '/main', videoKey: null, status: 'completed', issue: null, notifiedStatus: 'completed',
    report: { outcome: 'completed', summary: '已交付第二集候选稿', files: [{ path: '/worker/candidate.docx' }], throughSeq: 20 },
  }],
}

function props(preset = 'main-session', value = task, workerListed = true) {
  const worker = { id: SessionId('worker-1'), displayTitle: 'Worker', running: false, retainedBy: {}, blank: false, updatedAt: 1 }
  const sessions: SessionListState = { ids: [SessionId('main'), ...workerListed ? [worker.id] : []], byId: { [SessionId('main')]: {
    id: SessionId('main'), displayTitle: 'Main', running: false, retainedBy: {}, blank: false, updatedAt: 1,
    projectionValues: { agentPreset: preset },
  }, ...workerListed ? { [worker.id]: worker } : {} }, phase: 'ready', projectionsBySession: {} }
  const useSessions = <T,>(select: (state: SessionListState) => T): T => select(sessions)
  const useResource = vi.fn(() => ({ status: 'live' as const, value: [value], failure: undefined }))
  return {
    sessionId: SessionId('main'), activeView: 'chat', useSessions, useResource,
    openSession: vi.fn(), stop: vi.fn(async () => {}), openFile: vi.fn(async () => {}),
    t: makeTranslate(zh, commonZh),
  } satisfies Parameters<typeof TaskCards>[0]
}

it('leaves ordinary conversations unchanged', () => {
  const view = render(<TaskCards {...props('short-drama')} />)
  expect(view.container.innerHTML).toBe('')
})

it('hides task overlays outside the chat view', () => {
  const view = render(<TaskCards {...props()} activeView="trajectory" />)
  expect(view.container.innerHTML).toBe('')
})

it('shows worker completion separately from acceptance and opens its native source chat and file', () => {
  const actions = props()
  const view = render(<TaskCards {...actions} />)
  expect(screen.getByText('执行会话已完成')).toBeTruthy()
  fireEvent.click(view.container.querySelector('summary')!)
  expect(screen.getByText('执行会话回执，等待你验收')).toBeTruthy()
  fireEvent.click(screen.getByText('打开执行会话'))
  expect(actions.openSession).toHaveBeenCalledWith(SessionId('worker-1'))
  fireEvent.click(screen.getByText('candidate.docx'))
  expect(actions.openFile).toHaveBeenCalledWith('/worker/candidate.docx')
  expect(screen.queryByText('停止任务')).toBeNull()
})

it('offers no execution chat for a waiting task whose worker does not exist yet', () => {
  const waiting = { ...task, attempts: [{ ...task.attempts[0]!, status: 'dispatching' as const, createSession: true, report: null, notifiedStatus: null }] }
  const view = render(<TaskCards {...props('main-session', waiting, false)} />)
  fireEvent.click(view.container.querySelector('summary')!)
  expect(screen.getByText('等待开始')).toBeTruthy()
  expect(screen.getByText('停止任务')).toBeTruthy()
  expect(screen.queryByText('打开执行会话')).toBeNull()
})

it('shows an unattended attention mark with its reason', () => {
  const marked = { ...task, attempts: [{ ...task.attempts[0]!, status: 'failed' as const,
    report: { outcome: 'failed' as const, summary: '下载失败', files: [], throughSeq: 20 }, attention: { reason: 'failed: 下载失败', at: 2 } }] }
  const view = render(<TaskCards {...props('main-session', marked)} />)
  fireEvent.click(view.container.querySelector('summary')!)
  expect(screen.getByText('需要人工处理：自动处理已停止')).toBeTruthy()
  expect(screen.getByText('failed: 下载失败')).toBeTruthy()
  expect(view.container.querySelectorAll('[data-coordination-attention]')).toHaveLength(1)
})

it('opens task details and dismisses them with Escape or an outside click', () => {
  const view = render(<TaskCards {...props()} />)
  const bubble = view.container.querySelector('details')!
  const summary = bubble.querySelector('summary')!
  fireEvent.click(summary)
  expect(bubble.open).toBe(true)
  fireEvent.keyDown(document, { key: 'Escape' })
  expect(bubble.open).toBe(false)
  expect(document.activeElement).toBe(summary)
  fireEvent.click(summary)
  fireEvent.pointerDown(document.body)
  expect(bubble.open).toBe(false)
})

it('stops exactly the selected task revision while keeping stopping visible until the Host settles', async () => {
  const current = { ...task, attempts: [{ ...task.attempts[0]!, status: 'running' as const, report: null, notifiedStatus: null }] }
  const actions = props('main-session', current)
  const view = render(<TaskCards {...actions} />)
  expect(view.container.querySelector('[data-working]')).toBeTruthy()
  fireEvent.click(view.container.querySelector('summary')!)
  fireEvent.click(screen.getByText('停止任务'))
  expect(actions.stop).toHaveBeenCalledWith(SessionId('main'), task.id, 3)
  view.rerender(<TaskCards {...props('main-session', { ...current, attempts: [{ ...current.attempts[0]!, status: 'stopping' }] })} />)
  expect(screen.getByText('正在停止')).toBeTruthy()
  expect(screen.queryByText('已停止')).toBeNull()
})

it('shows the dedicated Muse entry for owners and hides it when coordination is unavailable', async () => {
  const openMain = vi.fn(async () => {})
  const t = makeTranslate(zh, commonZh)
  const view = render(<MainEntry wide openMain={openMain} t={t} useRemoteAccess={() => true} />)
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Muse 主会话' })) })
  expect(openMain).toHaveBeenCalledTimes(1)
  view.rerender(<MainEntry wide openMain={openMain} t={t} useRemoteAccess={() => false} />)
  expect(screen.queryByRole('button', { name: 'Muse 主会话' })).toBeNull()
})

it('renders no card for a task that has no execution attempt yet', () => {
  const view = render(<TaskCards {...props('main-session', { ...task, attempts: [] })} />)
  expect(view.container.querySelector('[data-muse-coordination-cards]')).toBeTruthy()
  expect(view.container.querySelector('[data-coordination-task]')).toBeNull()
})

it('keeps task details open for other keys and presses inside, and ignores presses while closed', () => {
  const view = render(<TaskCards {...props()} />)
  const bubble = view.container.querySelector('details')!
  const summary = bubble.querySelector('summary')!
  fireEvent.keyDown(document, { key: 'Escape' })
  fireEvent.pointerDown(document.body)
  expect(bubble.open).toBe(false)
  fireEvent.click(summary)
  fireEvent.keyDown(document, { key: 'a' })
  fireEvent.pointerDown(summary)
  expect(bubble.open).toBe(true)
})

it('sends one stop request when the stop button is pressed twice before the Host settles', async () => {
  const current = { ...task, attempts: [{ ...task.attempts[0]!, status: 'running' as const, report: null, notifiedStatus: null }] }
  const actions = props('main-session', current)
  const settle = Promise.withResolvers<undefined>()
  actions.stop.mockReturnValue(settle.promise)
  const view = render(<TaskCards {...actions} />)
  fireEvent.click(view.container.querySelector('summary')!)
  const button = screen.getByText('停止任务') as HTMLButtonElement
  act(() => { fireEvent.click(button); fireEvent.click(button) })
  expect(actions.stop).toHaveBeenCalledTimes(1)
  expect(button.disabled).toBe(true)
  await act(async () => { settle.resolve(undefined) })
  expect(button.disabled).toBe(false)
})

it('shows the recorded issue of a failed attempt under diagnostics', () => {
  const failed = { ...task, attempts: [{ ...task.attempts[0]!, status: 'failed' as const, report: null, issue: '磁盘空间不足' }] }
  const view = render(<TaskCards {...props('main-session', failed)} />)
  fireEvent.click(view.container.querySelector('summary')!)
  expect(screen.getByText('请先检查执行会话，再决定如何续做')).toBeTruthy()
  expect(screen.getByText('磁盘空间不足')).toBeTruthy()
})

it('renders nothing while no task has been read and no read has failed', () => {
  const bindings = { ...props(), useResource: () => ({ status: 'none' as const, value: undefined, failure: undefined }) }
  expect(render(<TaskCards {...bindings} />).container.innerHTML).toBe('')
  const empty = { ...props(), useResource: () => ({ status: 'live' as const, value: [], failure: undefined }) }
  expect(render(<TaskCards {...empty} />).container.innerHTML).toBe('')
})

it('reports a failed task read even when there are no cards to show', () => {
  const bindings = { ...props(), useResource: () => ({ status: 'failed' as const, value: undefined,
    failure: new RemoteError('gateway/internal', 'unavailable', {}) }) }
  render(<TaskCards {...bindings} />)
  expect(screen.getByRole('alert').textContent).toBe('暂时无法读取任务状态')
})

it('shows the compact Muse entry in the sidebar rail without a visible label', () => {
  const view = render(<MainEntry wide={false} openMain={async () => {}} t={makeTranslate(zh, commonZh)} useRemoteAccess={() => true} />)
  const entry = screen.getByRole('button', { name: 'Muse 主会话' })
  expect(entry.textContent).toBe('')
  view.rerender(<MainEntry wide openMain={async () => {}} t={makeTranslate(zh, commonZh)} useRemoteAccess={() => true} />)
  expect(entry.textContent).toBe('Muse 主会话')
})

it('opens the Muse main conversation once when the entry is pressed twice before it settles', async () => {
  const settle = Promise.withResolvers<undefined>()
  const openMain = vi.fn(() => settle.promise)
  render(<MainEntry wide openMain={openMain} t={makeTranslate(zh, commonZh)} useRemoteAccess={() => true} />)
  const entry = screen.getByRole('button', { name: 'Muse 主会话' }) as HTMLButtonElement
  act(() => { fireEvent.click(entry); fireEvent.click(entry) })
  expect(openMain).toHaveBeenCalledTimes(1)
  expect(entry.disabled).toBe(true)
  await act(async () => { settle.resolve(undefined) })
  expect(entry.disabled).toBe(false)
})
