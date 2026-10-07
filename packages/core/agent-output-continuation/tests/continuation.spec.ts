/** Automatic continuation through the production loop, including cancellation and disposal. */
import { afterEach, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { createUserMessage, LlmAdapter, LlmError, ToolCallId } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { defineContentToolFixture } from '@deepseek-ai/dsh-tools'
import type { Config } from '../src/index.ts'
import * as continuation from '../src/index.ts'

type Script = StreamChunk[] | ((request: GenerateOptions) => AsyncIterable<StreamChunk>)
class ScriptedAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = []
  constructor(private readonly script: Script[]) { super() }
  async * stream(request: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(request)
    const entry = this.script.shift()
    if (entry === undefined) throw new Error('Unexpected extra model request')
    if (typeof entry === 'function') yield * entry(request)
    else for (const chunk of entry) yield chunk
  }
}
function reply(text: string, kind: 'stop' | 'max-tokens' = 'stop'): StreamChunk[] {
  return [{ type: 'block-start', index: 0, blockType: 'text' },
    { type: 'block-end', index: 0, block: { type: 'text', text } }, { type: 'finish', reason: { kind } }]
}
const roots: Context[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => root.fiber.dispose())) })
async function harness(script: Script[], config: Config = {}) {
  const ctx = new Context(); roots.push(ctx)
  await mountAgentLoopTestDependencies(ctx)
  const plugin = await ctx.plugin(continuation, config)
  await ctx.plugin(AgentLoop, { agents: [] })
  const adapter = new ScriptedAdapter(script)
  ctx.llm.registerAdapter(['mock'], adapter)
  const agent = await ctx.agentLoop.create(SessionId('output-continuation'), { provider: 'mock', model: 'mock', maxTokens: 64 })
  return { ctx, adapter, agent, plugin }
}
async function run(agent: Agent, text = 'Complete the answer'): Promise<void> {
  agent.followup(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }))
  await agent.whenIdle()
}
function hasPending(agent: Agent): boolean { return agent.inbox.nextStep.length > 0 || agent.inbox.nextTurn.length > 0 }
function end(agent: Agent) {
  return agent.session.snapshotEvents().findLast(event => event.type === 'turn/end')?.data
}
function sources(agent: Agent) {
  return agent.session.snapshotEvents().flatMap(event => event.type === 'user/message' && event.data.source.kind === 'output-continuation' ? [event.data.source] : [])
}

it('finishes several output-limited segments in one turn and records every continuation', async () => {
  const { agent, adapter } = await harness([reply('First paragraph ', 'max-tokens'), reply('Second paragraph ', 'max-tokens'), reply('Last paragraph.')])
  await run(agent)
  expect(adapter.requests).toHaveLength(3)
  expect(adapter.requests.every(request => request.maxTokens === 64)).toBe(true)
  expect(end(agent)).toEqual({ turn: 1, reason: { kind: 'completed' } })
  expect(sources(agent)).toEqual([{ kind: 'output-continuation' }, { kind: 'output-continuation' }])
  expect(adapter.requests[1]?.messages.some(message => message.role === 'assistant' && message.content.some(block => block.type === 'text' && block.text === 'First paragraph '))).toBe(true)
  expect(adapter.requests[1]?.messages.at(-1)?.content.find(block => block.type === 'text')?.text).toContain('Do not repeat')
  expect(hasPending(agent)).toBe(false)
})

it('leaves ordinary stop responses unchanged', async () => {
  const { agent, adapter } = await harness([reply('Done')]); await run(agent)
  expect(adapter.requests).toHaveLength(1); expect(sources(agent)).toEqual([])
  expect(end(agent)?.reason).toEqual({ kind: 'completed' })
})

it('stops an exact repeating response instead of continually requesting more', async () => {
  const { agent, adapter } = await harness([reply('Repeated answer', 'max-tokens'), reply('Repeated answer', 'max-tokens'), reply('Repeated answer', 'max-tokens')])
  await run(agent); expect(adapter.requests).toHaveLength(3)
  expect(end(agent)?.reason).toEqual({ kind: 'max-tokens' }); expect(hasPending(agent)).toBe(false)
})

it('detects a contained repeated tail as non-progress', async () => {
  const { agent, adapter } = await harness([reply('Prefix and repeated tail', 'max-tokens'), reply('repeated tail', 'max-tokens')], { maxNoProgressResponses: 1 })
  await run(agent); expect(adapter.requests).toHaveLength(2); expect(end(agent)?.reason).toEqual({ kind: 'max-tokens' })
})

it('allows one empty output retry and stops the second empty response', async () => {
  const { agent, adapter } = await harness([reply('', 'max-tokens'), reply('', 'max-tokens')]); await run(agent)
  expect(adapter.requests).toHaveLength(2); expect(end(agent)?.reason).toEqual({ kind: 'max-tokens' })
})

