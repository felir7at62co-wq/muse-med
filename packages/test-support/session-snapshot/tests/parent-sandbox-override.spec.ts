/** The inheritance fixture sets root policy while allowing child settlement in the same turn. */
import { Context } from '@deepseek-ai/cordis'
import { agentEvents, type Agent } from '@deepseek-ai/dsh-agent'
import Sessions, { SessionId, type Session } from '@deepseek-ai/dsh-session'
import { expect, it, onTestFinished, vi } from 'vitest'
import * as ParentOverride from './fixtures/parent-sandbox-override.ts'

/** Only the session and identity participate in this fixture's event dispatch. */
function subject(session: Session): Agent {
  return { id: session.id, session } as Agent
}

it('sets read-only once on the root and preserves the delegated child policy', async () => {
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  await ctx.plugin(Sessions)
  await ctx.plugin(ParentOverride)
  const parent = ctx.sessions.create(SessionId('parent'))
  const child = ctx.sessions.create(SessionId('child'), { meta: { parentSession: parent.id } })
  child.append('sandbox/mode', { mode: 'read-only', source: 'delegation' })
  const parentAppend = vi.spyOn(parent, 'append')
  const childAppend = vi.spyOn(child, 'append')
  await agentEvents(ctx, subject(parent)).serial('agent/created', { source: 'startup' })
  await agentEvents(ctx, subject(child)).serial('agent/created', { source: 'startup' })
  expect(parentAppend).toHaveBeenCalledExactlyOnceWith('sandbox/mode', { mode: 'read-only' })
  expect(childAppend).not.toHaveBeenCalled()
})

it.each(['root', 'child'] as const)('admits the %s first step before the parent turn ends', async (role) => {
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  await ctx.plugin(Sessions)
  await ctx.plugin(ParentOverride)
  const parent = ctx.sessions.create(SessionId('parent'))
  const child = ctx.sessions.create(SessionId('child'), { meta: { parentSession: parent.id } })
  const next = vi.fn(async () => ({ kind: 'enter' as const, messages: [] }))
  await expect(agentEvents(ctx, subject(role === 'root' ? parent : child)).waterfall('agent/pre-step', {
    messages: [], turn: 1, step: 1, signal: new AbortController().signal,
  }, next)).resolves.toEqual({ kind: 'enter', messages: [] })
  expect(next).toHaveBeenCalledOnce()
})
