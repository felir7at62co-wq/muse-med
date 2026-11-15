/** The `sessionActivity` fold over events appended to a real Session. */
import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { createUserMessage, ToolCallId } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import { boundActivityText, initialActivity, sessionActivityProjectionDefinition } from '../src/projection.ts'
import type { SessionActivityState } from '../src/projection.ts'

async function session(): Promise<Session> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  return ctx.sessions.create(SessionId('watched'))
}

function fold(events: readonly SessionEvent[]): SessionActivityState {
  return events.reduce((state, event) => sessionActivityProjectionDefinition.apply(state, event), initialActivity())
}

describe('sessionActivity fold', () => {
  it('keeps the open turn, the latest tool call and the latest turn end', async () => {
    const log = await session()
    const start = log.append('turn/start', { turn: 1 })
    const call = log.append('tool/call', { turn: 1, step: 1, callId: ToolCallId('a'), name: 'video_inspect', arguments: '{\n "path": "ep1.mp4"\n}' })
    expect(fold([start, call])).toEqual({
      openTurn: 1, turnStartedAt: start.time, lastTurnEnd: null,
      lastTool: { name: 'video_inspect', time: call.time, arguments: '{ "path": "ep1.mp4" }' },
    })
    const failed = log.append('turn/end', { turn: 1, reason: { kind: 'error', error: { message: 'Muse model request failed.', code: 'UNKNOWN' } } })
    expect(fold([start, call, failed])).toMatchObject({
      openTurn: null, turnStartedAt: null, lastTurnEnd: { time: failed.time, kind: 'error', text: 'Muse model request failed.' },
    })
    const completed = log.append('turn/end', { turn: 2, reason: { kind: 'completed' } })
    expect(fold([completed]).lastTurnEnd).toEqual({ time: completed.time, kind: 'completed', text: '' })
  })

  it('keeps the reference for events that change no status fact', async () => {
    const log = await session()
    const start = initialActivity()
    const message = log.append('user/message', createUserMessage({ content: [{ type: 'text', text: 'hi' }], source: { kind: 'user' } }), { surfaceOp: 'append' })
    expect(sessionActivityProjectionDefinition.apply(start, message)).toBe(start)
  })

  it('bounds text to one line and validates its persisted state', () => {
    expect(boundActivityText('x'.repeat(400))).toHaveLength(160)
    expect(boundActivityText('abcdef', 4)).toBe('abc…')
    expect(sessionActivityProjectionDefinition.stateSchema.parse(initialActivity())).toEqual(initialActivity())
    expect(() => sessionActivityProjectionDefinition.stateSchema.parse({ ...initialActivity(), openTurn: -1 })).toThrow()
  })
})
