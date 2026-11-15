/** Status digests from watched Sessions to a parent through the native AgentLoop. */
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { Context, Service } from '@deepseek-ai/cordis'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies, provideWorkingDirectoryFixture } from '@deepseek-ai/dsh-agent-loop-testkit'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-jobs'
import { MockAdapter, textResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import SessionActivityDigests, { type Config } from '../src/index.ts'

type Entry = ConstructorParameters<typeof MockAdapter>[0][number]

/** Forwarded requests still waiting for the GUI, as the Typert gateway reports them. */
class PendingRequests extends Service {
  events: { event: string; agentId: string }[] = []
  constructor(ctx: Context) { super(ctx, 'typertGateway') }
  getPendingRemoteEvents(): readonly { event: string; agentId: string }[] { return this.events }
}

async function fixture(config: Config, script: Entry[] = Array.from({ length: 20 }, () => textResponse('ok')), gateway = true) {
  const ctx = new Context()
  onTestFinished(async () => { await ctx.fiber.dispose() })
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(AgentLoop, { agents: [] })
  provideWorkingDirectoryFixture(ctx, '/work')
  ctx.llm.registerAdapter(['mock'], new MockAdapter(script))
  if (gateway) await ctx.plugin(PendingRequests)
  const fiber = await ctx.plugin(SessionActivityDigests, { coalesceMs: 0, stallMs: 0, ...config })
  const make = async (id: string): Promise<Agent> => (await ctx.agents.create({
    sessionId: SessionId(id), meta: { cwd: '/work' }, agentOptions: { provider: 'mock', model: 'mock' },
  })).agent
  const parent = await make('parent')
  const child = await make('child')
  const digests: string[] = []
  ctx.on('session/event', (session, event) => {
    if (session.id === parent.id && event.type === 'user/message' && event.data.source.kind === 'session-activity') digests.push(textOf(event.data))
  }, { global: true })
  return { ctx, fiber, parent, child, digests }
}

function textOf(message: UserMessage | undefined): string {
  return message?.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('') ?? ''
}

function say(agent: Agent, text: string): void {
  agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text }] }))
}

function pendingDigests(agent: Agent): UserMessage[] {
  return [...agent.inbox.nextTurn, ...agent.inbox.nextStep].filter(message => message.source.kind === 'session-activity')
}

const settle = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 30))

