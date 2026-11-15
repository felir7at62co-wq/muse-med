/** A Session that starts a subagent receives the subagent's status line until it settles. */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import * as JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import SubagentRuntime from '@deepseek-ai/dsh-subagent'
import * as SubagentSpawn from '@deepseek-ai/dsh-subagent-spawn-in-process'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { MockAdapter, textResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import { TestSessionQuery } from '../../../team/agent-team/tests/test-session-query.ts'
import { mountWorkingDirectoryFixture } from '../../../subagent/subagent/tests/working-directory-fixture.ts'
import SessionActivityDigests from '../src/index.ts'

type Script = ConstructorParameters<typeof MockAdapter>[0]

async function setup(script: Script, activityFirst: boolean) {
  const ctx = new Context()
  const root = await mkdtemp(join(tmpdir(), 'dsh-session-activity-subagents-'))
  onTestFinished(async () => {
    await ctx.fiber.dispose()
    await rm(root, { recursive: true, force: true })
  })
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(JsonlSessionPersistence, { root })
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(TestSessionQuery)
  await mountWorkingDirectoryFixture(ctx)
  await ctx.plugin(SubagentRuntime)
  await ctx.plugin(SubagentSpawn, { providerName: 'spawn' })
  ctx.llm.registerAdapter(['mock'], new MockAdapter(script))
  const mountActivity = () => ctx.plugin(SessionActivityDigests, { coalesceMs: 0, stallMs: 0 })
  if (activityFirst) await mountActivity()
  const parent = await ctx.agentLoop.create(SessionId('parent'), { provider: 'mock', model: 'mock' })
  return { ctx, parent, mountActivity }
}

function digests(agent: Agent): string[] {
  return [...agent.inbox.nextTurn, ...agent.inbox.nextStep]
    .filter((message: UserMessage) => message.source.kind === 'session-activity')
    .map(message => message.content.flatMap(block => block.type === 'text' ? [block.text] : []).join(''))
}

function start(ctx: Context, parent: Agent) {
  return ctx.subagents.startActivation({
    parent, provider: 'spawn', label: '转写第001集', name: 'ep001-writer', delivery: 'parent',
    prompt: [{ type: 'text', text: '转写第001集' }], signal: new AbortController().signal,
  })
}

describe('subagent status lines', () => {
  it('reports a running subagent to its creator under its catalog name and task', { timeout: 20_000 }, async () => {
    const { ctx, parent } = await setup(['hang', ...Array.from({ length: 6 }, () => textResponse('ok'))], true)
    const activation = await start(ctx, parent)
    await vi.waitFor(() => { expect(digests(parent).join('\n')).toContain('- ep001-writer: 转写第001集 [') })
    expect(digests(parent).join('\n')).toMatch(/\] running/u)
    await activation.dispose()
  })

  it('ignores the end of a run it never watched', { timeout: 20_000 }, async () => {
    const { ctx, parent, mountActivity } = await setup(['hang', ...Array.from({ length: 6 }, () => textResponse('ok'))], false)
    const activation = await start(ctx, parent)
    await mountActivity()
    await activation.dispose()
    expect(digests(parent)).toEqual([])
  })
})
