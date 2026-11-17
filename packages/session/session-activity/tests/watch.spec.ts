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
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import { MockAdapter, textResponse, toolCallResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import SessionActivityDigests, { type Config } from '../src/index.ts'

type Entry = ConstructorParameters<typeof MockAdapter>[0][number]

/** Forwarded requests still waiting for the GUI, as the Typert gateway reports them. */
class PendingRequests extends Service {
  events: { event: string; agentId: string }[] = []
  constructor(ctx: Context) { super(ctx, 'typertGateway') }
  getPendingRemoteEvents(): readonly { event: string; agentId: string }[] { return this.events }
}

/** `hold` and `block` user messages call a tool that waits until the test releases it; everything else answers with text. */
function scripted(options: GenerateOptions): StreamChunk[] {
  const latest: string[] = []
  for (const message of options.messages.toReversed()) {
    if (message.role !== 'user') break
    latest.push(textOf(message))
  }
  const name = latest.find(text => text === 'hold' || text === 'block')
  return name === undefined ? textResponse('ok') : toolCallResponse(`${name}-call`, name, {})
}

async function fixture(config: Config, script: Entry[] = Array.from({ length: 30 }, () => scripted), gateway = true) {
  const ctx = new Context()
  onTestFinished(async () => { await ctx.fiber.dispose() })
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(AgentLoop, { agents: [] })
  provideWorkingDirectoryFixture(ctx, '/work')
  ctx.llm.registerAdapter(['mock'], new MockAdapter(script))
  if (gateway) await ctx.plugin(PendingRequests)
  const gates = new Map<string, () => void>()
  for (const name of ['hold', 'block']) {
    ctx.tools.register(defineTool({
      name, description: `Wait until the test releases ${name}.`, parameters: {},
      output: { schema: { type: 'string' }, render: (_args: unknown, text: string) => [{ type: 'text' as const, text }] },
      execute: () => new Promise<string>((resolve) => { gates.set(name, () => { resolve('released') }) }),
    }))
  }
  const release = (name: string): void => { gates.get(name)?.() }
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
  return { ctx, fiber, parent, child, digests, make, release }
}

function textOf(message: { readonly content: UserMessage['content'] } | undefined): string {
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

  it('replaces a pending digest, defers one while the parent is busy and leaves idle Sessions out', async () => {
    const { ctx, parent, child, digests, make, release: open } = await fixture({ subagents: false }, undefined, false)
    let jobs: string[] = []
    ctx.on('workspace/session-activity', async ({ sessionId }, next) => {
      const rest = await next()
      const families = [{ kind: 'job' as const, items: jobs.map(label => ({ id: label, label })) }, { kind: 'job' as const, items: [{ id: 'j2' }] },
        { kind: 'job' as const }, { kind: 'turn' as const }]
      return sessionId === child.id ? [...families, ...rest] : rest
    })
    const other = await make('other')
    const releaseChild = ctx.sessionActivity.watch(parent.id, child.id, 'episode 1')
    const releaseOther = ctx.sessionActivity.watch(parent.id, other.id, 'episode 2')
    say(child, 'hold')
    await vi.waitFor(() => { expect(textOf(pendingDigests(parent)[0])).toContain('- episode 1 [child] running for under 1 min') })
    expect(textOf(pendingDigests(parent)[0])).toContain('· job · job: j2 · job')
    jobs = ['ffmpeg cut']
    say(other, 'quick')
    await other.whenIdle()
    await settle()
    await vi.waitFor(() => { expect(textOf(pendingDigests(parent)[0])).toContain('job: ffmpeg cut') })
    expect(pendingDigests(parent)).toHaveLength(1)
    expect(textOf(pendingDigests(parent)[0])).not.toContain('episode 2')
    say(parent, 'block')
    await vi.waitFor(() => { expect(digests).toHaveLength(1) })
    expect(parent.status).toBe('running')
    jobs = ['ffmpeg cut', 'asr']
    say(other, 'quick again')
    await other.whenIdle()
    await settle()
    expect(pendingDigests(parent)).toHaveLength(0)
    open('block')
    await parent.whenIdle()
    await vi.waitFor(() => { expect(textOf(pendingDigests(parent)[0])).toContain('job: ffmpeg cut, asr') })
    releaseChild()
    releaseOther()
    open('hold')
    await child.whenIdle()
    say(parent, 'status?')
    await parent.whenIdle()
    expect(digests).toHaveLength(2)
    expect(pendingDigests(parent)).toHaveLength(0)
    expect(await ctx.sessionActivity.describe(child.id)).toBe('idle for under 1 min · last tool hold · job: ffmpeg cut, asr · job: j2 · job')
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

  it('releases without a digest, counts references and stops after unload', async () => {
    const { ctx, fiber, parent, child } = await fixture({})
    const first = ctx.sessionActivity.watch(parent.id, child.id, 'episode 1')
    ctx.sessionActivity.watch(parent.id, child.id, 'episode 1')()
    first()
    first()
    say(child, 'done quickly')
    await child.whenIdle()
    await settle()
    expect(pendingDigests(parent)).toHaveLength(0)
    let open!: () => void
    const gate = new Promise<void>((resolve) => { open = resolve })
    ctx.on('workspace/session-activity', async () => {
      await gate
      throw new Error('provider down')
    })
    ctx.sessionActivity.watch(SessionId('absent-parent'), child.id, 'nobody')
    const service = ctx.sessionActivity
    service.watch(parent.id, child.id, 'blocked')
    await settle()
    service.watch(parent.id, SessionId('second'), 'queued behind it')
    await settle()
    const late = service.watch(parent.id, child.id, 'late')
    await fiber.dispose()
    open()
    await settle()
    late()
    service.watch(parent.id, child.id, 'after unload')()
    expect(pendingDigests(parent)).toHaveLength(0)
  })
})