it('respects an explicit continuation cap and resets it for a new user turn', async () => {
  const { agent, adapter } = await harness([reply('one', 'max-tokens'), reply('two', 'max-tokens'), reply('three', 'max-tokens'), reply('done')], { maxContinuations: 1 })
  await run(agent); expect(adapter.requests).toHaveLength(2); expect(end(agent)?.reason).toEqual({ kind: 'max-tokens' })
  await run(agent, 'Continue'); expect(adapter.requests).toHaveLength(4); expect(end(agent)).toEqual({ turn: 2, reason: { kind: 'completed' } })
})

it('keeps a supplier failure after continuation as an error', async () => {
  const failure: Script = async function * () { throw new LlmError('Fixture unavailable', 'QUOTA') }
  const { agent, adapter } = await harness([reply('partial', 'max-tokens'), failure]); await run(agent)
  expect(adapter.requests).toHaveLength(2); expect(end(agent)?.reason).toMatchObject({ kind: 'error', error: { code: 'QUOTA' } })
})

it('prioritizes a queued human request over automatic continuation', async () => {
  const first: Script = async function * () {
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'New request' }], source: { kind: 'user' } }))
    yield * reply('old partial', 'max-tokens')
  }
  const { agent, adapter } = await harness([first, reply('New response')]); await run(agent)
  expect(adapter.requests).toHaveLength(2); expect(sources(agent)).toEqual([])
  expect(end(agent)).toEqual({ turn: 2, reason: { kind: 'completed' } })
})

it('removes queued continuation after reentrant cancellation even when other inbox work is retained', async () => {
  const { ctx, agent, adapter } = await harness([reply('partial', 'max-tokens'), reply('Manual response')])
  const stop = ctx.on('agent/inbox/inserted', ({ agent: target, message }) => {
    if (target === agent && message.source.kind === 'output-continuation') target.cancel({ kind: 'user' }, { keepInbox: true })
  })
  await run(agent); stop()
  expect(adapter.requests).toHaveLength(1); expect(hasPending(agent)).toBe(false)
  expect(end(agent)?.reason).toEqual({ kind: 'aborted', reason: { kind: 'user' } })
  await run(agent, 'New request'); expect(adapter.requests).toHaveLength(2); expect(sources(agent)).toEqual([])
})

it('cancels a streaming continuation and does not restart it', async () => {
  const entered = Promise.withResolvers<undefined>()
  const hanging: Script = async function * (request) {
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: 'second partial' }
    await new Promise<void>((_resolve, reject) => {
      request.signal?.throwIfAborted()
      request.signal?.addEventListener('abort', () => { reject(new Error('cancelled')) }, { once: true })
      entered.resolve(undefined)
    })
  }
  const { agent, adapter } = await harness([reply('first partial', 'max-tokens'), hanging])
  agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Write it' }], source: { kind: 'user' } }))
  await entered.promise; agent.cancel({ kind: 'user' }); await agent.whenIdle()
  expect(adapter.requests).toHaveLength(2); expect(hasPending(agent)).toBe(false)
  expect(end(agent)?.reason).toEqual({ kind: 'aborted', reason: { kind: 'user' } })
})

it('withdraws continuation and reporting listeners when unloaded', async () => {
  const { agent, adapter, plugin, ctx } = await harness([reply('partial', 'max-tokens'), reply('manual partial', 'max-tokens'), reply('finished')])
  let disposal: Promise<void> | undefined
  const stop = ctx.on('agent/inbox/inserted', ({ message }) => {
    if (message.source.kind === 'output-continuation') disposal = plugin.dispose()
  })
  await run(agent); await disposal; stop()
  expect(adapter.requests).toHaveLength(1); expect(hasPending(agent)).toBe(false)
  await ctx.plugin(continuation, {})
  await run(agent, 'Continue'); expect(adapter.requests).toHaveLength(3); expect(end(agent)?.reason).toEqual({ kind: 'completed' })
})

it('never executes a truncated tool call and allows its complete reissued call', async () => {
  const cut: StreamChunk[] = [{ type: 'block-start', index: 0, blockType: 'tool-call' },
    { type: 'block-end', index: 0, block: { type: 'tool-call', id: ToolCallId('cut'), name: 'echo', arguments: '{"text":' } },
    { type: 'finish', reason: { kind: 'max-tokens' } }]
  const complete: StreamChunk[] = [{ type: 'block-start', index: 0, blockType: 'tool-call' },
    { type: 'block-end', index: 0, block: { type: 'tool-call', id: ToolCallId('whole'), name: 'echo', arguments: '{"text":"done"}' } },
    { type: 'finish', reason: { kind: 'tool-calls' } }]
  const { ctx, agent, adapter } = await harness([cut, complete, reply('Done')])
  const values: string[] = []
  ctx.effect(() => ctx.tools.register(defineContentToolFixture({ name: 'echo', description: 'Echo the text.',
    parameters: { text: { type: 'string', required: true } }, async execute({ text }) { values.push(text); return [{ type: 'text', text }] },
  })))
  await run(agent)
  expect(adapter.requests).toHaveLength(3)
  const calls = agent.session.snapshotEvents().filter(event => event.type === 'tool/call')
  expect(calls).toHaveLength(1); expect(calls[0]?.data.callId).toBe('whole')
  expect(values).toEqual(['done'])
  expect(end(agent)?.reason).toEqual({ kind: 'completed' })
  expect(ctx.agents.get(agent.id)).toBe(agent)
})

