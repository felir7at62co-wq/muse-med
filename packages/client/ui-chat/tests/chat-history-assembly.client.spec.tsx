// @vitest-environment jsdom
/** Deferred history consumption through the assembled Session and Chat registrations. */
import { expect, vi } from 'vitest'
import { createClientTest, webApp } from '@deepseek-ai/dsh-client-test-runtime/src/assembly/index.ts'
import { SESSION_FORMAT_VERSION, type SessionId } from '@deepseek-ai/dsh-session/types'
import type { SessionFollowFrame, SessionHistoryRecord } from '@deepseek-ai/dsh-api-session-controller/types'
import type { ChatViewInjected } from '../src/client/contract/slots.ts'

const SID = 'chat-history' as SessionId
const PAGE = 'session/page'
const it = createClientTest({ roster: webApp.closure(['@deepseek-ai/dsh-client-ui-chat']) })

function turnRecords(startSeq: number, turn: number, text: string): readonly SessionHistoryRecord[] {
  return [
    { type: 'event', event: { type: 'turn/start', seq: startSeq, time: startSeq, data: { turn } } },
    { type: 'event', event: { type: 'user/message', seq: startSeq + 1, time: startSeq + 1,
      surfaceOp: 'append', data: { id: `history-user-${turn}`, role: 'user',
        content: [{ type: 'text', text }], source: { kind: 'user' } } } },
    { type: 'event', event: { type: 'turn/end', seq: startSeq + 2, time: startSeq + 2,
      data: { turn, reason: { kind: 'completed' } } } },
  ]
}

it('keeps an older page buffered until Chat consumes it without requesting the page twice', async ({ mock, start }) => {
  const older = turnRecords(0, 0, 'Earlier question')
  const newer = turnRecords(3, 1, 'Latest question')
  mock.remote.session.list.mockResolvedValue({ ok: true, value: { items: [{
    sessionId: SID, updatedAt: 1, running: false, blank: false, agentAvailable: true,
  }] } })
  const opening: SessionFollowFrame = {
    type: 'snapshot',
    header: { version: SESSION_FORMAT_VERSION, id: SID, createdAt: 0, isSeeded: false },
    cursor: 5, records: newer, hasMore: true,
    projections: { asOfSeq: 5, values: {} }, assistantStream: { revision: 0 },
  }
  mock.stream('session/follow', (_args, stream) => { stream.push(opening) })
  mock.remote.session.page.mockResolvedValue({ ok: true, value: { cursor: 2, records: older, hasMore: false } })

  const client = await start()
  using reference = client.ctx.sessions.retain(SID, { source: 'mainView' })
  const binding = await reference.ready
  const conversation = client.ctx.uiConversation.binding(binding)
  conversation.activate('chat')
  const chat = conversation.target('chat')
  const entry = client.ctx.slots.entries('conversation.view').find(row => row.options.id === 'chat')
  if (entry?.inject === undefined) throw new Error('Chat view injection is unavailable')
  const view = Reflect.apply(entry.inject, undefined, [SID]) as ChatViewInjected
  const eventSeqs = () => binding.eventSource.getSnapshot().entries.map(entry => entry.event.seq)
  const chatSeqs = () => chat.getSnapshot()?.nodes.values().map(node => node.anchorSeq)

  expect(chatSeqs()).toContain(4)
  view.loadOlder()
  await vi.waitFor(() => {
    expect(binding.session.getSnapshot().historyLoadStatus).toBe('pendingConsumption')
  })
  expect(eventSeqs()).toEqual(newer.map(record => record.event.seq))
  expect(chatSeqs()).not.toContain(1)
  expect(mock.log.requests(PAGE)).toHaveLength(1)

  expect(view.consumeOlder()).toBe(true)
  expect(eventSeqs()).toEqual([...older, ...newer].map(record => record.event.seq))
  await vi.waitFor(() => {
    expect(chatSeqs()).toContain(1)
    expect(chatSeqs()).toContain(4)
  })
  expect(binding.session.getSnapshot()).toMatchObject({ historyLoadStatus: 'idle', hasMore: false })
  expect(view.consumeOlder()).toBe(false)
  expect(mock.log.requests(PAGE)).toHaveLength(1)
})
