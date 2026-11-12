import { unsupportedModel } from '@deepseek-ai/dsh-agent-loop-testkit'
import { Context } from '@deepseek-ai/cordis'
import { agentEvents, type Agent } from '@deepseek-ai/dsh-agent'
import { createUserMessage, freezeMessage } from '@deepseek-ai/dsh-llm'
import SessionStore, { Session, SessionId } from '@deepseek-ai/dsh-session'
import type { TurnEndReason, UserMessage } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import { describe, expect, it, onTestFinished } from 'vitest'
import { inboxProjectionDefinition, ReactLoopInbox } from '../src/inbox.ts'

function unsupportedInbox(): Agent['inbox'] {
  const rejectMutation = (): never => {
    throw new Error('this test Agent does not support Inbox mutations')
  }
  return {
    nextTurn: [], nextStep: [], clear: rejectMutation, append: rejectMutation,
    prepend: rejectMutation, replace: rejectMutation, remove: rejectMutation, splice: rejectMutation,
  }
}

function stubAgent(rawId: string, overrides: Partial<Agent> = {}): Agent {
  const id = SessionId(rawId)
  const session = overrides.session ?? Session.create(id)
  const ctx = overrides.ctx ?? new Context()
  return {
    id,
    options: {},
    session,
    model: unsupportedModel(),
    inbox: unsupportedInbox(),
    status: 'idle',
    ctx,
    send: () => {},
    followup: () => {},
    steer: () => {},
    inject: () => {},
    cancel() {},
    runMaintenance: task => task(new AbortController().signal),
    whenIdle: () => Promise.resolve(),
    ...overrides,
  }
}

async function inboxAgent(rawId: string): Promise<{
  ctx: Context
  session: Session
  agent: Agent
  inbox: ReactLoopInbox
}> {
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  const projection = await ctx.sessionProjections.register(inboxProjectionDefinition)
  const session = ctx.sessions.create(SessionId(rawId))
  const agent = stubAgent(rawId, { ctx, session })
  const inbox = new ReactLoopInbox(() => projection.stateOf(session), session, agentEvents(ctx, agent))
  Object.assign(agent, { inbox })
  return { ctx, session, agent, inbox }
}

async function reconstructPersistedInbox(
  rawId: string,
  populate: (session: Session) => void,
): Promise<Error> {
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  await ctx.plugin(SessionStore)
  const session = ctx.sessions.create(SessionId(rawId))
  populate(session)
  await ctx.plugin(SessionProjectionRegistry)
  const projection = await ctx.sessionProjections.register(inboxProjectionDefinition)
  const agent = stubAgent(rawId, { ctx, session })
  const inbox = new ReactLoopInbox(() => projection.stateOf(session), session, agentEvents(ctx, agent))
  try {
    void inbox.nextTurn
  } catch (error: unknown) {
    if (error instanceof Error) return error
    throw error
  }
  throw new Error('persisted inbox reconstruction unexpectedly succeeded')
}

