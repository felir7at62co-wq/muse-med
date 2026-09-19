import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { UserMessage } from '@deepseek-ai/dsh-session'
import { createScope } from '@deepseek-ai/dsh-scope'
import type { ScopeKey } from '@deepseek-ai/dsh-scope'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import InvariantRegistry from '@deepseek-ai/dsh-invariants'
import * as CompositionGuard from '@deepseek-ai/dsh-composition-guard'
import { guardState } from '@deepseek-ai/dsh-composition-guard'
import * as GuardInvariant from '@deepseek-ai/dsh-composition-guard/invariant'
import { publishAgent, stubAgent } from './harness.ts'

/**
 * Focused suite for the package's invariant companion: the coverage relation it
 * owns — an agent that addresses a model is one the composed guard holds a
 * baseline for — asserted through the real `system-prompt/assemble` path, its
 * silence when no guard is composed, and the registration contract.
 */

/** Mount the real spine, the invariant service, and the companion. */
async function setup(): Promise<Context> {
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(InvariantRegistry, { enabled: true })
  await ctx.plugin(GuardInvariant)
  return ctx
}

/** One fabricated agent with its own scope, published or not. */
function agentFixture(ctx: Context, id: string): { agent: ReturnType<typeof stubAgent>; scope: ScopeKey } {
  const agentKey: ScopeKey = {}
  const scope = createScope(ctx, agentKey)
  const injected: UserMessage[] = []
  return { agent: stubAgent(SessionId(id), scope.ctx, injected), scope: agentKey }
}

describe('composition-guard invariants', () => {
  it('accepts an assembly for an agent the composed guard holds a baseline for', async () => {
    const ctx = await setup()
    await ctx.plugin(CompositionGuard)
    const { agent, scope } = agentFixture(ctx, 'guarded')
    await publishAgent(ctx, agent)

    await expect(ctx.systemPrompt.assemble({ agent, scope })).resolves.toBeDefined()
  })

  it('rejects an assembly for a live agent with no baseline', async () => {
    const ctx = await setup()
    await ctx.plugin(CompositionGuard)
    const { agent, scope } = agentFixture(ctx, 'unguarded')
    // Live but never announced: the guard's creation listener never saw it, and
    // this session's tools can be withdrawn with nothing watching.
    ctx.agents.enter(agent, undefined)

    await expect(ctx.systemPrompt.assemble({ agent, scope }))
      .rejects.toThrow(/agent "unguarded" addressed a model while the composition guard tracked/)
    await expect(ctx.systemPrompt.assemble({ agent, scope }))
      .rejects.toThrow(/baseline every agent of the runtime it is composed in/)
  })

  it('reports nothing when no guard is composed in this runtime', async () => {
    const ctx = await setup()
    const { agent, scope } = agentFixture(ctx, 'uncomposed')
    ctx.agents.enter(agent, undefined)

    await expect(ctx.systemPrompt.assemble({ agent, scope })).resolves.toBeDefined()
  })

  it('leaves an assembly without an agent alone', async () => {
    const ctx = await setup()
    await ctx.plugin(CompositionGuard)

    await expect(ctx.systemPrompt.assemble()).resolves.toBeDefined()
  })

  it('sees the coverage the guard publishes for this runtime, and none for a bare one', async () => {
    const ctx = await setup()
    await ctx.plugin(CompositionGuard)
    const { agent, scope } = agentFixture(ctx, 'tracked')
    await publishAgent(ctx, agent)

    const state = guardState(ctx.root.fiber)
    expect(state.composed).toBe(true)
    expect(state.tracked.map(tracked => tracked.agent)).toEqual([agent])

    await expect(ctx.systemPrompt.assemble({ agent, scope })).resolves.toBeDefined()

    // A runtime composing no guard owes the relation nothing.
    expect(guardState(new Context().fiber)).toEqual({ composed: false, tracked: [] })
  })

  it('registers under its own package name without a default export', async () => {
    expect(GuardInvariant.name).toBe('composition-guard-invariant')
    expect(GuardInvariant.inject).toEqual(['invariants'])
    expect('default' in GuardInvariant).toBe(false)

    const ctx = await setup()
    // The companion mounted by `setup` already reserved this package name, so a
    // second registration of the same owner is refused — proof the companion
    // registered as this package rather than reserving some other name.
    expect(() => ctx.invariants.register('@deepseek-ai/dsh-composition-guard', () => {}))
      .toThrow(/is already registered/)
  })
})
