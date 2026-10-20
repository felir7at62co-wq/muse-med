/** Background inheritance replay waits on the recorded parent turn, including disposal. */
import { Context } from '@deepseek-ai/cordis'
import { agentEvents, type Agent } from '@deepseek-ai/dsh-agent'
import Sessions, { SessionId, type Session } from '@deepseek-ai/dsh-session'
import { expect, it, vi } from 'vitest'
import * as ParentOverride from './fixtures/parent-sandbox-override.ts'

/** Only the session and identity participate in this fixture's event dispatch. */
function subject(session: Session): Agent {
  return { id: session.id, session } as Agent
}

it('holds an already-entered child step until its parent first turn closes', async ({ onTestFinished }) => {
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  await ctx.plugin(Sessions)
  const entered = Promise.withResolvers<undefined>()
  ctx.on('agent/pre-step', (_payload, next) => { entered.resolve(undefined); return next() })
  await ctx.plugin(ParentOverride)
  const parent = ctx.sessions.create(SessionId('parent'))
  const child = ctx.sessions.create(SessionId('child'), { meta: { parentSession: parent.id } })
  const next = vi.fn(async () => ({ kind: 'enter' as const, messages: [] }))
  const pending = agentEvents(ctx, subject(child)).waterfall('agent/pre-step', {
    messages: [], turn: 1, step: 1, signal: new AbortController().signal,
  }, next)
  await entered.promise
  expect(next).not.toHaveBeenCalled()
  child.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
  expect(next).not.toHaveBeenCalled()
  parent.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
  await expect(pending).resolves.toEqual({ kind: 'enter', messages: [] })
  expect(next).toHaveBeenCalledOnce()
})

it('admits the parent without waiting on its own turn end', async ({ onTestFinished }) => {
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  await ctx.plugin(Sessions)
  await ctx.plugin(ParentOverride)
  const parent = ctx.sessions.create(SessionId('parent'))
  await expect(agentEvents(ctx, subject(parent)).waterfall('agent/pre-step', {
    messages: [], turn: 1, step: 1, signal: new AbortController().signal,
  }, async () => ({ kind: 'enter' as const, messages: [] }))).resolves.toEqual({ kind: 'enter', messages: [] })
})

it('releases an entered child waiter while the fixture is disposed', async ({ onTestFinished }) => {
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  await ctx.plugin(Sessions)
  const entered = Promise.withResolvers<undefined>()
  ctx.on('agent/pre-step', (_payload, next) => { entered.resolve(undefined); return next() })
  const owner = await ctx.plugin(ParentOverride)
  const child = ctx.sessions.create(SessionId('child'), { meta: { parentSession: SessionId('parent') } })
  const next = vi.fn(async () => ({ kind: 'enter' as const, messages: [] }))
  const pending = agentEvents(ctx, subject(child)).waterfall('agent/pre-step', {
    messages: [], turn: 1, step: 1, signal: new AbortController().signal,
  }, next)
  await entered.promise
  expect(next).not.toHaveBeenCalled()
  await owner.dispose()
  await expect(pending).resolves.toEqual({ kind: 'enter', messages: [] })
  expect(next).toHaveBeenCalledOnce()
})
