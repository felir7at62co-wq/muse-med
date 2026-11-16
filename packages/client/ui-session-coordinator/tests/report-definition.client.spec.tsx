// @vitest-environment jsdom
/** Report cards remain visible and replayable outside the folded process group. */
import { readFileSync } from 'node:fs'
import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ToolCallId } from '@deepseek-ai/dsh-llm/brand'
import { createToolResultMessage } from '@deepseek-ai/dsh-llm'
import { SessionSeq } from '@deepseek-ai/dsh-session'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import type { SessionEvent } from '@deepseek-ai/dsh-session/types'
import type { SessionListState, SessionLiveEventEntry } from '@deepseek-ai/dsh-api-session-controller/client'
import type { ConversationNodeContext } from '@deepseek-ai/dsh-client-ui-conversation/client'
import { ConversationNodeAssembler } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { ChatNode, ChatSnapshot } from '@deepseek-ai/dsh-client-ui-chat/client'
import { chatViewDefinition } from '@deepseek-ai/dsh-client-ui-chat/src/client/conversation-nodes/chat-snapshot-builder.ts'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { reportDefinition } from '../src/client/report-definition.ts'
import { ReportCardNode } from '../src/client/ReportCard.tsx'
import { zh } from '../src/client/locales.ts'

afterEach(cleanup)

const receipt = { version: 1, owner: 'main', tasks: [{ id: 'task-1', title: '第2集精修', revision: 1, sessionId: 'worker', cwd: '/worker',
  status: 'completed', issue: null, report: { outcome: 'completed', summary: '候选稿已生成，第三集未改', throughSeq: 12,
    files: [{ path: '/worker/candidate.docx' }] } }], total: 1, truncated: false }

function at(seq: number, type: SessionEvent['type'], data: unknown): SessionLiveEventEntry {
  return { type: 'event', event: { seq: SessionSeq(seq), time: seq, type, data } as SessionEvent }
}

function events(turn = 1, start = 1, name = 'coordinator_show_report', meta: unknown = { museCoordinationReport: receipt }, isError = false): SessionLiveEventEntry[] {
  const callId = ToolCallId('reused-by-model')
  return [
    at(start, 'turn/start', { turn }), at(start + 1, 'step/start', { turn, step: 1 }),
    at(start + 2, 'tool/call', { turn, step: 1, name, callId, arguments: '{}' }),
    at(start + 3, 'tool/result', { turn, step: 1, meta,
      message: createToolResultMessage({ callId, isError, content: [{ type: 'text', text: JSON.stringify(receipt) }] }) }),
    at(start + 4, 'step/end', { turn, step: 1 }),
    at(start + 5, 'turn/end', { turn, reason: { kind: 'completed' } }),
  ]
}

function assembler(entries: readonly SessionLiveEventEntry[] = [], hasMore = false): ConversationNodeAssembler {
  const value = new ConversationNodeAssembler({ entries: () => [reportDefinition], fallbackEntry: () => undefined },
    { entries: () => [chatViewDefinition] })
  value.replaceWindow(entries, hasMore)
  value.activateTarget('chat')
  return value
}

function nodes(value: ConversationNodeAssembler): readonly ChatNode<'muse-coordination-report'>[] {
  const snapshot = value.snapshot('chat') as ChatSnapshot
  return snapshot.nodes.values().filter((node): node is ChatNode<'muse-coordination-report'> => node.kind === 'muse-coordination-report')
}

