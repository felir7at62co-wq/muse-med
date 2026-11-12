// @vitest-environment jsdom
/** Report replay keeps assignment identity and worker-owned delivery paths. */
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { zh as commonZh } from '@deepseek-ai/dsh-client-locale/src/locales/zh.ts'
import { PartialArguments } from '@deepseek-ai/dsh-util-values'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import { brandString } from '@deepseek-ai/dsh-brand'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import type { ToolResultNode } from '@deepseek-ai/dsh-client-ui-chat/client'
import type { ResourceSnapshot } from '@deepseek-ai/dsh-client-resources/client'
import type { Assignment, CoordinationReport, CoordinationTask, CoordinationTaskId, ReportTask } from '@deepseek-ai/dsh-session-coordinator/types'
import type { MessageId } from '@deepseek-ai/dsh-llm/brand'
import { ReportCard } from '../src/client/ReportCard.tsx'
import { reportCardModel, reportDisplay } from '../src/client/report-model.ts'
import { zh } from '../src/client/locales.ts'

afterEach(cleanup)

const owner = SessionId('main')
const task: ReportTask = { id: brandString<CoordinationTaskId>('task-1'), title: '修改第二集，第三集原文不动', revision: 3,
  sessionId: SessionId('worker'), cwd: '/worker', status: 'running', report: null, issue: null }
const receipt: CoordinationReport = { version: 1, owner, tasks: [task], total: 1, truncated: false }
const delivery = { outcome: 'completed' as const, summary: '已交付第二集候选稿，原文保留', files: [{ path: 'candidate.docx' }], throughSeq: 12 }
const recorded: CoordinationReport = { ...receipt, tasks: [{ ...task, status: 'completed', report: delivery }] }
const offline: ResourceSnapshot<CoordinationTask[]> = { status: 'none', value: undefined, failure: undefined }

function settled(meta: unknown = { museCoordinationReport: receipt }, overrides: Partial<ToolResultNode> = {}): ToolResultNode {
  return { kind: 'tool-result', seq: 10, time: 20, callId: 'call-report', name: 'coordinator_show_report',
    args: PartialArguments.fromText('{}'), call: { name: 'coordinator_show_report', argsRaw: '{}' }, callTime: 19,
    content: [{ type: 'text', text: JSON.stringify(receipt) }], isError: false, subCalls: [], meta, ...overrides }
}

function props(block = settled(), resource = offline): Extract<Parameters<typeof ReportCard>[0], { phase: 'result' }> {
  return { phase: 'result', block, toolName: 'coordinator_show_report', sessionId: owner,
    useResource: (() => resource) as Parameters<typeof ReportCard>[0]['useResource'],
    openExecution: vi.fn(), openDelivery: vi.fn(), t: makeTranslate(zh, commonZh) }
}

function current(overrides: Partial<Assignment> = {}): CoordinationTask {
  const id = brandString<MessageId>('message')
  return { id: task.id, owner, title: task.title, createdAt: 1, attempts: [{ revision: task.revision,
    sessionId: task.sessionId, cwd: task.cwd, status: 'completed', report: delivery, issue: null,
    key: 'key', requestHash: 'hash', instructions: '第三集原文不动', reason: '修改第二集', sourceSeq: 1,
    messageId: id, briefId: id, forwardedIds: [id], noticeId: id, notifiedStatus: 'completed',
    sourceCwd: '/main', videoKey: null, createSession: false, ...overrides }] }
}

