/** Managed child outcomes settle before the parent reports completion. */
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { parseSessionLog } from '@deepseek-ai/dsh-llm-replay'
import { expect } from 'vitest'

function textOf(content: readonly ContentBlock[]): string {
  return content.flatMap(block => block.type === 'text' ? [block.text] : []).join('')
}

interface ManagedChildLog {
  readonly content: string
  readonly header: Readonly<Record<string, unknown>>
}

/**
 * Check a real managed acknowledgement and a resumed parent after the child's completion notice.
 * @param logs - Complete parent-first persisted Session logs from the finished CLI process.
 * @param completedText - Unique parent completion answer expected in the second turn.
 * @param noticeText - Child output that must be delivered by the real completion notice.
 * @returns Parsed child events for the scenario-specific outcome checks.
 */
function assertManagedChild(logs: readonly ManagedChildLog[], completedText: string, noticeText: string): ReturnType<typeof parseSessionLog> {
  expect(logs).toHaveLength(2)
  const [parent, child] = logs
  if (parent === undefined || child === undefined) throw new Error('Missing parent or child question Session')
  expect(child.header.parentSession).toBe(parent.header.id)
  const events = parseSessionLog(parent.content)
  const childEvents = parseSessionLog(child.content)
  const calls = events.filter(event => event.type === 'tool/call')
  expect(calls.map(event => event.data.name)).toEqual(['subagent'])
  const call = calls[0]
  if (call === undefined) throw new Error('Missing managed delegation call')
  expect(call.data).toMatchObject({ turn: 1, step: 1 })
  expect(JSON.parse(call.data.arguments)).not.toHaveProperty('run_in_background')
  const result = events.find(event => event.type === 'tool/result' && event.data.message.toolCallId === call.data.callId)
  if (result?.type !== 'tool/result') throw new Error('Missing managed delegation acknowledgement')
  expect(result.data).toMatchObject({ turn: 1, step: 1 })
  expect(result.data.message.isError).toBe(false)
  expect(textOf(result.data.message.content)).toBe(`started subagent ${String(child.header.id)}`)
  expect(events.filter(event => event.type === 'subagent/catalog')).toContainEqual(expect.objectContaining({
    data: expect.objectContaining({ childId: child.header.id, mode: 'continuable' }),
  }))
  const replies = events.filter(event => event.type === 'assistant/message')
    .map(event => ({ event, text: textOf(event.data.message.content) })).filter(reply => reply.text !== '')
  expect(replies.map(reply => reply.text), 'parent waits for child terminal notice before completion').toEqual(['PARENT_WAITING', completedText])
  const [waiting, completed] = replies
  const firstTurnEnd = events.find(event => event.type === 'turn/end' && event.data.turn === 1)
  const notices = events.filter(event => event.type === 'user/message' && event.data.source.kind === 'subagent-settled')
  expect(notices).toHaveLength(1)
  const notice = notices[0]
  if (waiting === undefined || completed === undefined || firstTurnEnd === undefined || notice?.type !== 'user/message') {
    throw new Error('Incomplete asynchronous child question continuation')
  }
  expect(notice.data.source).toMatchObject({ kind: 'subagent-settled', senderSessionId: child.header.id })
  expect(textOf(notice.data.content)).toContain(noticeText)
  expect(waiting.event.data.turn).toBe(1)
  expect(completed.event.data.turn).toBe(2)
  expect(events.filter(event => event.type === 'turn/start').map(event => event.data.turn)).toEqual([1, 2])
  expect(call.seq).toBeLessThan(result.seq)
  expect(result.seq).toBeLessThan(waiting.event.seq)
  expect(waiting.event.seq).toBeLessThan(firstTurnEnd.seq)
  expect(firstTurnEnd.seq).toBeLessThan(notice.seq)
  expect(notice.seq).toBeLessThan(completed.event.seq)
  return childEvents
}

/**
 * Check real asynchronous delegation and the child interaction refusal before comparing writer oracles.
 * @param logs - Complete parent-first persisted Session logs from the finished CLI process.
 */
