/** Host grant projection replay, visible-context filtering, and plugin disposal. */
import { Context } from '@deepseek-ai/cordis'
import SessionStore, { SessionLogOffset, SessionSeq } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { brandString } from '@deepseek-ai/dsh-brand'
import { expect, it } from 'vitest'
import { captureRefinementAuthorization, refinementUserProjection } from '../src/refinement-auth.ts'
import { sha256 } from '../src/episode.ts'
import type { ActorId } from '../src/ids.ts'

it('captures only actual unchanged visible human text, including cold checkpoint and replay, and cleans up on dispose', async () => {
  const ctx = new Context(); await ctx.plugin(SessionStore); await ctx.plugin(SessionProjectionRegistry)
  const fiber = ctx.plugin((scope) => {
    scope.inject(['sessionProjections'], (inner) => { inner.sessionProjections.register(refinementUserProjection) })
  })
  await fiber
  const session = ctx.sessions.create(), quote = '只允许本集展示调整。', actor = brandString<ActorId>(session.id)
  const human = createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: quote }] })
  const event = session.append('user/message', human, { surfaceOp: 'append' })
  const state = ctx.sessionProjections.stateOf(session, 'screenplayRefinementUsers')!
  expect(state.users).toEqual([{ message_id: human.id, seq: event.seq, message_sha256: sha256(JSON.stringify(human)) }])
  expect(captureRefinementAuthorization(state, session.deriveMessages(), actor, quote, '仅展示。'))
    .toMatchObject({ source: 'user', message_id: human.id, seq: event.seq })
  const checkpoint = ctx.sessionProjections.checkpoint(session)
  expect(JSON.stringify(checkpoint)).not.toContain(quote)
  const restored = ctx.sessionProjections.restore(checkpoint, session.snapshotEvents(),
    SessionLogOffset(0), session.header, SessionLogOffset(0))
  const replayed = refinementUserProjection.stateSchema.parse(restored.checkpoint['screenplayRefinementUsers']!.val)
  expect(captureRefinementAuthorization(replayed, session.deriveMessages(), actor, quote, '仅展示。'))
    .toMatchObject({ message_sha256: sha256(JSON.stringify(human)) })
  const altered = [{ ...human, content: [{ type: 'text' as const, text: `${quote}再允许新事件。` }] }]
  expect(() => captureRefinementAuthorization(state, altered, actor, quote, '模型伪造。')).toThrow('refinement_human_authorization')
  const injected = createUserMessage({ source: { kind: 'system-prompt' }, content: [{ type: 'text', text: quote }] })
  session.append('user/message', injected, { surfaceOp: { op: 'replace', startSeq: event.seq, endSeq: event.seq }, sourceEventSeqs: [event.seq] })
  expect(ctx.sessionProjections.stateOf(session, 'screenplayRefinementUsers')!.users).toHaveLength(1)
  expect(() => captureRefinementAuthorization(state, session.deriveMessages(), actor, quote, '摘要包含原话。')).toThrow('refinement_human_authorization')
  expect(() => captureRefinementAuthorization(state, [human], actor, '', '空引用。')).toThrow('refinement_human_authorization')
  expect(() => captureRefinementAuthorization(state, [], actor, quote, '冷会话无可见原话。')).toThrow('refinement_human_authorization')
  expect(refinementUserProjection.apply(state, { type: 'turn/start', seq: SessionSeq(2), time: 0, data: { turn: 1 } })).toBe(state)
  await fiber.dispose()
  expect(ctx.sessionProjections.stateOf(session, 'screenplayRefinementUsers')).toBeUndefined()
  await ctx.fiber.dispose()
})
