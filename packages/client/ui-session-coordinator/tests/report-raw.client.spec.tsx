// @vitest-environment jsdom
/** Reports that are not validated receipts stay inspectable as raw tool disclosures. */
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { zh as commonZh } from '@deepseek-ai/dsh-client-locale/src/locales/zh.ts'
import { PartialArguments } from '@deepseek-ai/dsh-util-values'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { ToolResultNode } from '@deepseek-ai/dsh-client-ui-chat/client'
import type { SessionListState } from '@deepseek-ai/dsh-api-session-controller/client'
import type { CoordinationReport, CoordinationTaskId } from '@deepseek-ai/dsh-session-coordinator/types'
import { ReportCard } from '../src/client/ReportCard.tsx'
import { zh } from '../src/client/locales.ts'

afterEach(cleanup)

type CardProps = Parameters<typeof ReportCard>[0]

const owner = SessionId('main')
const common = {
  toolName: 'coordinator_show_report', sessionId: owner,
  useResource: (() => ({ status: 'none', value: undefined, failure: undefined })) as CardProps['useResource'],
  useSessions: <T,>(select: (state: SessionListState) => T): T => select({ ids: [], byId: {}, phase: 'ready', projectionsBySession: {} }),
  openExecution: vi.fn(), openDelivery: vi.fn(), t: makeTranslate(zh, commonZh),
} satisfies Omit<CardProps, 'phase' | 'block'>

function settled(overrides: Partial<ToolResultNode> = {}): ToolResultNode {
  return { kind: 'tool-result', seq: 10, time: 20, callId: 'call-report', name: 'coordinator_show_report',
    args: PartialArguments.fromText('{}'), call: { name: 'coordinator_show_report', argsRaw: '{}' }, callTime: 19,
    content: [], isError: false, subCalls: [], meta: null, ...overrides }
}

it('shows the dispatched arguments of a report call that has no result yet', () => {
  const block = { phase: 'start' as const, callId: 'call-report', name: 'coordinator_show_report', turn: 1, step: 1, time: 5,
    subCalls: [], args: PartialArguments.fromText('{"limit":3}'), argsRaw: '{"limit":3}' }
  const view = render(<ReportCard {...common} phase="start" block={block} />)
  fireEvent.click(screen.getByText('任务汇报'))
  expect(view.container.querySelector('pre')!.textContent).toBe('{"limit":3}')
})

it('offers nothing to expand while the report call is still being prepared', () => {
  const block = { phase: 'preparing' as const, callId: 'call-report', name: 'coordinator_show_report', turn: 1, step: 1, time: 5,
    subCalls: [], args: PartialArguments.fromText('{"lim') }
  const view = render(<ReportCard {...common} phase="preparing" block={block} />)
  fireEvent.click(screen.getByText('任务汇报'))
  expect(view.container.querySelector('pre')).toBeNull()
})

it('shows non-text result content as JSON and the error name and code of a failed result', () => {
  const content = settled({ call: null, content: [{ type: 'text', text: '无法汇报' }, { type: 'tool-removal', toolName: 'x' }] })
  const view = render(<ReportCard {...common} phase="result" block={content} />)
  fireEvent.click(screen.getByText('任务汇报'))
  expect(view.container.querySelector('pre')!.textContent).toBe('无法汇报\n{"type":"tool-removal","toolName":"x"}')
  const failed = settled({ isError: true, error: { name: 'HarnessError', code: 'coordination/unavailable' } })
  view.rerender(<ReportCard {...common} phase="result" block={failed} />)
  expect(view.container.querySelector('pre')!.textContent).toBe('{}\n\nHarnessError: coordination/unavailable')
})

it('opens the trajectory from a raw report when inspection is available', () => {
  const inspect = vi.fn()
  render(<ReportCard {...common} phase="result" block={settled({ call: null, content: [{ type: 'text', text: 'x' }] })} inspect={inspect} />)
  fireEvent.click(screen.getByText('任务汇报'))
  fireEvent.click(screen.getByRole('button', { name: '查看工具调用' }))
  expect(inspect).toHaveBeenCalledOnce()
})

it('shows the issue recorded for a task in a verified report', () => {
  const task = { id: brandString<CoordinationTaskId>('task-1'), title: '第二集', revision: 1, sessionId: SessionId('worker'),
    cwd: '/worker', status: 'failed' as const, report: null, issue: '下载失败' }
  const receipt: CoordinationReport = { version: 1, owner, tasks: [task], total: 1, truncated: false }
  render(<ReportCard {...common} phase="result" block={settled({ meta: { museCoordinationReport: receipt } })} />)
  expect(screen.getByText('下载失败')).toBeTruthy()
})
