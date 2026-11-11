/** Managed child questions settle before the parent reports completion. */
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { parseSessionLog } from '@deepseek-ai/dsh-llm-replay'
import { expect } from 'vitest'

function textOf(content: readonly ContentBlock[]): string {
  return content.flatMap(block => block.type === 'text' ? [block.text] : []).join('')
}

/**
 * Check real asynchronous delegation and the child interaction refusal before comparing writer oracles.
 * @param logs - Complete parent-first persisted Session logs from the finished CLI process.
 */
export function assertAsyncChildQuestion(logs: readonly {
  readonly content: string
  readonly header: Readonly<Record<string, unknown>>
}[]): void {
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
  expect(replies.map(reply => reply.text)).toEqual(['PARENT_WAITING', 'PARENT_COMPLETED'])
  const [waiting, completed] = replies
  const firstTurnEnd = events.find(event => event.type === 'turn/end' && event.data.turn === 1)
  const notices = events.filter(event => event.type === 'user/message' && event.data.source.kind === 'subagent-settled')
  expect(notices).toHaveLength(1)
  const notice = notices[0]
  if (waiting === undefined || completed === undefined || firstTurnEnd === undefined || notice?.type !== 'user/message') {
    throw new Error('Incomplete asynchronous child question continuation')
  }
  expect(notice.data.source).toMatchObject({ kind: 'subagent-settled', senderSessionId: child.header.id })
  expect(textOf(notice.data.content)).toContain('UNRESOLVED: Should deployment use the CUDA fallback?')
  expect(waiting.event.data.turn).toBe(1)
  expect(completed.event.data.turn).toBe(2)
  expect(events.filter(event => event.type === 'turn/start').map(event => event.data.turn)).toEqual([1, 2])
  expect(call.seq).toBeLessThan(result.seq)
  expect(result.seq).toBeLessThan(waiting.event.seq)
  expect(waiting.event.seq).toBeLessThan(firstTurnEnd.seq)
  expect(firstTurnEnd.seq).toBeLessThan(notice.seq)
  expect(notice.seq).toBeLessThan(completed.event.seq)
  expect(childEvents.filter(event => event.type === 'tool/call').map(event => event.data.name)).toEqual(['ask_user_question'])
  const question = childEvents.find(event => event.type === 'tool/result')
  if (question?.type !== 'tool/result') throw new Error('Missing child interaction refusal')
  expect(question.data.message.isError).toBe(true)
  expect(textOf(question.data.message.content)).toContain('human interaction is unavailable')
  expect(childEvents.filter(event => event.type === 'assistant/message')
    .flatMap(event => event.data.message.content).filter(block => block.type === 'text').map(block => block.text))
    .toEqual(['UNRESOLVED: Should deployment use the CUDA fallback?'])
}
