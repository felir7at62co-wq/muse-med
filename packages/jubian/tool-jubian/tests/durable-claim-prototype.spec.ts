/** Isolated proposed claim journal: this is not registered by the production AgentLoop. */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { createUserMessage, type UserMessage } from '@deepseek-ai/dsh-llm'
import Sessions, { KNOWN_SESSION_EVENT_TYPES, Session, SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import * as Jsonl from '../../../session/session-persistence-jsonl/src/index.ts'
import { expect, it } from 'vitest'

declare module '@deepseek-ai/dsh-session' {
  interface SessionEventMap {
    'prototype/claim': { turn: number; nextStep: readonly string[]; nextTurn: readonly string[] }
    'prototype/finish': { turn: number; discarded: readonly string[] }
  }
}

/** Fold complete authoritative messages; only this throwaway prototype knows these events. */
function recover(events: readonly SessionEvent[]) {
  const queues: Record<'next-step' | 'next-turn', UserMessage[]> = { 'next-step': [], 'next-turn': [] }
  let claimed: { turn: number; steps: UserMessage[]; turns: UserMessage[] } | undefined
  for (const event of events) {
    if (event.type === 'agent/inbox/spliced') {
      const { target, start, removedCount, inserted } = event.data
      queues[target].splice(start, removedCount ?? 0, ...inserted)
    } else if (event.type === 'prototype/claim') {
      if (claimed !== undefined) throw new Error('in-flight claim exists')
      const { turn, nextStep, nextTurn } = event.data
      if (JSON.stringify(queues['next-step'].slice(0, nextStep.length).map(message => message.id)) !== JSON.stringify(nextStep)
        || JSON.stringify(queues['next-turn'].slice(0, nextTurn.length).map(message => message.id)) !== JSON.stringify(nextTurn)) {
        throw new Error('claim no longer matches queues')
      }
      claimed = { turn, steps: queues['next-step'].splice(0, nextStep.length), turns: queues['next-turn'].splice(0, nextTurn.length) }
    } else if (event.type === 'user/message' && claimed !== undefined) {
      claimed.steps = claimed.steps.filter(message => message.id !== event.data.id)
      claimed.turns = claimed.turns.filter(message => message.id !== event.data.id)
    } else if (event.type === 'prototype/finish') {
      if (claimed === undefined || claimed.turn !== event.data.turn) throw new Error('unknown claim')
      const dropped = new Set(event.data.discarded)
      queues['next-step'].unshift(...claimed.steps.filter(message => !dropped.has(message.id)))
      queues['next-turn'].unshift(...claimed.turns.filter(message => !dropped.has(message.id)))
      claimed = undefined
    }
  }
  if (claimed !== undefined) {
    queues['next-step'].unshift(...claimed.steps)
    queues['next-turn'].unshift(...claimed.turns)
  }
  return queues
}

it('prototypes ordered partial-commit recovery through actual Session JSONL', async () => {
  const root = await mkdtemp(join(tmpdir(), 'muse-claim-prototype-'))
  const known = KNOWN_SESSION_EVENT_TYPES
  if (!(known instanceof Set)) throw new Error('test needs isolated known-event instrumentation')
  known.add('prototype/claim')
  known.add('prototype/finish')
  const contexts: Context[] = []
  try {
    const open = async () => {
      const ctx = new Context()
      contexts.push(ctx)
      await ctx.plugin(Sessions)
      await ctx.plugin(Jsonl, { root, compression: 'none' })
      return ctx
    }
    const first = await open()
    const id = SessionId('claim-prototype')
    const session = first.sessions.create(id)
    const a = createUserMessage({ content: [{ type: 'text', text: 'first' }], source: { kind: 'user' } })
    const b = createUserMessage({ content: [{ type: 'text', text: 'second' }], source: { kind: 'user' } })
    const c = createUserMessage({ content: [{ type: 'text', text: 'turn' }], source: { kind: 'user' } })
    session.append('agent/inbox/spliced', { target: 'next-step', start: 0, inserted: [a, b] })
    session.append('agent/inbox/spliced', { target: 'next-turn', start: 0, inserted: [c] })
    session.append('turn/start', { turn: 1 })
    session.append('prototype/claim', { turn: 1, nextStep: [a.id, b.id], nextTurn: [c.id] })
    session.append('step/start', { turn: 1, step: 1 })
    session.append('user/message', a, { surfaceOp: 'append' })
    session.append('step/end', { turn: 1, step: 1 })
    session.append('turn/end', { turn: 1, reason: { kind: 'aborted', reason: { kind: 'disposed' } } })
    const writer = await first.sessionPersistence.create(session.header)
    try { await writer.append(session.snapshotEvents()); await writer.flush() } finally { await writer.close() }
    await first.fiber.dispose()
    contexts.pop()
    const second = await open()
    known.delete('prototype/claim')
    await expect(second.sessionPersistence.open(id, 'read')).rejects.toThrow(/unsupported|unknown|newer/iu)
    known.add('prototype/claim')
    const restored = await second.sessionPersistence.open(id, 'read')
    try {
      const { events } = await restored.read()
      const queues = recover(events)
      expect(queues['next-step'].map(message => message.id)).toEqual([b.id])
      expect(queues['next-turn'].map(message => message.id)).toEqual([c.id])
      expect(events.filter(event => event.type === 'user/message' && event.data.id === a.id)).toHaveLength(1)
    } finally { await restored.close() }
  } finally {
    for (const ctx of contexts.reverse()) await ctx.fiber.dispose()
    known.delete('prototype/claim')
    known.delete('prototype/finish')
    await rm(root, { recursive: true, force: true })
  }
}, 20_000)


it('prototypes explicit filtering and preserves later concurrent queue insertions', () => {
  const session = Session.create(SessionId('claim-filter-prototype'))
  const make = (text: string) => createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })
  const first = make('first'), discarded = make('discarded'), last = make('turn'), laterStep = make('later step'), laterTurn = make('later turn')
  session.append('agent/inbox/spliced', { target: 'next-step', start: 0, inserted: [first, discarded] })
  session.append('agent/inbox/spliced', { target: 'next-turn', start: 0, inserted: [last] })
  session.append('prototype/claim', { turn: 1, nextStep: [first.id, discarded.id], nextTurn: [last.id] })
  session.append('agent/inbox/spliced', { target: 'next-step', start: 0, inserted: [laterStep] })
  session.append('agent/inbox/spliced', { target: 'next-turn', start: 0, inserted: [laterTurn] })
  session.append('prototype/finish', { turn: 1, discarded: [discarded.id] })
  const queues = recover(session.snapshotEvents())
  expect(queues['next-step'].map(message => message.id)).toEqual([first.id, laterStep.id])
  expect(queues['next-turn'].map(message => message.id)).toEqual([last.id, laterTurn.id])
})

