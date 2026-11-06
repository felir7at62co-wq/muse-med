import { randomUUID } from 'node:crypto'
import { Context } from '@deepseek-ai/cordis'
import { createUserMessage, MessageId, type UserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import { afterEach, expect, it, vi } from 'vitest'
import { MockAdapter, maxTokensResponse, textResponse } from './mock-adapter.ts'

const contexts: Context[] = []
const releases: (() => void)[] = []
afterEach(async () => {
  for (const release of releases.splice(0)) release()
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
})

async function fixture(adapter: MockAdapter) {
  const ctx = new Context()
  contexts.push(ctx)
  await mountAgentLoopTestDependencies(ctx)
  ctx.llm.registerAdapter(['mock'], adapter)
  await mountAgentLoopTestHarness(ctx)
  const { agent } = await ctx.agents.create({ sessionId: SessionId(randomUUID()), agentOptions: { provider: 'mock', model: 'mock' } })
  const message = (text: string) => createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })
  const committed = () => agent.session.snapshotEvents().flatMap(event => event.type === 'user/message' ? [event.data.id] : [])
  return { ctx, agent, message, committed }
}

it('does not start a turn for an absent message and wakes the exact parked next-turn entry once', async () => {
  const adapter = new MockAdapter([textResponse('Restored result')]), f = await fixture(adapter)
  expect(f.agent.wakePending(MessageId('missing'))).toBe(false)
  const parked = f.message('Resume the already committed generation notice')
  f.agent.inbox.append('next-turn', parked)
  expect(f.agent.wakePending(MessageId('another-message'))).toBe(false)
  expect(adapter.requests).toHaveLength(0)
  expect(f.agent.wakePending(parked.id)).toBe(true)
  await f.agent.whenIdle()
  expect(f.committed()).toEqual([parked.id])
  expect(f.agent.wakePending(parked.id)).toBe(false)
  expect(adapter.requests).toHaveLength(1)
})

it('wakes an existing next-step entry without appending a replacement input', async () => {
  const adapter = new MockAdapter([textResponse('Recovered next step')]), f = await fixture(adapter)
  const parked = f.message('Use the existing verified output')
  f.agent.inject(parked)
  expect(f.agent.wakePending(MessageId('another-next-step'))).toBe(false)
  expect(f.agent.wakePending(parked.id)).toBe(true)
  await f.agent.whenIdle()
  expect(f.committed()).toEqual([parked.id])
  expect(adapter.requests).toHaveLength(1)
  const inserted = f.agent.session.snapshotEvents().flatMap(event => event.type === 'agent/inbox/spliced' ? event.data.inserted : [])
  expect(inserted.filter(message => message.id === parked.id)).toHaveLength(1)
})

it('latches the original pending notice while an aborted turn is converging to idle', async () => {
  const adapter = new MockAdapter(['hang', textResponse('Resume once')]), f = await fixture(adapter)
  const active = f.message('Original active turn'), parked = f.message('Original queued notice')
  f.agent.followup(active)
  await vi.waitFor(() => { expect(adapter.requests).toHaveLength(1) })
  f.agent.inbox.append('next-turn', parked)
  f.agent.cancel({ kind: 'user' }, { keepInbox: true })
  expect(f.agent.wakePending(parked.id)).toBe(true)
  await f.agent.whenIdle()
  expect(f.committed()).toEqual([active.id, parked.id])
  expect(adapter.requests).toHaveLength(2)
  expect(f.agent.session.snapshotEvents().flatMap(event => event.type === 'turn/end' ? [event.data.reason] : []))
    .toEqual([{ kind: 'aborted', reason: { kind: 'user' } }, { kind: 'completed' }])
})

it('lets a live driver claim the pending notice without opening a second driver', async () => {
  const adapter = new MockAdapter([textResponse('First result'), textResponse('Pending result')]), f = await fixture(adapter)
  let enter!: () => void
  let release!: () => void
  const entered = new Promise<void>((resolve) => { enter = resolve })
  const held = new Promise<void>((resolve) => { release = resolve })
  releases.push(release)
  f.ctx.on('agent/request', async ({ turn }, next) => {
    if (turn === 1) { enter(); await held }
    return next()
  })
  const active: UserMessage = f.message('Active work'), parked = f.message('Pending work')
  f.agent.followup(active)
  await entered
  f.agent.inbox.append('next-turn', parked)
  expect(f.agent.wakePending(parked.id)).toBe(true)
  release()
  await f.agent.whenIdle()
  expect(f.committed()).toEqual([active.id, parked.id])
  expect(adapter.requests).toHaveLength(2)
  expect(f.agent.session.snapshotEvents().filter(event => event.type === 'turn/start')).toHaveLength(2)
})

it('records a completed turn only after an output-limit recovery consumer accepts the resumed result', async () => {
  const adapter = new MockAdapter([maxTokensResponse('Incomplete inventory'), textResponse('Inventory complete')])
  const f = await fixture(adapter)
  f.ctx.on('agent/turn-stopping', () => {
    if (adapter.requests.length === 1) f.agent.steer(f.message('Continue the interrupted inventory'))
  })
  const recovered = vi.fn(() => Promise.resolve(true))
  f.ctx.on('agent/output-limit-recovered', recovered)
  f.agent.followup(f.message('Complete the inventory'))
  await f.agent.whenIdle()
  expect(adapter.requests).toHaveLength(2)
  expect(recovered).toHaveBeenCalledOnce()
  expect(f.agent.session.snapshotEvents().flatMap(event => event.type === 'turn/end' ? [event.data.reason] : []))
    .toEqual([{ kind: 'completed' }])
  expect(f.agent.session.snapshotEvents().flatMap(event => event.type === 'assistant/message'
    ? event.data.message.content.flatMap(block => block.type === 'text' ? [block.text] : []) : []))
    .toEqual(['Incomplete inventory', 'Inventory complete'])
})
