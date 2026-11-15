/** Digest delivery from watched Sessions to a parent through the native AgentLoop. */
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies, provideWorkingDirectoryFixture } from '@deepseek-ai/dsh-agent-loop-testkit'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, StreamChunk, UserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { MockAdapter, textResponse, toolCallResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import SessionActivityDigests, { type Config } from '../src/index.ts'

type Entry = ConstructorParameters<typeof MockAdapter>[0][number]

/** A child asked with `ask` calls the question tool once; every other request answers with text. */
function scripted(options: GenerateOptions): StreamChunk[] {
  const last = options.messages.at(-1)
  const text = last?.role === 'user' ? last.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('') : ''
  return text === 'ask' ? toolCallResponse('q1', 'ask_user_question', { question: 'Which cut?' }) : textResponse('ok')
}

async function fixture(config: Config, script: Entry[] = Array.from({ length: 20 }, () => scripted)) {
  const ctx = new Context()
  onTestFinished(async () => { await ctx.fiber.dispose() })
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(AgentLoop, { agents: [] })
  provideWorkingDirectoryFixture(ctx, '/work')
  ctx.llm.registerAdapter(['mock'], new MockAdapter(script))
  const fiber = await ctx.plugin(SessionActivityDigests, { coalesceMs: 0, stallMs: 0, ...config })
  const make = async (id: string): Promise<Agent> => (await ctx.agents.create({
    sessionId: SessionId(id), meta: { cwd: '/work' }, agentOptions: { provider: 'mock', model: 'mock' },
  })).agent
  const parent = await make('parent')
  const child = await make('child')
  const digests: string[] = []
  ctx.on('session/event', (session, event) => {
    if (session.id === parent.id && event.type === 'user/message' && event.data.source.kind === 'session-activity') {
      digests.push(event.data.content.flatMap(block => block.type === 'text' ? [block.text] : []).join(''))
    }
  }, { global: true })
  return { ctx, fiber, parent, child, digests }
}

function say(agent: Agent, text: string): void {
  agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text }] }))
}

function textOf(message: UserMessage | undefined): string {
  return message?.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('') ?? ''
}

function pendingDigests(agent: Agent): number {
  return [...agent.inbox.nextTurn, ...agent.inbox.nextStep].filter(message => message.source.kind === 'session-activity').length
}

describe('session activity delivery', () => {
  it('wakes an idle parent when a watched Session asks a question', async () => {
    const { ctx, parent, child, digests } = await fixture({})
    ctx.sessionActivity.watch(parent.id, child.id, 'episode 1')
    say(child, 'ask')
    await vi.waitFor(() => { expect(digests.some(text => text.includes('Needs your attention:'))).toBe(true) })
    await child.whenIdle()
    await parent.whenIdle()
    const woke = digests.find(text => text.includes('Needs your attention:'))
    expect(woke).toContain('- episode 1 [child]')
    expect(woke).toContain('episode 1 called ask_user_question: {"question":"Which cut?"}')
  })

  it('keeps one replaceable digest pending until the parent is woken by something else', async () => {
    const { parent, child, digests, ctx } = await fixture({})
    const release = ctx.sessionActivity.watch(parent.id, child.id, 'episode 1')
    say(child, 'first')
    await child.whenIdle()
    await vi.waitFor(() => { expect(pendingDigests(parent)).toBe(1) })
    say(child, 'second')
    await child.whenIdle()
    await vi.waitFor(() => {
      expect(textOf(parent.inbox.nextStep.find(message => message.source.kind === 'session-activity'))).toContain('idle after 2 turns')
    })
    expect(pendingDigests(parent)).toBe(1)
    expect(digests).toEqual([])
    say(parent, 'status?')
    await parent.whenIdle()
    expect(digests).toHaveLength(1)
    expect(digests[0]).toContain('idle after 2 turns')
    expect(pendingDigests(parent)).toBe(0)
    release()
    release()
    say(child, 'third')
    await child.whenIdle()
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(pendingDigests(parent)).toBe(0)
  })

  it('flushes changes committed since the last evaluation when the watch ends', async () => {
    const { ctx, parent, child } = await fixture({ coalesceMs: 60_000 })
    const release = ctx.sessionActivity.watch(parent.id, child.id, 'episode 1')
    ctx.sessionActivity.watch(parent.id, SessionId('other'), 'other')()
    say(child, 'done quickly')
    await child.whenIdle()
    expect(pendingDigests(parent)).toBe(0)
    release()
    expect(pendingDigests(parent)).toBe(1)
    say(parent, 'status?')
    await parent.whenIdle()
    expect(pendingDigests(parent)).toBe(0)
  })

  it('wakes the parent once for a running Session without new events', async () => {
    const { ctx, parent, child, digests } = await fixture({ stallMs: 30 }, ['hang', ...Array.from({ length: 5 }, () => scripted)])
    ctx.sessionActivity.watch(parent.id, child.id, 'episode 1')
    ctx.sessionActivity.watch(parent.id, SessionId('not-created'), 'never started')
    say(child, 'long')
    await vi.waitFor(() => { expect(digests.some(text => text.includes('no new activity'))).toBe(true) })
    await parent.whenIdle()
    expect(digests.filter(text => text.includes('no new activity'))).toHaveLength(1)
  })

  it('counts references per pair and stops after the plugin unloads', async () => {
    const { ctx, fiber, parent, child } = await fixture({})
    const first = ctx.sessionActivity.watch(parent.id, child.id, 'old label')
    const second = ctx.sessionActivity.watch(parent.id, child.id, 'episode 1')
    first()
    say(child, 'one')
    await child.whenIdle()
    await vi.waitFor(() => { expect(pendingDigests(parent)).toBe(1) })
    expect(textOf(parent.inbox.nextStep.at(-1))).toContain('- episode 1 [child]')
    ctx.sessionActivity.watch(SessionId('absent-parent'), child.id, 'nobody')
    say(child, 'two')
    await child.whenIdle()
    await new Promise(resolve => setTimeout(resolve, 20))
    const service = ctx.sessionActivity
    await fiber.dispose()
    second()
    const late = service.watch(parent.id, child.id, 'late')
    late()
    expect(pendingDigests(parent)).toBe(1)
  })
})