describe('report receipt admission', () => {
  it('replays complete tool metadata without a live coordinator', () => {
    const block = settled(JSON.parse(JSON.stringify({ museCoordinationReport: recorded })))
    expect(reportCardModel(props(block))).toEqual(recorded)
    render(<ReportCard {...props(block)} />)
    expect(screen.getByText('历史回执')).toBeTruthy()
    expect(screen.getByText(delivery.summary)).toBeTruthy()
    expect(screen.getByText('执行会话回执，等待你验收')).toBeTruthy()
  })

  it.each([
    undefined, null, {}, { museCoordinationReport: null },
    { museCoordinationReport: { ...receipt, version: 2 } },
    { museCoordinationReport: { ...receipt, owner: 'another-main' } },
    { museCoordinationReport: { ...receipt, tasks: [{ ...task, revision: 0 }] } },
    { museCoordinationReport: { ...receipt, tasks: [{ ...task, cwd: '' }] } },
    { museCoordinationReport: { ...receipt, tasks: [{ ...task, status: 'made-up' }] } },
    { museCoordinationReport: { ...receipt, tasks: [{ ...task, report: { ...delivery, files: [{ path: 5 }] } }] } },
    { museCoordinationReport: { ...receipt, tasks: [task, task], total: 2 } },
    { museCoordinationReport: { ...receipt, total: 3, truncated: false } },
  ])('retains a raw result for unsupported or malformed metadata: %j', (meta) => {
    const block = settled(null, { meta })
    expect(reportCardModel(props(block))).toBeNull()
    const view = render(<ReportCard {...props(block)} />)
    expect(view.container.querySelector('[data-muse-coordination-report]')).toBeNull()
    expect(view.container.querySelector('[data-report-fallback]')).toBeTruthy()
    fireEvent.click(screen.getByText('任务汇报'))
    expect(view.container.textContent).toContain(JSON.stringify(receipt))
  })

  it.each([{ isError: true }, { parentCallId: 'ptc-call' }, { call: null }])('does not promote error, nested or unpaired results to reports: %j', (overrides) => {
    expect(reportCardModel(props(settled(undefined, overrides)))).toBeNull()
  })

  it('shows partial counts and an empty report without inventing completed work', () => {
    const block = settled({ museCoordinationReport: { ...receipt, total: 5, truncated: true } })
    const view = render(<ReportCard {...props(block)} />)
    expect(screen.getByText('显示 1 项，共 5 项任务')).toBeTruthy()
    view.rerender(<ReportCard {...props(settled({ museCoordinationReport: { ...receipt, tasks: [], total: 0 } }))} />)
    expect(screen.getByText('本次汇报没有任务')).toBeTruthy()
    expect(screen.queryByText('执行会话已完成')).toBeNull()
  })
})

describe('exact revision observations', () => {
  it('updates a running receipt with the same assignment and opens files in the worker directory', () => {
    const actions = props(settled(), { status: 'live', value: [current()], failure: undefined })
    render(<ReportCard {...actions} />)
    expect(screen.getByText('当前状态')).toBeTruthy()
    expect(screen.getByText('第 3 次执行')).toBeTruthy()
    expect(screen.getByText('执行会话已完成')).toBeTruthy()
    fireEvent.click(screen.getByText('打开执行会话'))
    expect(actions.openExecution).toHaveBeenCalledWith(task.sessionId)
    fireEvent.click(screen.getByText('candidate.docx'))
    expect(actions.openDelivery).toHaveBeenCalledWith(task.sessionId, '/worker', 'candidate.docx')
    expect(screen.queryByText('停止任务')).toBeNull()
  })

  it.each([
    { revision: 4, sessionId: SessionId('later-worker') },
    { sessionId: SessionId('other-worker') },
    { cwd: '/another-directory' },
  ])('keeps the old revision instead of following changed identity: %j', (overrides) => {
    const resource = { status: 'live' as const, value: [current(overrides)], failure: undefined }
    expect(reportDisplay(task, owner, resource)).toEqual({ task, live: false })
    render(<ReportCard {...props(settled(), resource)} />)
    expect(screen.getByText('历史回执')).toBeTruthy()
    expect(screen.getByText('执行中')).toBeTruthy()
    expect(screen.queryByText(delivery.summary)).toBeNull()
    expect(screen.queryByText('candidate.docx')).toBeNull()
  })

  it('does not expose another owner task with the same id', () => {
    expect(reportDisplay(task, owner, { status: 'live', value: [{ ...current(), owner: SessionId('other') }], failure: undefined })).toEqual({ task, live: false })
  })

  it('falls back to its saved receipt after a live stream fails', () => {
    const actions = props(settled({ museCoordinationReport: recorded }), { status: 'live', value: [current()], failure: undefined })
    const view = render(<ReportCard {...actions} />)
    view.rerender(<ReportCard {...props(settled({ museCoordinationReport: recorded }), { status: 'failed', value: [current({ revision: 4 })],
      failure: new RemoteError('gateway/internal', 'unavailable', {}) })} />)
    expect(screen.getByText('暂时无法更新状态，显示汇报时保存的回执')).toBeTruthy()
    expect(screen.getByText('历史回执')).toBeTruthy()
    expect(screen.getByText(delivery.summary)).toBeTruthy()
  })

  it('renders long titles, multiline summaries and HTML as text', () => {
    const unsafe = { ...recorded, tasks: [{ ...recorded.tasks[0]!, title: '<script>throw Error()</script>'.repeat(8),
      report: { ...delivery, summary: '<img src=x onerror=throw()>\n第二行' } }] }
    const view = render(<ReportCard {...props(settled({ museCoordinationReport: unsafe }))} />)
    expect(view.container.querySelector('script,img')).toBeNull()
    expect(view.container.textContent).toContain('<img src=x onerror=throw()>')
  })
})
