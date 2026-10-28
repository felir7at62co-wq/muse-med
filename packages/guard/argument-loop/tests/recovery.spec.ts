import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import GoalService from '@deepseek-ai/dsh-goal'
import * as goalDriver from '@deepseek-ai/dsh-goal-round-driver'
import { createUserMessage, expandAssistantStream, LlmAdapter, resolveRetryPolicy, ToolCallId } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, ResolvedRetryPolicy, StreamChunk } from '@deepseek-ai/dsh-llm'
import * as retry from '@deepseek-ai/dsh-llm-retry'
import { SessionId } from '@deepseek-ai/dsh-session'
import { defineTool } from '@deepseek-ai/dsh-tools'
import * as guard from '../src/index.ts'

const contexts = new Set<Context>()

afterEach(async () => {
  for (const ctx of contexts) await ctx.fiber.dispose()
  contexts.clear()
})

function call(name: string): StreamChunk {
  return { type: 'block-end', index: 0, block: { type: 'tool-call', id: ToolCallId(name), name, arguments: '{}' } }
}

function loop(): StreamChunk[] {
  return [
    call('forbidden'),
    { type: 'tool-call-delta', index: 1, id: ToolCallId('loop'), name: 'forbidden', argumentsDelta: '{"page_num":1,"page_num":2' },
    { type: 'finish', reason: { kind: 'tool-calls' } },
  ]
}

function done(): StreamChunk[] {
  return [{ type: 'block-end', index: 0, block: { type: 'text', text: 'Completed from retained work.' } }, { type: 'finish', reason: { kind: 'stop' } }]
}

type Response = StreamChunk[] | ((options: GenerateOptions) => Promise<StreamChunk[]>)

class Adapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = []
  readonly exitsBeforeRequest: number[] = []
  exits = 0

  constructor(private readonly script: Response[], private readonly always = false) { super() }

  override providerRetryPolicy(): ResolvedRetryPolicy | undefined {
    return this.always ? resolveRetryPolicy({ mode: 'always', backoff: { initialDelayMs: 1, maxDelayMs: 1, jitterRatio: 0 } }, 'test') : undefined
  }

  override async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.exitsBeforeRequest.push(this.exits)
    this.requests.push(options)
    try {
      const entry = this.script.shift()
      if (entry === undefined) throw new Error('unexpected extra model request')
      const response = typeof entry === 'function' ? await entry(options) : entry
      yield* response
    } finally { this.exits++ }
  }
}

async function harness(script: Response[], always = false, recoveryAttempts = 1) {
  const ctx = new Context()
  contexts.add(ctx)
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(retry)
  await ctx.plugin(GoalService)
  await ctx.plugin(goalDriver)
  const fiber = await ctx.plugin(guard, { repeatedPropertyLimit: 2, recoveryAttempts })
  await ctx.plugin(AgentLoop, { agents: [] })
  const adapter = new Adapter(script, always)
  ctx.llm.registerAdapter(['mock'], adapter)
  const effects = { retained: 0, recovered: 0, forbidden: 0 }
  for (const name of ['retained', 'recovered', 'forbidden'] as const) ctx.tools.register(defineTool({
    name, description: 'Count a local effect.', parameters: {},
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    execute: async () => { effects[name]++; return `${name} result` },
  }))
  const agent = await ctx.agentLoop.create(SessionId(`argument-recovery-${Math.random()}`), { provider: 'mock', model: 'mock' })
  const run = async () => {
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Finish the existing task.' }], source: { kind: 'user' } }))
    await agent.whenIdle()
  }
  return { ctx, fiber, adapter, agent, effects, run }
}