export function assertAsyncChildQuestion(logs: readonly ManagedChildLog[]): void {
  const childEvents = assertManagedChild(logs, 'PARENT_COMPLETED', 'UNRESOLVED: Should deployment use the CUDA fallback?')
  expect(childEvents.filter(event => event.type === 'tool/call').map(event => event.data.name)).toEqual(['ask_user_question'])
  const question = childEvents.find(event => event.type === 'tool/result')
  if (question?.type !== 'tool/result') throw new Error('Missing child interaction refusal')
  expect(question.data.message.isError).toBe(true)
  expect(textOf(question.data.message.content)).toContain('human interaction is unavailable')
  expect(childEvents.filter(event => event.type === 'assistant/message')
    .flatMap(event => event.data.message.content).filter(block => block.type === 'text').map(block => block.text))
    .toEqual(['UNRESOLVED: Should deployment use the CUDA fallback?'])
}

/**
 * Keep partial output and child tool refusal observable before the parent reports completion.
 * @param logs - Complete parent-first persisted Session logs from the finished CLI process.
 * @param outcome - Owned child outcome exercised by the replay.
 */
export function assertAsyncChildOutcome(logs: readonly ManagedChildLog[], outcome: 'partial' | 'filtered'): void {
  const childEvents = assertManagedChild(logs, 'PARENT_DONE', outcome === 'partial' ? 'partial one' : 'CHILD_OK')
  expect(childEvents.filter(event => event.type === 'tool/call').map(event => event.data.name))
    .toEqual([outcome === 'partial' ? 'todo_write' : 'write'])
  const result = childEvents.find(event => event.type === 'tool/result')
  if (result?.type !== 'tool/result') throw new Error('Missing child outcome result')
  const end = childEvents.findLast(event => event.type === 'turn/end')
  if (end?.type !== 'turn/end') throw new Error('Missing durable child turn end')
  if (outcome === 'partial') {
    expect(result.data.message.isError).toBe(false)
    expect(JSON.parse(textOf(result.data.message.content))).toMatchObject({
      todos: [{ content: 'keep going', status: 'in_progress' }],
    })
    expect(end.data.reason.kind).toBe('max-tokens')
  } else {
    expect(result.data.message.isError).toBe(true)
    expect(textOf(result.data.message.content)).toBe('Error: unknown tool "write"')
    expect(end.data.reason.kind).toBe('completed')
  }
}

/**
 * Check reviewer preset capabilities and its real completed child before the parent finishes.
 * @param logs - Complete parent-first persisted Session logs from the finished CLI process.
 */
export function assertAsyncChildPreset(logs: readonly ManagedChildLog[]): void {
  const childEvents = assertManagedChild(logs, 'PARENT_DONE', 'CHILD_OK')
  const [parent, child] = logs
  if (parent === undefined || child === undefined) throw new Error('Missing reviewer parent or child Session')
  expect(child.header.agentPreset).toBe('reviewer')
  const call = parseSessionLog(parent.content).find(event => event.type === 'tool/call')
  if (call?.type !== 'tool/call') throw new Error('Missing reviewer delegation call')
  expect(JSON.parse(call.data.arguments).agent_preset).toBe('reviewer')
  const initial = childEvents.find(event => event.type === 'request/header')
  if (initial?.type !== 'request/header') throw new Error('Missing reviewer tool definitions')
  expect(initial.data.header.tools?.map(tool => tool.name)).toEqual(expect.arrayContaining(['read', 'write', 'reviewer_delegate']))
  expect(childEvents.filter(event => event.type === 'tool/call')).toEqual([])
  expect(childEvents.filter(event => event.type === 'assistant/message')
    .map(event => textOf(event.data.message.content))).toEqual(['CHILD_OK'])
  const end = childEvents.findLast(event => event.type === 'turn/end')
  if (end?.type !== 'turn/end') throw new Error('Missing reviewer child turn end')
  expect(end.data.reason.kind).toBe('completed')
}

/**
 * Check a child preset cannot inherit its parent's messaging or file tools before completion.
 * @param logs - Complete parent-first persisted Session logs from the finished CLI process.
 */
export function assertAsyncChildWithoutMessageTool(logs: readonly ManagedChildLog[]): void {
  assertAsyncChildOutcome(logs, 'filtered')
  const child = logs[1]
  if (child === undefined) throw new Error('Missing isolated child Session')
  expect(child.header.agentPreset).toBe('child')
  const childEvents = parseSessionLog(child.content)
  const initial = childEvents.find(event => event.type === 'request/header')
  if (initial?.type !== 'request/header') throw new Error('Missing child preset tool definitions')
  const names = initial.data.header.tools?.map(tool => tool.name) ?? []
  expect(names).not.toContain('send_message')
  expect(names).not.toContain('write')
  expect(names).not.toContain('web_fetch')
}