it('does not infer a finish reason from a stream that reports none', async () => {
  const { agent, adapter } = await harness([reply('Ended without a finish record').slice(0, -1)])
  await run(agent); expect(adapter.requests).toHaveLength(1); expect(sources(agent)).toEqual([])
})

it('keeps a later pre-step policy rejection as blocked', async () => {
  const { ctx, agent, adapter } = await harness([reply('partial', 'max-tokens')])
  ctx.on('agent/pre-step', async ({ step }, next) => {
    const decision = await next()
    return step === 2 ? { kind: 'reject' } : decision
  })
  await run(agent)
  expect(adapter.requests).toHaveLength(1); expect(end(agent)?.reason).toEqual({ kind: 'blocked' })
  expect(sources(agent)).toEqual([]); expect(hasPending(agent)).toBe(false)
})

it('withdraws dormant continuation reservations on disposal', async () => {
  const { agent, plugin } = await harness([])
  agent.inject(createUserMessage({ source: { kind: 'output-continuation' }, content: [{ type: 'text', text: 'Reserved continuation' }] }))
  expect(hasPending(agent)).toBe(true)
  await plugin.dispose(); expect(hasPending(agent)).toBe(false)
})

it('drops automatic input when a human prompt arrives after its reservation', async () => {
  const { ctx, agent, adapter } = await harness([reply('old partial', 'max-tokens'), reply('new answer')])
  ctx.on('agent/inbox/inserted', ({ message }) => {
    if (message.source.kind === 'output-continuation') agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Replace the task' }] }))
  })
  await run(agent)
  expect(adapter.requests).toHaveLength(2); expect(sources(agent)).toEqual([])
  expect(end(agent)).toEqual({ turn: 2, reason: { kind: 'completed' } })
})

it('rejects stale queued continuation when the driver begins a new turn', async () => {
  const { agent, adapter } = await harness([reply('Fresh answer')])
  agent.inject(createUserMessage({ source: { kind: 'output-continuation' }, content: [{ type: 'text', text: 'Stale continuation' }] }))
  await run(agent)
  expect(adapter.requests).toHaveLength(1); expect(sources(agent)).toEqual([])
})

it('does not let recovery reporting mask cancellation', async () => {
  const { ctx, agent } = await harness([reply('partial', 'max-tokens'), reply('Done')])
  ctx.on('agent/output-limit-recovered', async ({ signal }, next) => {
    await next(); agent.cancel({ kind: 'user' }); expect(signal.aborted).toBe(true); return true
  })
  await run(agent)
  expect(end(agent)?.reason).toEqual({ kind: 'aborted', reason: { kind: 'user' } })
})

it.each([{ maxContinuations: 0 }, { maxContinuations: -1 }, { maxContinuations: 1.5 }, { maxNoProgressResponses: 0 }, { repeatWindowChars: 0 }, { continuationTailChars: 0 }])('rejects invalid continuation configuration %j', (value) => {
  expect(() => continuation.Config.parse(value)).toThrow()
})

it('ignores durable events belonging to a session without a live agent', async () => {
  const { ctx, agent } = await harness([reply('Done')])
  const cold = ctx.sessions.create(SessionId('unloaded-session'))
  cold.append('turn/start', { turn: 1 })
  await run(agent); expect(sources(agent)).toEqual([])
})

it('preserves unrelated injected context in the continuation request', async () => {
  const { ctx, agent, adapter } = await harness([reply('partial', 'max-tokens'), reply('Done')])
  ctx.on('agent/inbox/inserted', ({ message }) => {
    if (message.source.kind === 'output-continuation') agent.inject(createUserMessage({
      source: { kind: 'runtime-context' }, content: [{ type: 'text', text: 'Context from another producer' }],
    }))
  })
  await run(agent); expect(adapter.requests).toHaveLength(2)
  expect(adapter.requests[1]?.messages.some(message => message.content.some(block => block.type === 'text' && block.text === 'Context from another producer'))).toBe(true)
  expect(end(agent)?.reason).toEqual({ kind: 'completed' })
})

it('anchors continuation at the exact bounded response suffix including trailing whitespace', async () => {
  const { agent, adapter } = await harness([reply('A long prefix then xyz ', 'max-tokens'), reply('suffix')], { continuationTailChars: 4 })
  await run(agent)
  expect(adapter.requests[1]?.messages.at(-1)?.content.find(block => block.type === 'text')?.text).toContain('Exact end of the interrupted response (JSON string): "xyz "')
})
