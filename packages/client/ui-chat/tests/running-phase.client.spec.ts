import { describe, expect, it } from 'vitest'
import type { SessionEventLikeEntry } from '@deepseek-ai/dsh-api-session-controller/client'
import type { ChatSnapshot } from '../src/client/contract/snapshot.ts'
import { ConversationNodeAssembler } from '../../ui-conversation/src/client/conversation/assembler.ts'
import { assistantDefinition } from '../src/client/conversation-nodes/assistant.ts'
import { turnProcessDefinition } from '../src/client/conversation-nodes/turn-process.ts'
import { chatViewDefinition } from '../src/client/conversation-nodes/chat-snapshot-builder.ts'
import { runningPhase } from '../src/client/chat/running-phase.ts'
import { SessionSeq } from '@deepseek-ai/dsh-session/types'
import { LlmAttemptId, ToolCallId } from '@deepseek-ai/dsh-llm/brand'
import type { StreamChunk } from '@deepseek-ai/dsh-llm'

function boundary(seq: number, type: 'turn/start' | 'step/start' | 'step/end', turn = 1): SessionEventLikeEntry {
  if (type === 'turn/start') return { type: 'event', event: { seq: SessionSeq(seq), time: seq * 1000, type, data: { turn } } }
  return { type: 'event', event: { seq: SessionSeq(seq), time: seq * 1000, type, data: { turn, step: 1 } } }
}

function end(seq: number, turn = 1): SessionEventLikeEntry {
  return { type: 'event', event: {
    seq: SessionSeq(seq), time: seq * 1000, type: 'turn/end', data: { turn, reason: { kind: 'aborted', reason: { kind: 'user' } } },
  } }
}

function chunk(seq: number, value: StreamChunk): SessionEventLikeEntry {
  return { type: 'transient', event: {
    type: 'assistant/live-chunk', seq, time: seq * 1000,
    data: { attemptId: LlmAttemptId('attempt'), turn: 1, step: 1, chunk: value },
  } }
}

function assembly(entries: readonly SessionEventLikeEntry[] = [], hasMore = false) {
  const assembler = new ConversationNodeAssembler(
    { entries: () => [assistantDefinition, turnProcessDefinition], fallbackEntry: () => undefined },
    { entries: () => [chatViewDefinition] },
  )
  assembler.replaceWindow(entries, hasMore)
  assembler.activateTarget('chat')
  const phase = () => {
    assembler.flush()
    return runningPhase((assembler.snapshot('chat') as ChatSnapshot).timeline)
  }
  return { assembler, phase }
}

describe('running phase from the Chat timeline', () => {
  it('moves from initial preparation to the admitted request and then reasoning', () => {
    const { assembler, phase } = assembly()
    expect(phase()).toBe('working')
    assembler.append(boundary(1, 'turn/start'))
    expect(phase()).toBe('preparing')
    assembler.append(boundary(2, 'step/start'))
    expect(phase()).toBe('waiting')
    assembler.append(chunk(2.5, { type: 'block-start', index: 0, blockType: 'reasoning' }))
    expect(phase()).toBe('waiting')
    assembler.append(chunk(2.6, { type: 'reasoning-delta', index: 0, text: 'Checking the request' }))
    expect(phase()).toBe('reasoning')
  })

  it.each<{ value: StreamChunk; expected: string }>([
    { value: { type: 'text-delta', index: 0, text: 'Hello' }, expected: 'responding' },
    { value: { type: 'tool-call-delta', index: 0, id: ToolCallId('call'), name: 'read', argumentsDelta: '{}' }, expected: 'working' },
  ])('shows $expected after a visible chunk', ({ value, expected }) => {
    const { assembler, phase } = assembly([boundary(1, 'turn/start'), boundary(2, 'step/start')])
    assembler.append(chunk(2.5, value))
    expect(phase()).toBe(expected)
    assembler.append(boundary(3, 'step/end'))
    expect(phase()).toBe('working')
  })

  it('waits on the next step instead of reusing the preceding reasoning', () => {
    const { assembler, phase } = assembly([boundary(1, 'turn/start'), boundary(2, 'step/start')])
    assembler.append(chunk(2.5, { type: 'reasoning-delta', index: 0, text: 'A visible summary' }))
    expect(phase()).toBe('reasoning')
    assembler.append(boundary(3, 'step/end'))
    assembler.append({ type: 'event', event: {
      seq: SessionSeq(4), time: 4_000, type: 'step/start', data: { turn: 1, step: 2 },
    } })
    expect(phase()).toBe('waiting')
  })

  it('does not invent a reasoning phase for an empty block', () => {
    const { assembler, phase } = assembly([boundary(1, 'turn/start'), boundary(2, 'step/start')])
    assembler.append(chunk(2.5, { type: 'reasoning-delta', index: 0, text: '  ' }))
    expect(phase()).toBe('waiting')
    assembler.append(chunk(2.6, { type: 'text-delta', index: 1, text: 'Answer' }))
    expect(phase()).toBe('responding')
  })

  it('clears preparation on cancellation and starts it afresh on another Turn', () => {
    const { assembler, phase } = assembly([boundary(1, 'turn/start')])
    expect(phase()).toBe('preparing')
    assembler.append(end(2))
    expect(phase()).toBe('working')
    assembler.append(boundary(3, 'turn/start', 2))
    expect(phase()).toBe('preparing')
    assembler.append(boundary(4, 'step/start', 2))
    expect(phase()).toBe('waiting')
    assembler.append(end(5, 2))
    expect(phase()).toBe('working')
  })

  it.each([
    { entries: [boundary(1, 'turn/start')], phase: 'preparing' },
    { entries: [boundary(1, 'turn/start'), boundary(2, 'step/start')], phase: 'waiting' },
    { entries: [boundary(1, 'turn/start'), boundary(2, 'step/start'), end(3)], phase: 'working' },
    { entries: [boundary(2, 'step/start')], phase: 'working' },
  ])('restores $phase from a replacement window without a local phase cache', ({ entries, phase }) => {
    const restored = assembly(entries, true)
    expect(restored.phase()).toBe(phase)
    restored.assembler.replaceWindow([boundary(5, 'turn/start', 2)], false)
    expect(restored.phase()).toBe('preparing')
  })
})
