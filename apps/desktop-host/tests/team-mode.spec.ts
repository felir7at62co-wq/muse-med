/** Product Team defaults use the official shared board without changing routing-only Main Sessions. */
import { mkdtemp, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import type { Agent, AgentSetup } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import Teams from '@deepseek-ai/dsh-agent-team'
import { SessionId } from '@deepseek-ai/dsh-session'
import * as JsonlPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import Subagents from '@deepseek-ai/dsh-subagent'
import { defineContentToolFixture, executeModelToolFixture } from '@deepseek-ai/dsh-tool-testkit'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { expect, it } from 'vitest'
import { mountAgentLoopTestDependencies } from '../../../packages/test-support/agent-loop-testkit/src/index.ts'
import { mountWorkingDirectoryFixture } from '../../../packages/subagent/subagent/tests/working-directory-fixture.ts'
import * as TeamTools from '../../../packages/team/tool-agent-team/src/index.ts'
import * as MainPolicy from '../../../packages/session/session-coordinator/src/policy.ts'
import { MockAdapter } from '../../../packages/core/agent-loop/tests/mock-adapter.ts'
import * as DelegationPolicy from '../src/delegation-policy.ts'

async function fixture(run: (ctx: Context) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'muse-team-mode-'))
  const ctx = new Context()
  try {
    await mountAgentLoopTestDependencies(ctx)
    await mountWorkingDirectoryFixture(ctx)
    await ctx.plugin(JsonlPersistence, { root: join(root, 'sessions') }).await()
    await ctx.plugin(AgentLoop, { agents: [] }).await()
    await ctx.plugin(Subagents).await()
    await ctx.plugin(Teams).await()
    await ctx.plugin(TeamTools).await()
    ctx.llm.registerAdapter(['mock'], new MockAdapter([]))
    await run(ctx)
  } finally {
    await ctx.fiber.dispose()
    await rm(root, { recursive: true, force: true })
  }
}

async function offered(ctx: Context, agent: Agent): Promise<string[]> {
  const toolSet = await ctx.tools.resolve({ agent, modelSelection: { provider: 'mock', model: 'mock' }, signal: new AbortController().signal })
  try { return ctx.tools.schemas(agent, toolSet).map(tool => tool.name) }
  finally { toolSet.dispose() }
}

const shortDrama: AgentSetup = async (scope) => { await scope.plugin(DelegationPolicy, { teamByDefault: true }).await() }

it('enables official Team tasks only for opted-in short-drama roots and preserves user choices on resume', async () => {
  await fixture(async (ctx) => {
    const ordinary = await ctx.agents.create({ sessionId: SessionId('plain') })
    expect(ctx.agentTeams.isEnabled(ordinary.agent)).toBe(false)
    const worker = await ctx.agents.create({ sessionId: SessionId('drama'), setup: shortDrama })
    expect(ctx.agentTeams.isEnabled(worker.agent)).toBe(true)
    expect(await offered(ctx, worker.agent)).toContain('team_task_create')
    const task = await ctx.agentTeams.createTask(worker.agent, { subject: 'Review episode two', description: 'Retain episode three unchanged.' })
    expect(ctx.agentTeams.listTasks(worker.agent)).toEqual([task])
    await ctx.agentTeams.setEnabled(worker.agent, false)
    expect(await offered(ctx, worker.agent)).not.toContain('team_task_create')
    await worker.dispose()
    const resumed = await ctx.agents.resume({ resumeSessionId: SessionId('drama'), setup: shortDrama })
    expect(ctx.agentTeams.isEnabled(resumed.agent)).toBe(false)
    expect(resumed.agent.session.ownEvents().filter(event => event.type === 'team/mode').map(event => event.data.enabled))
      .toEqual([true, false])
  })
})

it.each([true, false])('retains an explicit Team selection of %s during root setup', async (enabled) => {
  await fixture(async (ctx) => {
    const handle = await ctx.agents.create({ sessionId: SessionId(`selected-${enabled}`), setup: async (scope, agent) => {
      await shortDrama(scope, agent)
      agent.session.append('team/mode', { enabled })
    } })
    expect(ctx.agentTeams.isEnabled(handle.agent)).toBe(enabled)
    expect(handle.agent.session.ownEvents().filter(event => event.type === 'team/mode')).toHaveLength(1)
  })
})

it('keeps the Main Session routing-only while the execution preset enables Team by default', async () => {
  await fixture(async (ctx) => {
    ctx.tools.register(defineContentToolFixture({ name: 'bash', description: 'Business execution fixture', parameters: {}, execute: async () => [] }))
    const main = await ctx.agents.create({ sessionId: SessionId('main'), setup: async (scope) => { await scope.plugin(MainPolicy).await() } })
    expect(ctx.agentTeams.isEnabled(main.agent)).toBe(false)
    expect(await offered(ctx, main.agent)).not.toContain('team_task_create')
    const result = await executeModelToolFixture(main.agent.ctx, { agent: main.agent, name: 'bash', arguments: {},
      callId: ToolCallId('main-business-denied'), signal: new AbortController().signal })
    expect(result.isError).toBe(true)
    const source = await readFile(new URL('../presets/short-drama/agent.cordis.yml', import.meta.url), 'utf8')
    expect(source).toContain('teamByDefault: true')
    const routing = await readFile(new URL('../presets/main-session/agent.cordis.yml', import.meta.url), 'utf8')
    expect(routing).not.toContain('delegation-policy')
  })
})