it('prototypes recovering a claim after the Session writer stops before turn end', async () => {
  const root = await mkdtemp(join(tmpdir(), 'muse-claim-crash-prototype-'))
  const known = KNOWN_SESSION_EVENT_TYPES
  if (!(known instanceof Set)) throw new Error('test needs isolated known-event instrumentation')
  known.add('prototype/claim')
  const ctx = new Context()
  try {
    await ctx.plugin(Sessions)
    await ctx.plugin(Jsonl, { root, compression: 'none' })
    const session = ctx.sessions.create(SessionId('claim-crash-prototype'))
    const message = createUserMessage({ content: [{ type: 'text', text: 'queued before the crash' }], source: { kind: 'user' } })
    session.append('agent/inbox/spliced', { target: 'next-turn', start: 0, inserted: [message] })
    session.append('turn/start', { turn: 1 })
    session.append('prototype/claim', { turn: 1, nextStep: [], nextTurn: [message.id] })
    const writer = await ctx.sessionPersistence.create(session.header)
    try { await writer.append(session.snapshotEvents()); await writer.flush() } finally { await writer.close() }
    const reader = await ctx.sessionPersistence.open(session.id, 'read')
    try {
      const { events } = await reader.read()
      expect(recover(events)['next-turn'].map(item => item.id)).toEqual([message.id])
    } finally { await reader.close() }
  } finally {
    await ctx.fiber.dispose()
    known.delete('prototype/claim')
    await rm(root, { recursive: true, force: true })
  }
}, 20_000)
