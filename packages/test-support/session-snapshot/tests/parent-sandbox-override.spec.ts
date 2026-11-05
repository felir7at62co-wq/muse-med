/** The inheritance fixture records root policy without delaying child execution. */
import { Context } from '@deepseek-ai/cordis'
import { agentEvents, type Agent } from '@deepseek-ai/dsh-agent'
import Sessions, { SessionId, type Session } from '@deepseek-ai/dsh-session'
import { expect, it, onTestFinished } from 'vitest'
import * as ParentOverride from './fixtures/parent-sandbox-override.ts'

/** Only the session and identity participate in this fixture's event dispatch. */
function subject(session: Session): Agent {
  return { id: session.id, session } as Agent
}

it('records the root override and leaves delegated policy to the child provider', async ({ onTestFinished }) => {
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  await ctx.plugin(Sessions)
  await ctx.plugin(ParentOverride)
  const parent = ctx.sessions.create(SessionId('parent'))
  const child = ctx.sessions.create(SessionId('child'), { meta: { parentSession: parent.id } })
  for (const session of [parent, child]) {
    await ctx.serial('agent/created', { agent: subject(session), source: 'startup' })
  }
  expect(parent.snapshotEvents().filter(event => event.type === 'sandbox/mode'))
    .toMatchObject([{ data: { mode: 'read-only' } }])
  expect(child.snapshotEvents().filter(event => event.type === 'sandbox/mode')).toEqual([])
})

it.each([false, true])('admits the step without waiting on parent turn end (child: %s)', async (child) => {
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  await ctx.plugin(Sessions)
  await ctx.plugin(ParentOverride)
  const session = ctx.sessions.create(SessionId('subject'), child ? { meta: { parentSession: SessionId('parent') } } : {})
  await expect(agentEvents(ctx, subject(session)).waterfall('agent/pre-step', {
    messages: [], modelSelection: { provider: 'fixture', model: 'fixture' }, turn: 1, step: 1, signal: new AbortController().signal,
  }, async () => ({ kind: 'enter' as const, messages: [] }))).resolves.toEqual({ kind: 'enter', messages: [] })
})