describe('bounded local request recovery', () => {
  it('retains earlier effects and failed raw output while resampling only the unsettled response', async () => {
    const test = await harness([
      [call('retained'), { type: 'finish', reason: { kind: 'tool-calls' } }], loop(),
      [call('recovered'), { type: 'finish', reason: { kind: 'tool-calls' } }], done(),
    ], true)
    await test.run()
    expect(test.adapter.requests).toHaveLength(4)
    expect(test.adapter.exits).toBe(4)
    expect(test.adapter.exitsBeforeRequest).toEqual([0, 1, 2, 3])
    expect(test.effects).toEqual({ retained: 1, recovered: 1, forbidden: 0 })
    const failedRequest = test.adapter.requests[1]!
    const resampled = test.adapter.requests[2]!
    expect(resampled.messages).toEqual(failedRequest.messages)
    expect(resampled.signal).toBe(failedRequest.signal)
    expect(resampled.model).toBe(failedRequest.model)
    const events = test.agent.session.snapshotEvents()
    const attempts = events.filter(event => event.type === 'assistant/attempt')
    expect(attempts).toHaveLength(1)
    const raw = expandAssistantStream(attempts[0]!.data.stream).map(record => record.chunk)
    expect(raw).toHaveLength(3)
    expect(raw.slice(0, 2)).toEqual(loop().slice(0, 2))
    expect(raw[2]).toMatchObject({ type: 'finish', reason: { kind: 'error', failure: { code: guard.TOOL_ARGUMENT_LOOP } } })
    expect(events.filter(event => event.type === 'tool/call').map(event => event.data.name)).toEqual(['retained', 'recovered'])
    expect(events.filter(event => event.type === 'turn/end').map(event => event.data.reason.kind)).toEqual(['completed'])
    expect(events.filter(event => event.type === 'llm/retry')).toHaveLength(0)
  })

  it('terminates a second local loop even when the provider always retries', async () => {
    const test = await harness([loop(), loop()], true)
    await test.run()
    expect(test.adapter.requests).toHaveLength(2)
    expect(test.adapter.exits).toBe(2)
    expect(test.effects.forbidden).toBe(0)
    expect(test.agent.session.snapshotEvents().filter(event => event.type === 'assistant/attempt')).toHaveLength(2)
    expect(test.agent.session.snapshotEvents().findLast(event => event.type === 'turn/end')?.data.reason)
      .toMatchObject({ kind: 'error', error: { code: guard.TOOL_ARGUMENT_LOOP } })
  })

  it('does not replenish the recovery budget after another successful step in the same turn', async () => {
    const test = await harness([loop(), [call('recovered'), { type: 'finish', reason: { kind: 'tool-calls' } }], loop()], true)
    await test.run()
    expect(test.adapter.requests).toHaveLength(3)
    expect(test.effects).toEqual({ retained: 0, recovered: 1, forbidden: 0 })
  })

  it('gives a later explicit user turn its own bounded budget', async () => {
    const test = await harness([loop(), done(), loop(), done()])
    await test.run()
    await test.run()
    expect(test.adapter.requests).toHaveLength(4)
    expect(test.adapter.requests[0]!.signal).not.toBe(test.adapter.requests[2]!.signal)
    expect(test.agent.session.snapshotEvents().filter(event => event.type === 'turn/end').map(event => event.data.reason.kind))
      .toEqual(['completed', 'completed'])
  })

  it.each(['1301', 'PI_AI_ERROR', 'TOOL_ARGUMENT_LOOP'])('does not recover an unwitnessed provider failure %s', async (code) => {
    const test = await harness([[{ type: 'finish', reason: { kind: 'error', failure: { code, message: 'provider failure' } } }]])
    await test.run()
    expect(test.adapter.requests).toHaveLength(1)
    expect(test.agent.session.snapshotEvents().findLast(event => event.type === 'turn/end')?.data.reason).toMatchObject({ kind: 'error', error: { code } })
  })

  it('clears a local witness when another recovery policy retries before delegating', async () => {
    const test = await harness([
      loop(), [{ type: 'finish', reason: { kind: 'error', failure: { code: guard.TOOL_ARGUMENT_LOOP, message: 'provider copy' } } }],
    ])
    let handled = false
    test.ctx.on('agent/request-error', (_payload, next) => {
      if (handled) return next()
      handled = true
      return Promise.resolve({ kind: 'retry' as const })
    }, { prepend: true })
    await test.run()
    expect(test.adapter.requests).toHaveLength(2)
    expect(test.agent.session.snapshotEvents().findLast(event => event.type === 'turn/end')?.data.reason)
      .toMatchObject({ kind: 'error', error: { code: guard.TOOL_ARGUMENT_LOOP, message: 'provider copy' } })
  })

  it('reserves the local recovery budget even when another policy handles its error', async () => {
    const test = await harness([loop(), loop(), done()], true)
    test.ctx.on('agent/request-error', () => Promise.resolve({ kind: 'retry' as const }), { prepend: true })
    await test.run()
    expect(test.adapter.requests).toHaveLength(2)
    expect(test.effects.forbidden).toBe(0)
    expect(test.agent.session.snapshotEvents().findLast(event => event.type === 'turn/end')?.data.reason)
      .toMatchObject({ kind: 'error', error: { code: guard.TOOL_ARGUMENT_LOOP } })
  })

  it('keeps goal continuation armed when the same admitted round recovers', async () => {
    const test = await harness([loop(), done()])
    test.ctx.goals.create(test.agent, { objective: 'Finish from retained work.', maxGoalRounds: 1 })
    await vi.waitFor(() => { expect(test.ctx.goals.get(test.agent)?.phase).toBe('blocked') })
    expect(test.ctx.goals.get(test.agent)).toMatchObject({ roundsStarted: 1, blockedReason: { code: 'round-limit' } })
    expect(test.adapter.requests).toHaveLength(2)
  })

  it.each(['cancel', 'pause'] as const)('does not resample after %s reaches the failed-attempt settlement', async (operation) => {
    const test = await harness([loop()], true)
    const entered = Promise.withResolvers<null>()
    const release = Promise.withResolvers<null>()
    test.ctx.on('agent/request-error', async (_payload, next) => {
      entered.resolve(null)
      await release.promise
      return next()
    }, { prepend: true })
    test.ctx.goals.create(test.agent, { objective: 'Respect cancellation.', maxGoalRounds: 3 })
    await entered.promise
    if (operation === 'cancel') test.agent.cancel({ kind: 'user' })
    else {
      const goal = test.ctx.goals.get(test.agent)!
      test.ctx.goals.pause(test.agent, { id: goal.id, revision: goal.revision })
    }
    release.resolve(null)
    await vi.waitFor(() => { expect(test.ctx.goals.get(test.agent)?.phase).toBe('paused') })
    await test.agent.whenIdle()
    expect(test.adapter.requests).toHaveLength(1)
    expect(test.effects.forbidden).toBe(0)
  })

  it('does not resample if the guard unloads while the failed attempt settles', async () => {
    const test = await harness([loop()], true)
    let disposal: Promise<unknown> | undefined
    test.ctx.on('session/event', (session, event) => {
      if (session === test.agent.session && event.type === 'assistant/attempt') disposal = test.fiber.dispose()
    })
    await test.run()
    await disposal
    expect(test.adapter.requests).toHaveLength(1)
    expect(test.effects.forbidden).toBe(0)
  })

  it('cancels recovery admitted before unload but not yet sent to the provider', async () => {
    const test = await harness([loop()], true)
    const entered = Promise.withResolvers<null>()
    const release = Promise.withResolvers<null>()
    let requests = 0
    test.ctx.on('agent/request', async (_payload, next) => {
      if (++requests === 2) {
        entered.resolve(null)
        await release.promise
      }
      return next()
    })
    const run = test.run()
    await entered.promise
    const disposal = test.fiber.dispose()
    release.resolve(null)
    await Promise.all([run, disposal])
    expect(test.adapter.requests).toHaveLength(1)
    expect(test.effects.forbidden).toBe(0)
  })

  it.each([false, true])('drains admitted recovery awaiting credentials before provider dispatch (already cancelled: %s)', async (cancelled) => {
    const entered = Promise.withResolvers<AbortSignal>()
    const credentials = Promise.withResolvers<null>()
    let dispatched = 0
    const test = await harness([loop(), async (options) => {
      const signal = options.signal!
      entered.resolve(signal)
      await credentials.promise
      signal.throwIfAborted()
      dispatched++
      return done()
    }], true)
    const run = test.run()
    const signal = await entered.promise
    if (cancelled) test.agent.cancel({ kind: 'user' })
    let disposed = false
    const disposal = test.fiber.dispose().then(() => { disposed = true })
    try {
      await vi.waitFor(() => { expect(signal.aborted).toBe(true) })
      expect(disposed).toBe(false)
    } finally {
      credentials.resolve(null)
    }
    await Promise.all([run, disposal])
    expect(disposed).toBe(true)
    expect(dispatched).toBe(0)
    expect(test.adapter.requests).toHaveLength(2)
    expect(test.adapter.exits).toBe(2)
    expect(test.effects.forbidden).toBe(0)
  })

  it('does not cancel a later unrelated turn after another policy rejects recovery', async () => {
    const test = await harness([loop(), [call('hold'), { type: 'finish', reason: { kind: 'tool-calls' } }], done()])
    const reject = test.ctx.on('agent/request-error', () => { throw new Error('another policy rejected recovery') }, { prepend: true })
    await test.run()
    reject()
    const entered = Promise.withResolvers<null>()
    const release = Promise.withResolvers<null>()
    test.ctx.tools.register(defineTool({
      name: 'hold', description: 'Hold unrelated work until released.', parameters: {},
      output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
      execute: async () => { entered.resolve(null); await release.promise; return 'released' },
    }))
    const run = test.run()
    await entered.promise
    const cancel = vi.spyOn(test.agent, 'cancel')
    const disposal = test.fiber.dispose()
    release.resolve(null)
    await Promise.all([run, disposal])
    expect(cancel).not.toHaveBeenCalled()
    expect(test.adapter.requests).toHaveLength(3)
  })
})
