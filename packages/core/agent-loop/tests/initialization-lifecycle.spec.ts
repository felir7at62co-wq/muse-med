/** Legal optional constructor configuration and shutdown before async initialization. */
import { expect, it, onTestFinished } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'

it('defaults omitted durable claims and shares shutdown before projection initialization', async () => {
  const ctx = new Context(); onTestFinished(() => ctx.fiber.dispose())
  await mountAgentLoopTestDependencies(ctx)
  const { durableInboxClaims: _claims, ...config } = AgentLoop.Config({ agents: [] })
  const loop = new AgentLoop(ctx, config)
  expect(loop.config.durableInboxClaims).toBe(false)
  const shutdown = loop.shutdown()
  expect(loop.shutdown()).toBe(shutdown)
  await shutdown
  expect(ctx.agents.list()).toEqual([])
})