describe('visible report conversation nodes', () => {
  it('publishes a single visible turn-level card from the successful paired tool result', () => {
    const node = nodes(assembler(events()))[0]!
    expect(node.visibility).toBe('visible')
    expect(node.groupTree).toBe('turn')
    expect(node.anchorSeq).toBe(4)
    expect(node.location.kind).toBe('step')
    expect(node.data.block.call?.name).toBe('coordinator_show_report')
    expect(node.data.block.meta).toEqual({ museCoordinationReport: receipt })
    const props: Parameters<typeof ReportCardNode>[0] = { node, sessionId: SessionId('main'),
      useResource: () => ({ status: 'none', value: undefined, failure: undefined }),
      useSessions: <T,>(select: (state: SessionListState) => T): T => select({ ids: [], byId: {}, phase: 'ready', projectionsBySession: {} }),
      t: makeTranslate(zh), openExecution: vi.fn(), openDelivery: vi.fn() }
    const view = render(<ReportCardNode {...props} />)
    expect(view.container.querySelector('[data-muse-coordination-report]')).toBeTruthy()
    expect(view.container.textContent).toContain('候选稿已生成，第三集未改')
    expect(view.container.querySelector('[hidden]')).toBeNull()
    view.rerender(<ReportCardNode {...props} sessionId={SessionId('another-main')} />)
    expect(view.container.innerHTML).toBe('')
  })

  it('reproduces the same card through incremental completion, reload and older history admission', () => {
    const source = events()
    const live = assembler(source.slice(0, 3))
    expect(nodes(live)).toHaveLength(0)
    for (const entry of source.slice(3)) { live.append(entry); live.flush() }
    const replay = assembler(source)
    const paged = assembler(source.slice(3), true)
    expect(nodes(paged)).toHaveLength(0)
    paged.prepend(source.slice(0, 3), false); paged.flush()
    const facts = (value: ConversationNodeAssembler) => nodes(value).map(node => ({ id: node.id, key: node.key,
      anchorSeq: node.anchorSeq, visibility: node.visibility, groupTree: node.groupTree, meta: node.data.block.meta }))
    expect(facts(live)).toEqual(facts(replay))
    expect(facts(paged)).toEqual(facts(replay))
    replay.replaceWindow(source, false); replay.flush()
    expect(nodes(replay)).toHaveLength(1)
  })

  it('keeps separate reports when a model reuses a call id in later turns', () => {
    const current = nodes(assembler([...events(), ...events(2, 10)]))
    expect(current).toHaveLength(2)
    expect(new Set(current.map(node => node.key)).size).toBe(2)
    expect(current.map(node => node.anchorSeq)).toEqual([4, 13])
  })

  it.each([
    ['failed result', 'coordinator_show_report', { museCoordinationReport: receipt }, true],
    ['unsupported metadata', 'coordinator_show_report', { museCoordinationReport: { ...receipt, version: 2 } }, false],
    ['another tool', 'show_view', { museCoordinationReport: receipt }, false],
    ['missing metadata', 'coordinator_show_report', undefined, false],
  ] as const)('does not add a report node for %s', (_label, name, meta, error) => {
    const source = events(1, 1, name, null, error)
    const result = source[3]!
    if (result.event.type !== 'tool/result') throw new Error('fixture requires tool/result')
    const data = { ...result.event.data }
    if (meta === undefined) delete data.meta
    else data.meta = meta
    source[3] = { ...result, event: { ...result.event, data } }
    expect(nodes(assembler(source))).toHaveLength(0)
  })

  it('uses shared card radii, keyboard focus and hover-capable styles', () => {
    const css = readFileSync('packages/client/ui-session-coordinator/src/client/ReportCard.module.css', 'utf8')
    expect(css).toContain('border-radius: var(--dsw-radius-xl)')
    expect(css).toContain('@media (hover: hover)')
    expect(css).toContain('.action:focus-visible')
  })
})

describe('report definition lifecycle guards', () => {
  type State = { argsRaw: string; callTime: number; result: null }
  const context = (state?: State): ConversationNodeContext<State> =>
    ({ key: 'k', kind: 'muse-coordination-report', id: '1:call', matches: [], start: undefined, state, current: new Map() })
  const location = { kind: 'unresolved' } as const

  it('rejects a start match that is not a tool call', () => {
    const { event } = events()[3]!
    expect(() => reportDefinition.start(context(), { event, role: 'start', location }, { previous: () => undefined }))
      .toThrow('report start requires tool/call')
  })

  it('keeps the report state when a tool call, a failed result or an unrecorded result arrives as an update', () => {
    const state = { argsRaw: '{}', callTime: 3, result: null }
    const update = ({ event }: SessionLiveEventEntry): unknown =>
      reportDefinition.update({ ...context(state), state }, { event, role: 'update', location })
    expect(update(events()[2]!)).toBe(state)
    expect(update(events(1, 1, 'coordinator_show_report', { museCoordinationReport: receipt }, true)[3]!)).toBe(state)
    expect(update(events(1, 1, 'coordinator_show_report', {})[3]!)).toBe(state)
  })
})