describe('ReactLoopInbox', () => {
  it('validates pending messages as JSON on the wire and preserves their contents', async () => {
    const { ctx, session, inbox } = await inboxAgent('inbox-wire-json')
    const message = createUserMessage({ content: [{ type: 'text', text: '待处理的消息' }], source: { kind: 'user' } })
    inbox.append('next-turn', message)
    const pending = inbox.nextTurn[0]
    const wire = ctx.sessionProjections.snapshot(session).values.inbox
    expect(wire).toEqual({ 'next-turn': [JSON.parse(JSON.stringify(message))], 'next-step': [] })
    expect(inboxProjectionDefinition.wire.viewSchema.parse(wire)).toEqual(wire)
    expect(inboxProjectionDefinition.wire.viewSchema.safeParse({ 'next-turn': [() => {}], 'next-step': [] }).success).toBe(false)
    expect(inbox.nextTurn[0]).toBe(pending)
  })

  it('preserves complete JSON messages and replay metadata in both pending wire lists and legacy views', async () => {
    const { ctx, session, inbox } = await inboxAgent('inbox-wire-json-fields')
    const source = { kind: 'model' as const, provider: 'historical', model: 'retained',
      replayState: { response: { id: 'private-replay', flags: [true, null, 3] }, blocks: ['text-meta'] },
      producerMetadata: { nested: ['future', { preserved: true }] } }
    const queued = { ...createUserMessage({ content: [{ type: 'text', text: 'queued' }], source }),
      futureMessageMetadata: { attribution: ['one', 'two'] } }
    const steered = createUserMessage({ content: [{ type: 'text', text: 'steer' }], source })
    inbox.append('next-turn', queued)
    inbox.append('next-step', steered)
    const legacyWire = { 'next-turn': [queued], 'next-step': [steered] }
    expect(ctx.sessionProjections.snapshot(session).values.inbox).toEqual(legacyWire)
    expect(inboxProjectionDefinition.wire.viewSchema.parse(legacyWire)).toEqual(legacyWire)
    session.append('turn/start', { turn: 1 })
    inbox.claimDurably('next-turn', 1, 1)
    const claimedWire = { 'next-turn': [], 'next-step': [],
      activeClaim: { turn: 1, step: 1, nextStep: [steered.id], nextTurn: [queued.id] } }
    expect(ctx.sessionProjections.snapshot(session).values.inbox).toEqual(claimedWire)
    expect(inboxProjectionDefinition.wire.viewSchema.parse(claimedWire)).toEqual(claimedWire)
  })

  it('omits absent claims from JSON wire views', () => {
    const pending = { 'next-turn': [], 'next-step': [] }
    const view = inboxProjectionDefinition.wire.viewSchema.parse({ ...pending, activeClaim: undefined })
    expect(view).toEqual(pending)
    expect(Object.hasOwn(view, 'activeClaim')).toBe(false)
  })

  it('rejects non-JSON values at the inbox wire boundary without projecting lossy replacements', () => {
    for (const replayState of [undefined, Number.NaN, () => 'not JSON']) {
      const message = { ...createUserMessage({ content: [{ type: 'text', text: 'invalid' }], source: { kind: 'user' } }),
        source: { kind: 'model', provider: 'historical', model: 'retained', replayState } }
      for (const target of ['next-turn', 'next-step'] as const) {
        expect(inboxProjectionDefinition.wire.viewSchema.safeParse({ 'next-turn': [], 'next-step': [], [target]: [message] }).success)
          .toBe(false)
      }
    }
  })

  it.each(['active', 'step-id', 'step-count', 'turn-id', 'turn-count'] as const)(
    'rejects a persisted %s claim instead of losing pending input', async (kind) => {
      const steered = createUserMessage({ content: [{ type: 'text', text: 'step' }], source: { kind: 'user' } })
      const queued = createUserMessage({ content: [{ type: 'text', text: 'turn' }], source: { kind: 'user' } })
      const error = await reconstructPersistedInbox(`inbox-invalid-claim-${kind}`, (session) => {
        session.append('agent/inbox/spliced', { target: 'next-step', start: 0, inserted: [steered] })
        session.append('agent/inbox/spliced', { target: 'next-turn', start: 0, inserted: [queued] })
        const nextStep = kind === 'step-id' ? [queued.id] : kind === 'step-count' ? [steered.id, queued.id] : [steered.id]
        const nextTurn = kind === 'turn-id' ? [steered.id] : kind === 'turn-count' ? [queued.id, steered.id] : [queued.id]
        session.append('agent/inbox/claim', { turn: 1, step: 1, nextStep, nextTurn })
        if (kind === 'active') session.append('agent/inbox/claim', { turn: 1, step: 2, nextStep: [], nextTurn: [] })
      })
      expect(error.message).toBe(kind === 'active' ? 'a durable inbox claim is already active' : 'durable inbox claim does not match pending messages')
    },
  )

  it.each(['absent', 'turn', 'step', 'duplicate', 'unknown'] as const)(
    'rejects persisted claim filtering with %s ownership', async (kind) => {
      const message = createUserMessage({ content: [{ type: 'text', text: 'pending' }], source: { kind: 'user' } })
      const other = createUserMessage({ content: [{ type: 'text', text: 'other' }], source: { kind: 'user' } })
      const error = await reconstructPersistedInbox(`inbox-invalid-filter-${kind}`, (session) => {
        session.append('agent/inbox/spliced', { target: 'next-step', start: 0, inserted: [message] })
        if (kind !== 'absent') session.append('agent/inbox/claim', { turn: 1, step: 1, nextStep: [message.id], nextTurn: [] })
        session.append('agent/inbox/claim-filtered', {
          turn: kind === 'turn' ? 2 : 1, step: kind === 'step' ? 2 : 1,
          discarded: kind === 'duplicate' ? [message.id, message.id] : [other.id],
        })
      })
      expect(error.message).toBe(kind === 'duplicate' || kind === 'unknown' ? 'invalid durable inbox claim discard' : 'unknown durable inbox claim')
    },
  )

  it.each(['absent', 'turn', 'step', 'pending-step', 'pending-turn'] as const)(
    'rejects persisted settlement of an %s claim', async (kind) => {
      const message = createUserMessage({ content: [{ type: 'text', text: 'pending' }], source: { kind: 'user' } })
      const error = await reconstructPersistedInbox(`inbox-invalid-settle-${kind}`, (session) => {
        if (kind === 'pending-step' || kind === 'pending-turn') {
          session.append('agent/inbox/spliced', { target: kind === 'pending-step' ? 'next-step' : 'next-turn', start: 0, inserted: [message] })
        }
        if (kind !== 'absent') session.append('agent/inbox/claim', { turn: 1, step: 1,
          nextStep: kind === 'pending-step' ? [message.id] : [], nextTurn: kind === 'pending-turn' ? [message.id] : [] })
        session.append('agent/inbox/claim-settled', { turn: kind === 'turn' ? 2 : 1, step: kind === 'step' ? 2 : 1 })
      })
      expect(error.message).toBe('durable inbox claim is not settled')
    },
  )

  it('keeps no-op claim commands inert and filters only the owned claimed identities', async () => {
    const { ctx, session, inbox } = await inboxAgent('inbox-filter-owned-claims')
    expect(inbox.claimDurably('next-step', 1, 1)).toEqual([])
    inbox.filterClaim(1, 1, [])
    inbox.settleClaim(1, 1)
    expect(session.snapshotEvents()).toHaveLength(0)
    const steered = createUserMessage({ content: [{ type: 'text', text: 'step' }], source: { kind: 'user' } })
    const queued = createUserMessage({ content: [{ type: 'text', text: 'turn' }], source: { kind: 'user' } })
    inbox.append('next-step', steered)
    inbox.append('next-turn', queued)
    expect(inbox.claimDurably('next-turn', 1, 1)).toEqual([steered, queued])
    const count = session.snapshotEvents().length
    inbox.filterClaim(1, 1, [steered, queued])
    expect(session.snapshotEvents()).toHaveLength(count)
    inbox.filterClaim(1, 1, [steered])
    expect(ctx.sessionProjections.snapshot(session).values.inbox).toEqual({ 'next-turn': [], 'next-step': [],
      activeClaim: { turn: 1, step: 1, nextStep: [steered.id], nextTurn: [] } })
    inbox.filterClaim(1, 1, [])
    inbox.settleClaim(1, 1)
    inbox.append('next-turn', queued)
    inbox.append('next-step', steered)
    expect(inbox.claimDurably('next-step', 1, 2)).toEqual([steered])
    expect(inbox.nextTurn).toEqual([queued])
  })

  it.each([
    [{ kind: 'forked' }, true],
    [{ kind: 'aborted', reason: { kind: 'user' } }, true],
    [{ kind: 'aborted', reason: { kind: 'legacy' } }, false],
    [{ kind: 'completed' }, false],
  ] satisfies [TurnEndReason, boolean][])(
    'restores or drops both claimed queues according to the durable turn ending %j', async (reason, dropped) => {
      const { session, inbox } = await inboxAgent(`inbox-turn-end-${reason.kind}-${dropped}`)
      const steered = createUserMessage({ content: [{ type: 'text', text: 'step' }], source: { kind: 'user' } })
      const queued = createUserMessage({ content: [{ type: 'text', text: 'turn' }], source: { kind: 'user' } })
      inbox.append('next-step', steered)
      inbox.append('next-turn', queued)
      inbox.claimDurably('next-turn', 1, 1)
      session.append('turn/end', { turn: 1, reason })
      expect(inbox.nextStep).toEqual(dropped ? [] : [steered])
      expect(inbox.nextTurn).toEqual(dropped ? [] : [queued])
    },
  )

  it('projects claimed identities across reconnects without exposing claimed content', async () => {
    const { ctx, session, inbox } = await inboxAgent('inbox-wire-claim')
    const steered = createUserMessage({ content: [{ type: 'text', text: 'private steering text' }], source: { kind: 'user' } })
    const queued = createUserMessage({ content: [{ type: 'text', text: 'private queued text' }], source: { kind: 'user' } })
    inbox.append('next-step', steered)
    inbox.append('next-turn', queued)
    session.append('turn/start', { turn: 1 })
    inbox.claimDurably('next-turn', 1, 1)
    expect(ctx.sessionProjections.snapshot(session).values.inbox).toEqual({
      'next-turn': [], 'next-step': [],
      activeClaim: { turn: 1, step: 1, nextStep: [steered.id], nextTurn: [queued.id] },
    })
    session.append('user/message', steered, { surfaceOp: 'append' })
    inbox.filterClaim(1, 1, [])
    inbox.settleClaim(1, 1)
    expect(ctx.sessionProjections.snapshot(session).values.inbox).toEqual({ 'next-turn': [], 'next-step': [] })
  })

  it('does not restore an active claim into a fork or remove it from the parent', async () => {
    const { ctx, session, inbox } = await inboxAgent('inbox-claimed-parent')
    const message = createUserMessage({ content: [{ type: 'text', text: 'parent input' }], source: { kind: 'user' } })
    inbox.append('next-turn', message)
    session.append('turn/start', { turn: 1 })
    inbox.claimDurably('next-turn', 1, 1)
    const child = ctx.sessions.fork(session, undefined, SessionId('inbox-claimed-child'))
    expect(ctx.sessionProjections.snapshot(child).values.inbox).toEqual({ 'next-turn': [], 'next-step': [] })
    expect(ctx.sessionProjections.snapshot(session).values.inbox).toEqual({
      'next-turn': [], 'next-step': [],
      activeClaim: { turn: 1, step: 1, nextStep: [], nextTurn: [message.id] },
    })
  })

  it('retains inbox reads after the shared registration is released', async () => {
    const ctx = new Context()
    onTestFinished(() => ctx.fiber.dispose())
    await ctx.plugin(SessionStore)
    await ctx.plugin(SessionProjectionRegistry)
    const projection = await ctx.sessionProjections.register(inboxProjectionDefinition)
    const session = ctx.sessions.create(SessionId('inbox-projection'))
    const pending = createUserMessage({
      content: [{ type: 'text', text: 'pending' }],
      source: { kind: 'user' },
    })
    session.append('agent/inbox/spliced', {
      target: 'next-turn', start: 0, inserted: [pending],
    })
    const agent = stubAgent('inbox-projection', { ctx, session })
    const dispatch = agentEvents(ctx, agent)
    const first = new ReactLoopInbox(() => projection.stateOf(session), session, dispatch)
    const second = new ReactLoopInbox(() => projection.stateOf(session), session, dispatch)

    expect(first.nextTurn).toEqual([pending])
    expect(second.nextTurn).toEqual([pending])
    expect(ctx.sessionProjections.snapshot(session).values.inbox).toEqual({
      'next-turn': [pending],
      'next-step': [],
    })
    const row = ctx.sessionProjections.checkpoint(session).inbox

    await projection.dispose()
    expect(ctx.sessionProjections.checkpoint(session)).toHaveProperty('inbox', row)
    expect(ctx.sessionProjections.checkpoint(ctx.sessions.create())).not.toHaveProperty('inbox')
    expect(first.nextTurn).toEqual([pending])
    first.clear()
    expect(second.nextTurn).toEqual([])
    expect(ctx.sessionProjections.snapshot(session).values.inbox).toBeUndefined()
  })

  it('rejects invalid durable coordinates and duplicate identities during reconstruction', async () => {
    const outOfRange = await reconstructPersistedInbox('invalid-inbox-range', (session) => {
      session.append('agent/inbox/spliced', {
        target: 'next-turn', start: 0, removedCount: 1, inserted: [],
      })
    })
    expect(outOfRange.message).toBe('invalid persisted inbox splice at session seq 0')
    expect((outOfRange.cause as Error).message).toBe('invalid inbox splice')

    const pending = createUserMessage({
      content: [{ type: 'text', text: 'duplicate' }],
      source: { kind: 'user' },
    })
    const duplicate = await reconstructPersistedInbox('invalid-inbox-duplicate', (session) => {
      session.append('agent/inbox/spliced', {
        target: 'next-turn', start: 0, inserted: [pending],
      })
      session.append('agent/inbox/spliced', {
        target: 'next-step', start: 0, inserted: [pending],
      })
    })
    expect(duplicate.message).toBe('invalid persisted inbox splice at session seq 1')
    expect((duplicate.cause as Error).message).toBe(`message "${pending.id}" is already pending`)
  })

  it('projects inherited inbox events in a forked session', async () => {
    const ctx = new Context()
    onTestFinished(() => ctx.fiber.dispose())
    await ctx.plugin(SessionStore)
    await ctx.plugin(SessionProjectionRegistry)
    const projection = await ctx.sessionProjections.register(inboxProjectionDefinition)
    const parent = ctx.sessions.create(SessionId('inbox-fork-parent'))
    const parentAgent = stubAgent('inbox-fork-parent', { ctx, session: parent })
    const parentInbox = new ReactLoopInbox(() => projection.stateOf(parent), parent, agentEvents(ctx, parentAgent))
    const inherited = createUserMessage({
      content: [{ type: 'text', text: 'parent pending' }],
      source: { kind: 'user' },
    })
    parentInbox.append('next-turn', inherited)
    const child = ctx.sessions.fork(parent, undefined, SessionId('inbox-fork-child'))
    const childAgent = stubAgent('inbox-fork-child', { ctx, session: child })
    const childInbox = new ReactLoopInbox(() => projection.stateOf(child), child, agentEvents(ctx, childAgent))

    expect(child.inheritedEventCount).toBe(parent.snapshotEvents().length)
    expect(childInbox.nextTurn).toEqual([inherited])

    const own = createUserMessage({
      content: [{ type: 'text', text: 'child pending' }],
      source: { kind: 'user' },
    })
    childInbox.append('next-turn', own)
    expect(childInbox.nextTurn).toEqual([inherited, own])

  })

  it('updates the projection cell before session observers run', async () => {
    const { ctx, session, inbox } = await inboxAgent('inbox-live-projection')
    const pending = createUserMessage({
      content: [{ type: 'text', text: 'direct' }],
      source: { kind: 'user' },
    })
    let observed: readonly UserMessage[] | undefined
    ctx.on('session/event', (subject, event) => {
      if (subject === session && event.type === 'agent/inbox/spliced') {
        observed = inbox.nextTurn
      }
    })

    inbox.append('next-turn', pending)

    expect(observed).toEqual([pending])
    expect(ctx.sessionProjections.snapshot(session).values.inbox).toEqual({
      'next-turn': [pending], 'next-step': [],
    })
  })

  it('replaces a pending message by identity across both lists', async () => {
    const { ctx, agent } = await inboxAgent('replace-inbox')
    const inserted: UserMessage[] = []
    const discarded: UserMessage[] = []
    ctx.on('agent/inbox/inserted', ({ message }) => void inserted.push(message))
    ctx.on('agent/inbox/discarded', ({ message }) => void discarded.push(message))
    const original = createUserMessage({
      content: [{ type: 'text', text: 'original' }],
      source: { kind: 'user' },
    })
    const nextStep = createUserMessage({
      content: [{ type: 'text', text: 'step' }],
      source: { kind: 'user' },
    })
    const replacement = createUserMessage({
      content: [{ type: 'text', text: 'replacement' }],
      source: { kind: 'user' },
    })
    const editedStep = freezeMessage({
      ...nextStep,
      content: [{ type: 'text', text: 'edited step' }],
    })
    agent.inbox.append('next-turn', original)
    agent.inbox.append('next-step', nextStep)

    expect(agent.inbox.replace(createUserMessage({
      content: [{ type: 'text', text: 'missing' }],
      source: { kind: 'user' },
    }).id, replacement)).toBe(false)
    expect(agent.inbox.replace(original.id, replacement)).toBe(true)
    expect(agent.inbox.replace(nextStep.id, editedStep)).toBe(true)
    expect(agent.inbox.nextTurn).toEqual([replacement])
    expect(agent.inbox.nextStep).toEqual([editedStep])
    expect(discarded).toEqual([original, nextStep])
    expect(inserted).toEqual([original, nextStep, replacement, editedStep])
    expect(() => { agent.inbox.replace(editedStep.id, replacement) })
      .toThrow(`message "${replacement.id}" is already pending`)
  })

  it('normalizes splice coordinates, rejects duplicate identities, and reports missing removals', async () => {
    const { agent } = await inboxAgent('splice-inbox')
    const first = createUserMessage({
      content: [{ type: 'text', text: 'first' }],
      source: { kind: 'user' },
    })
    const second = createUserMessage({
      content: [{ type: 'text', text: 'second' }],
      source: { kind: 'user' },
    })
    const prefixed = createUserMessage({
      content: [{ type: 'text', text: 'prefixed' }],
      source: { kind: 'user' },
    })

    agent.inbox.splice('next-turn', Number.NaN, Number.NaN, [first, second])
    expect(agent.inbox.nextTurn).toEqual([first, second])
    expect(agent.inbox.splice('next-turn', -1, 1, [])).toEqual([second])
    agent.inbox.prepend('next-turn', prefixed)
    expect(agent.inbox.nextTurn).toEqual([prefixed, first])
    expect(agent.inbox.remove(second.id)).toBe(false)
    expect(() => { agent.inbox.append('next-step', first) }).toThrow(`message "${first.id}" is already pending`)
  })

  it('clears both pending lists as durable cancellations', async () => {
    const { ctx, session, agent } = await inboxAgent('clear-inbox')
    const discarded: UserMessage[] = []
    ctx.on('agent/inbox/discarded', ({ message }) => void discarded.push(message))
    const nextTurn = createUserMessage({ content: [{ type: 'text', text: 'turn' }], source: { kind: 'user' } })
    const nextStep = createUserMessage({ content: [{ type: 'text', text: 'step' }], source: { kind: 'user' } })
    agent.inbox.append('next-turn', nextTurn)
    agent.inbox.append('next-step', nextStep)
    const beforeClear = session.snapshotEvents().length

    agent.inbox.clear()

    expect(agent.inbox.nextTurn).toEqual([])
    expect(agent.inbox.nextStep).toEqual([])
    expect(discarded).toEqual([nextStep, nextTurn])
    expect(session.snapshotEvents().slice(beforeClear).map(event => event.type === 'agent/inbox/spliced'
      ? event.data
      : event.type)).toEqual([
      { target: 'next-step', start: 0, removedCount: 1, inserted: [], outcome: 'canceled' },
      { target: 'next-turn', start: 0, removedCount: 1, inserted: [], outcome: 'canceled' },
    ])

    agent.inbox.clear()
    expect(session.snapshotEvents()).toHaveLength(beforeClear + 2)
  })
})
