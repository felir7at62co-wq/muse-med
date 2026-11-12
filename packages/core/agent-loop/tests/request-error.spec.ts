import * as NativeToolExecutor from '@deepseek-ai/dsh-tool-executor-native'
import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import LlmRuntime, { createUserMessage, LlmError, ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type { LlmFailure, ResolvedRetryPolicy } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { defineContentToolFixture } from '@deepseek-ai/dsh-tool-testkit'
import { MockAdapter, textResponse, toolCallResponse } from './mock-adapter.ts'

async function harness(adapter: MockAdapter): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(NativeToolExecutor)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(AgentLoop, { agents: [] })
  ctx.llm.registerAdapter(['mock'], adapter)
  return ctx
}

function fail(message: string, code: string): () => never {
  return () => {
    throw new LlmError(message, code)
  }
}

describe('agent/request-error', () => {
  it('does not offer middleware failures to request recovery', async () => {
    const adapter = new MockAdapter([textResponse('unused')])
    const ctx = await harness(adapter)
    const agent = await ctx.agentLoop.create(SessionId('request-error-narrow'), { provider: 'mock', model: 'mock' })
    let recoveries = 0
    ctx.on('agent/request', () => {
      throw new LlmError('middleware failed', 'MIDDLEWARE')
    })
    ctx.on('agent/request-error', async () => {
      recoveries += 1
    })

    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
    await agent.whenIdle()

    expect(recoveries).toBe(0)
    expect(adapter.requests).toHaveLength(0)
  })

  it('lets each failed request return a retry action before its turn closes', async () => {
    const adapter = new MockAdapter([
      fail('busy', 'RATE_LIMIT'),
      fail('unavailable', 'SERVICE_UNAVAILABLE'),
      textResponse('ok'),
    ])
    const ctx = await harness(adapter)
    const agent = await ctx.agentLoop.create(SessionId('request-error-retry'), { provider: 'mock', model: 'mock' })
    const seen: {
      turn: number
      step: number
      failure: LlmFailure
      retryPolicy: ResolvedRetryPolicy | undefined
    }[] = []
    const statuses: string[] = []
    ctx.on('agent/status', ({ agent: subject, status }) => {
      if (subject === agent) statuses.push(status)
    })
    ctx.on('agent/request-error', async ({ agent: subject, turn, step, failure, retryPolicy }) => {
      expect(subject).toBe(agent)
      seen.push({ turn, step, failure, retryPolicy })
      return { kind: 'retry' }
    })

    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
    await agent.whenIdle()

    expect(seen.map(item => ({
      turn: item.turn,
      step: item.step,
      code: item.failure.code,
    }))).toEqual([
      {
        turn: 1,
        step: 1,
        code: 'RATE_LIMIT',
      },
      {
        turn: 1,
        step: 1,
        code: 'SERVICE_UNAVAILABLE',
      },
    ])
    expect(agent.session.snapshotEvents().filter(event => event.type === 'turn/start')).toHaveLength(1)
    expect(seen.map(item => item.retryPolicy)).toEqual([
      expect.objectContaining({ mode: 'normal' }),
      expect.objectContaining({ mode: 'normal' }),
    ])
    expect(statuses).toEqual(['running', 'idle'])
    expect(agent.session.snapshotEvents().flatMap(event =>
      event.type === 'request/header' ? [event.data.reason] : [])).toEqual(['initial'])
  })

  it('lets cancellation win over a retry action', async () => {
    const adapter = new MockAdapter([fail('busy', 'RATE_LIMIT'), textResponse('unused')])
    const ctx = await harness(adapter)
    const agent = await ctx.agentLoop.create(SessionId('request-error-cancel'), { provider: 'mock', model: 'mock' })
    ctx.on('agent/request-error', async ({ agent: subject }) => {
      subject.cancel({ kind: 'user' })
      return { kind: 'retry' }
    })

    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
    await agent.whenIdle()

    expect(adapter.requests).toHaveLength(1)
    expect(agent.session.snapshotEvents().filter(event => event.type === 'turn/start')).toHaveLength(1)
    expect(agent.session.snapshotEvents().find(event => event.type === 'turn/end')).toMatchObject({
      type: 'turn/end',
      data: { reason: { kind: 'aborted', reason: { kind: 'user' } } },
    })
  })

  it('switches a failed provider in a new step without replaying user input or executing failed tool calls', async () => {
    const failedCall = toolCallResponse('untrusted-call', 'unsafe', {})
    const first = new MockAdapter([[
      ...failedCall.slice(0, -1),
      { type: 'finish', reason: { kind: 'error', failure: { code: 'SERVER', message: 'unavailable' } } },
    ]])
    const second = new MockAdapter([textResponse('recovered')])
    const ctx = await harness(first)
    ctx.llm.registerAdapter(['backup'], second)
    let executed = 0
    ctx.tools.register(defineContentToolFixture({
      name: 'unsafe', description: 'Must not run from a failed model attempt', parameters: {},
      async execute() { executed += 1; return [{ type: 'text', text: 'unexpected' }] },
    }))
    const agent = await ctx.agentLoop.create(SessionId('request-error-switch'), { provider: 'mock', model: 'primary' })
    ctx.on('agent/request-error', async ({ provider }) => provider === 'mock'
      ? { kind: 'switch', selection: { provider: 'backup', model: 'secondary' } }
      : undefined)

    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
    await agent.whenIdle()

    expect(first.requests).toHaveLength(1)
    expect(second.requests).toHaveLength(1)
    expect(second.requests[0]).toMatchObject({ provider: 'backup', model: 'secondary' })
    expect(agent.model.current()).toEqual({ provider: 'backup', model: 'secondary' })
    expect(executed).toBe(0)
    const events = agent.session.snapshotEvents()
    expect(events.filter(event => event.type === 'step/start').map(event => event.data.step)).toEqual([1, 2])
    expect(events.filter(event => event.type === 'assistant/attempt')).toHaveLength(1)
    expect(events.filter(event => event.type === 'tool/call')).toHaveLength(0)
    expect(events.filter(event => event.type === 'user/message' && event.data.source.kind === 'user')).toHaveLength(1)
    expect(events.filter(event => event.type === 'request/header').map(event => event.data.header.config.provider)).toEqual(['mock', 'backup'])
    expect(events.find(event => event.type === 'turn/end')).toMatchObject({ data: { reason: { kind: 'completed' } } })
  })

  it('keeps a newer user selection when a provider switch arrives after it', async () => {
    const first = new MockAdapter([fail('unavailable', 'SERVER')])
    const backup = new MockAdapter([textResponse('unused')])
    const selected = new MockAdapter([textResponse('user choice')])
    const ctx = await harness(first)
    ctx.llm.registerAdapter(['backup'], backup)
    ctx.llm.registerAdapter(['selected'], selected)
    const agent = await ctx.agentLoop.create(SessionId('request-error-switch-user-choice'), { provider: 'mock', model: 'primary' })
    ctx.on('agent/request-error', async ({ agent: subject }) => {
      subject.model.select({ provider: 'selected', model: 'chosen' })
      return { kind: 'switch', selection: { provider: 'backup', model: 'secondary' } }
    })

    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
    await agent.whenIdle()

    expect(backup.requests).toHaveLength(0)
    expect(selected.requests).toHaveLength(1)
    expect(agent.model.current()).toEqual({ provider: 'selected', model: 'chosen' })
  })

  it.each([
    { field: 'model', model: 'chosen', effort: ReasoningEffortId('low') },
    { field: 'reasoning effort', model: 'primary', effort: ReasoningEffortId('high') },
  ])('keeps a newer $field selection on the failed provider while recovery is pending', async ({ model, effort }) => {
    const low = ReasoningEffortId('low')
    const first = new MockAdapter([fail('unavailable', 'SERVER'), textResponse('user choice')], {
      efforts: [{ id: low, name: 'Low' }, { id: ReasoningEffortId('high'), name: 'High' }],
      defaultEffort: low,
    })
    const backup = new MockAdapter([textResponse('unused')])
    const ctx = await harness(first)
    ctx.llm.registerAdapter(['backup'], backup)
    const agent = await ctx.agentLoop.create(SessionId(`request-error-switch-user-${model}-${effort}`), {
      provider: 'mock', model: 'primary', reasoningEffort: low,
    })
    const recovering = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    ctx.on('agent/request-error', async () => {
      recovering.resolve(undefined)
      await release.promise
      return { kind: 'switch', selection: { provider: 'backup', model: 'secondary' } }
    })

    try {
      agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
      await recovering.promise
      const selected = { provider: 'mock', model, reasoningEffort: effort }
      agent.model.select(selected)
      release.resolve(undefined)
      await agent.whenIdle()

      expect(backup.requests).toHaveLength(0)
      expect(first.requests.map(request => ({
        model: request.model, reasoningEffort: request.reasoningEffort,
      }))).toEqual([
        { model: 'primary', reasoningEffort: low },
        { model, reasoningEffort: effort },
      ])
      expect(agent.model.current()).toEqual(selected)
      const events = agent.session.snapshotEvents()
      expect(events.filter(event => event.type === 'model/selection').map(event => event.data)).toEqual([selected])
      expect(events.find(event => event.type === 'turn/end')).toMatchObject({ data: { reason: { kind: 'completed' } } })
    } finally {
      release.resolve(undefined)
      await ctx.fiber.dispose()
    }
  })

  it('lets cancellation win over a provider switch', async () => {
    const first = new MockAdapter([fail('unavailable', 'SERVER')])
    const backup = new MockAdapter([textResponse('unused')])
    const ctx = await harness(first)
    ctx.llm.registerAdapter(['backup'], backup)
    const agent = await ctx.agentLoop.create(SessionId('request-error-switch-cancel'), { provider: 'mock', model: 'primary' })
    ctx.on('agent/request-error', async ({ agent: subject }) => {
      subject.cancel({ kind: 'user' })
      return { kind: 'switch', selection: { provider: 'backup', model: 'secondary' } }
    })

    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
    await agent.whenIdle()

    expect(first.requests).toHaveLength(1)
    expect(backup.requests).toHaveLength(0)
    expect(agent.model.current()).toEqual({ provider: 'mock', model: 'primary' })
    expect(agent.session.snapshotEvents().find(event => event.type === 'turn/end')).toMatchObject({
      type: 'turn/end', data: { reason: { kind: 'aborted', reason: { kind: 'user' } } },
    })
  })

  it('rejects a recovery action that selects the failed provider again', async () => {
    const adapter = new MockAdapter([fail('unavailable', 'SERVER'), textResponse('unused')])
    const ctx = await harness(adapter)
    const agent = await ctx.agentLoop.create(SessionId('request-error-switch-same-provider'), { provider: 'mock', model: 'primary' })
    ctx.on('agent/request-error', async () => ({
      kind: 'switch', selection: { provider: 'mock', model: 'another-model' },
    }))

    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
    await agent.whenIdle()

    expect(adapter.requests).toHaveLength(1)
    expect(agent.model.current()).toEqual({ provider: 'mock', model: 'primary' })
    expect(agent.session.snapshotEvents().find(event => event.type === 'turn/end')).toMatchObject({
      type: 'turn/end', data: { reason: { kind: 'error', error: { code: 'UNKNOWN' } } },
    })
  })

  it('does not retry when the recovery listener fails before returning its action', async () => {
    const adapter = new MockAdapter([fail('busy', 'RATE_LIMIT'), textResponse('unused')])
    const ctx = await harness(adapter)
    const agent = await ctx.agentLoop.create(SessionId('request-error-recovery-failed'), {
      provider: 'mock',
      model: 'mock',
    })
    ctx.on('agent/request-error', async () => {
      throw new Error('recovery failed')
    })

    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
    await agent.whenIdle()

    expect(adapter.requests).toHaveLength(1)
    expect(agent.session.snapshotEvents().filter(event => event.type === 'turn/start')).toHaveLength(1)
    expect(agent.session.snapshotEvents().find(event => event.type === 'turn/end')).toMatchObject({
      type: 'turn/end',
      data: { reason: { kind: 'error' } },
    })
  })
})
