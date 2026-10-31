// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it } from 'vitest'
import type { SessionEventLikeEntry } from '@deepseek-ai/dsh-api-session-controller/client'
import { SessionSeq } from '@deepseek-ai/dsh-session/types'
import { createAssistantMessage, createToolResultMessage, LlmAttemptId, ToolCallId } from '@deepseek-ai/dsh-llm'
import type { StreamChunk } from '@deepseek-ai/dsh-llm'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { zh as commonZh } from '@deepseek-ai/dsh-client-locale/src/locales/zh.ts'
import { ConversationNodeAssembler } from '../../ui-conversation/src/client/conversation/assembler.ts'
import { GenericToolCard, type GenericToolCardProps } from '../../ui-tool/src/client/tool/toolviews/GenericToolCard.tsx'
import { zh as toolZh } from '../../ui-conversation/src/client/locales.ts'
import type { ChatSnapshot } from '../src/client/contract/snapshot.ts'
import type { ChatNode } from '../src/client/contract/chat-nodes.ts'
import { assistantDefinition } from '../src/client/conversation-nodes/assistant.ts'
import { toolDefinition } from '../src/client/conversation-nodes/tool.ts'
import { turnProcessDefinition } from '../src/client/conversation-nodes/turn-process.ts'
import { chatViewDefinition } from '../src/client/conversation-nodes/chat-snapshot-builder.ts'
import { AssistantMarkdown } from '../src/client/chat/AssistantMarkdown.tsx'
import { RunningStatus } from '../src/client/chat/RunningStatus.tsx'
import { runningPhase } from '../src/client/chat/running-phase.ts'
import { useDisclosure } from '../src/client/chat/use-disclosure.ts'
import { useDetailedPresentation } from './presentation-fixture.client.ts'
import { zh } from '../src/client/locale.ts'

const t = makeTranslate(zh, commonZh)
const toolT: GenericToolCardProps['t'] = makeTranslate(toolZh, commonZh)
const callId = ToolCallId('yunying-probe')
const summary = '核对工具返回的固定值。\n\n继续完成回答。'
afterEach(cleanup)

function boundary(seq: number, type: 'turn/start' | 'step/start' | 'step/end', step = 1): SessionEventLikeEntry {
  if (type === 'turn/start') return { type: 'event', event: { seq: SessionSeq(seq), time: seq * 1000, type, data: { turn: 1 } } }
  return { type: 'event', event: { seq: SessionSeq(seq), time: seq * 1000, type, data: { turn: 1, step } } }
}

function chunk(seq: number, value: StreamChunk, step = 1): SessionEventLikeEntry {
  return { type: 'transient', event: { type: 'assistant/live-chunk', seq, time: seq * 1000,
    data: { attemptId: LlmAttemptId(`yunying-${step}`), turn: 1, step, chunk: value } } }
}

function scene() {
  const assembler = new ConversationNodeAssembler(
    { entries: () => [assistantDefinition, toolDefinition, turnProcessDefinition], fallbackEntry: () => undefined },
    { entries: () => [chatViewDefinition] },
  )
  assembler.replaceWindow([boundary(1, 'turn/start'), boundary(2, 'step/start')], false)
  assembler.activateTarget('chat')
  const snapshot = (): ChatSnapshot => { assembler.flush(); return assembler.snapshot('chat') as ChatSnapshot }
  return { assembler, snapshot }
}

function Stage({ snapshot }: { snapshot: ChatSnapshot }) {
  const open = snapshot.timeline.turns.get(1)?.status === 'open'
  return <>
    {open && <RunningStatus startTime={undefined} phase={runningPhase(snapshot.timeline)} t={t} />}
    {[...snapshot.nodes.values()].map((value) => {
      const node = value as ChatNode
      if (node.kind === 'assistant-step') return <AssistantMarkdown key={node.key}
        blocks={node.data.blocks} streaming={node.data.status === 'running'} useDisclosure={useDisclosure}
        usePresentation={useDetailedPresentation} renderMessageImages={() => null} t={t} />
      if (node.kind !== 'tool-call') return null
      const block = node.data.root
      const common = {
        callId: block.callId, toolName: block.name, useDisclosure, t: toolT,
        openFile: () => undefined,
        loadImage: async () => { throw new Error('No images in this fixture') },
      }
      if ('kind' in block) return <GenericToolCard key={node.key} {...common} phase="result" block={block} />
      if (block.phase === 'start') return <GenericToolCard key={node.key} {...common} phase="start" block={block} />
      return <GenericToolCard key={node.key} {...common} phase="preparing" block={block} />
    })}
  </>
}