describe('session status digests', () => {
  it('wakes an idle parent once when a watched Session waits for an answer', async () => {
    const { ctx, parent, child, digests } = await fixture({})
    const gateway = ctx.get('typertGateway')
    if (!(gateway instanceof PendingRequests)) throw new Error('fake gateway missing')
    ctx.sessionActivity.watch(parent.id, child.id, 'episode 1')
    gateway.events = [{ event: 'user-questions/request', agentId: 'child' }, { event: 'user-questions/request', agentId: 'other' }]
    say(child, 'work')
    await vi.waitFor(() => { expect(digests.some(text => text.includes('Needs your attention:'))).toBe(true) })
    await parent.whenIdle()
    expect(digests.find(text => text.includes('Needs your attention:')))
      .toContain('- episode 1 [child] waiting for an answer in its own chat')
    say(child, 'more')
    await child.whenIdle()
    await settle()
    await parent.whenIdle()
    expect(digests.filter(text => text.includes('Needs your attention:'))).toHaveLength(1)
    gateway.events = [{ event: 'approval/request', agentId: 'child' }]
    say(child, 'again')
    await vi.waitFor(() => { expect(digests.some(text => text.includes('waiting for an approval'))).toBe(true) })
  })

  it('keeps one replaceable status digest pending until something else wakes the parent', async () => {
    const { ctx, parent, child, digests } = await fixture({ subagents: false }, undefined, false)
    ctx.on('workspace/session-activity', async ({ sessionId }, next) => {
      const rest = await next()
      return sessionId === child.id ? [{ kind: 'job', items: [{ id: 'j1', label: 'ffmpeg cut' }, { id: 'j2' }] }, { kind: 'job' }, { kind: 'turn' }, ...rest] : rest
    })
    const release = ctx.sessionActivity.watch(parent.id, child.id, 'episode 1')
    say(child, 'first')
    await child.whenIdle()
    await vi.waitFor(() => { expect(pendingDigests(parent)).toHaveLength(1) })
    say(child, 'second')
    await child.whenIdle()
    await settle()
    expect(pendingDigests(parent)).toHaveLength(1)
    expect(textOf(pendingDigests(parent)[0])).toContain('- episode 1 [child] idle for under 1 min · job: ffmpeg cut, j2 · job')
    expect(digests).toEqual([])
    say(parent, 'status?')
    await parent.whenIdle()
    expect(digests).toHaveLength(1)
    expect(pendingDigests(parent)).toHaveLength(0)
    release()
    release()
    await settle()
    say(child, 'third')
    await child.whenIdle()
    await settle()
    expect(pendingDigests(parent)).toHaveLength(0)
    expect(await ctx.sessionActivity.describe(child.id)).toBe('idle for under 1 min · job: ffmpeg cut, j2 · job')
    expect(await ctx.sessionActivity.describe(SessionId('never-created'))).toBe('not open')
  })

  it('reports a failed turn and a stalled running Session', async () => {
    const failing: Entry = [{ type: 'finish', reason: { kind: 'error', failure: { message: 'model down', code: 'AUTH', status: 401 } } }]
    const { ctx, parent, child, digests } = await fixture({ stallMs: 40 }, [failing, textResponse('noted'), 'hang', ...Array.from({ length: 6 }, () => textResponse('ok'))])
    ctx.sessionActivity.watch(parent.id, child.id, 'episode 1')
    ctx.sessionActivity.watch(parent.id, SessionId('never-created'), 'not started')
    say(child, 'fail')
    await child.whenIdle()
    await vi.waitFor(() => { expect(digests.some(text => text.includes('last turn failed'))).toBe(true) }, { timeout: 3000 })
    await parent.whenIdle()
    say(child, 'hang')
    await vi.waitFor(() => { expect(digests.some(text => text.includes('no new activity'))).toBe(true) })
    await parent.whenIdle()
    expect(digests.filter(text => text.includes('no new activity'))).toHaveLength(1)
  })

  it('flushes on release, keeps a pair watched again meanwhile and stops after unload', async () => {
    const { ctx, fiber, parent, child } = await fixture({ coalesceMs: 60_000 })
    const release = ctx.sessionActivity.watch(parent.id, child.id, 'episode 1')
    ctx.sessionActivity.watch(parent.id, child.id, 'episode 1')()
    say(child, 'done quickly')
    await child.whenIdle()
    expect(pendingDigests(parent)).toHaveLength(0)
    release()
    const again = ctx.sessionActivity.watch(parent.id, child.id, 'episode 1 again')
    await settle()
    expect(pendingDigests(parent)).toHaveLength(1)
    ctx.sessionActivity.watch(parent.id, SessionId('other'), 'other')()
    again()
    await settle()
    say(parent, 'status?')
    await parent.whenIdle()
    expect(pendingDigests(parent)).toHaveLength(0)
    let open!: () => void
    const gate = new Promise<void>((resolve) => { open = resolve })
    ctx.on('workspace/session-activity', async () => {
      await gate
      throw new Error('provider down')
    })
    ctx.sessionActivity.watch(SessionId('absent-parent'), child.id, 'nobody')()
    const service = ctx.sessionActivity
    service.watch(parent.id, child.id, 'blocked')()
    service.watch(parent.id, child.id, 'queued behind it')()
    const late = service.watch(parent.id, child.id, 'late')
    await fiber.dispose()
    open()
    await settle()
    late()
    service.watch(parent.id, child.id, 'after unload')()
    expect(pendingDigests(parent)).toHaveLength(0)
  })
})