it.each(['gpt-6.1-sol', 'gemini-3.1-pro'])('renders %s summary, tool settlement, and the resumed response from stream events', (model) => {
  const test = scene()
  const view = render(<Stage snapshot={test.snapshot()} />)
  expect(screen.getByRole('status').textContent).toBe('正在等待模型回复')
  expect(view.container.querySelector('[data-variant="think"]')).toBeNull()

  test.assembler.append(chunk(2.1, { type: 'reasoning-delta', index: 0, text: summary }))
  view.rerender(<Stage snapshot={test.snapshot()} />)
  expect(screen.getByRole('status').textContent).toBe('正在接收思考摘要')
  expect(screen.getByText('核对工具返回的固定值。')).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: /思考/ }))
  expect(screen.getByText('继续完成回答。')).toBeTruthy()

  test.assembler.append(chunk(2.2, { type: 'tool-call-delta', index: 1, id: callId,
    name: 'probe_value', argumentsDelta: '{"value":17}' }))
  test.assembler.append({ type: 'event', event: {
    seq: SessionSeq(3), time: 3000, type: 'assistant/message', surfaceOp: 'append',
    data: { turn: 1, step: 1, stream: [], message: createAssistantMessage({ source: { provider: 'muse-cloud-yunying', model },
      content: [{ type: 'reasoning', text: summary }, { type: 'tool-call', id: callId, name: 'probe_value', arguments: '{"value":17}' }] }) },
  } })
  test.assembler.append({ type: 'event', event: { seq: SessionSeq(4), time: 4000, type: 'tool/call',
    data: { turn: 1, step: 1, callId, name: 'probe_value', arguments: '{"value":17}' } } })
  view.rerender(<Stage snapshot={test.snapshot()} />)
  expect(view.container.querySelector('[data-tool="probe_value"]')).not.toBeNull()
  expect(view.container.querySelector('[data-state="running"]')).not.toBeNull()

  test.assembler.append({ type: 'event', event: { seq: SessionSeq(5), time: 5000, type: 'tool/result', surfaceOp: 'append',
    data: { turn: 1, step: 1, message: createToolResultMessage({ callId, isError: false, content: [{ type: 'text', text: '17' }] }) } } })
  test.assembler.append(boundary(6, 'step/end'))
  test.assembler.append(boundary(7, 'step/start', 2))
  view.rerender(<Stage snapshot={test.snapshot()} />)
  expect(screen.getByRole('status').textContent).toBe('正在等待模型回复')
  const settled = view.container.querySelector('[data-tool="probe_value"]')
  expect(settled?.getAttribute('data-state')).toBe('ok')
  fireEvent.click(screen.getByRole('button', { name: /工具调用/ }))
  expect(screen.getByText('17')).toBeTruthy()

  test.assembler.append(chunk(7.1, { type: 'text-delta', index: 0, text: '工具返回的数值是 17。' }, 2))
  view.rerender(<Stage snapshot={test.snapshot()} />)
  expect(screen.getByRole('status').textContent).toBe('正在接收回复')
  expect(screen.getByText('工具返回的数值是 17。')).toBeTruthy()
  expect(view.container.querySelectorAll('[data-variant="think"]')).toHaveLength(1)
  test.assembler.append({ type: 'event', event: {
    seq: SessionSeq(8), time: 8000, type: 'assistant/message', surfaceOp: 'append',
    data: { turn: 1, step: 2, stream: [], message: createAssistantMessage({ source: { provider: 'muse-cloud-yunying', model },
      content: [{ type: 'text', text: '工具返回的数值是 17。' }] }) },
  } })
  test.assembler.append(boundary(9, 'step/end', 2))
  test.assembler.append({ type: 'event', event: { seq: SessionSeq(10), time: 10000, type: 'turn/end',
    data: { turn: 1, reason: { kind: 'completed' } } } })
  view.rerender(<Stage snapshot={test.snapshot()} />)
  expect(screen.queryByRole('status')).toBeNull()
  expect(screen.getByText('工具返回的数值是 17。')).toBeTruthy()
  expect(view.container.querySelector('[data-tool="probe_value"]')?.getAttribute('data-state')).toBe('ok')
})

it('shows waiting and direct text without inventing a reasoning summary', () => {
  const test = scene()
  test.assembler.append(chunk(2.1, { type: 'reasoning-delta', index: 0, text: '  ' }))
  const view = render(<Stage snapshot={test.snapshot()} />)
  expect(screen.getByRole('status').textContent).toBe('正在等待模型回复')
  test.assembler.append(chunk(2.2, { type: 'text-delta', index: 1, text: '直接返回的回答。' }))
  view.rerender(<Stage snapshot={test.snapshot()} />)
  expect(screen.getByRole('status').textContent).toBe('正在接收回复')
  expect(screen.getByText('直接返回的回答。')).toBeTruthy()
  expect(view.container.querySelector('[data-state="running"][data-variant="think"]')).toBeNull()
})
