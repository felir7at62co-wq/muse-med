/** Native AgentLoop and durable KV fixture; only the ordinary Session creation adapter is replaced. */
import { Context, Service } from '@deepseek-ai/cordis'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies, provideWorkingDirectoryFixture } from '@deepseek-ai/dsh-agent-loop-testkit'
import SubagentRuntime from '@deepseek-ai/dsh-subagent'
import { WorkspaceController } from '@deepseek-ai/dsh-api-workspace-controller'
import { SessionController } from '@deepseek-ai/dsh-api-session-controller'
import type { SessionCreateRequest } from '@deepseek-ai/dsh-api-session-controller/types'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { Agent } from '@deepseek-ai/dsh-agent'
import Storage from '@deepseek-ai/dsh-storage'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import WorkspaceRegistry from '@deepseek-ai/dsh-workspace'
import JobsLocal from '@deepseek-ai/dsh-jobs-local'
import TypertRegistry from '@deepseek-ai/dsh-typert-registry'
import * as Persistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import { MockAdapter, textResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import { TestSessionQuery } from '../../../team/agent-team/tests/test-session-query.ts'
import { MemoryMediaPool, MemoryStorageBackend } from '../../../storage/storage-domain/tests/helpers/memory-backend.ts'
import Coordinator from '../src/index.ts'
import * as Main from '../src/main.ts'
import * as Worker from '../src/worker.ts'

/** Ordinary-Session provisioning through real factory and independent scopes. */
class TestController extends SessionController {
  static override inject = ['agents', 'workspaceRegistry']
  override async [Service.init](): Promise<void> {}
  override async create(request: SessionCreateRequest) {
    const id = request.sessionId ?? SessionId('unused')
    const workspace = request.workspaceId === undefined ? undefined : this.ctx.workspaceRegistry.get(request.workspaceId)
    if (this.ctx.agents.get(id) === undefined) {
      await makeAgent(this.ctx, id, request.agentPreset ?? 'short-drama', workspace?.path ?? request.cwd ?? '/worker')
    }
    if (workspace !== undefined) await workspace.attachSession(id)
    return { sessionId: id, ...(request.agentPreset === undefined ? {} : { agentPreset: request.agentPreset }) }
  }
  override async resolveAgent(id: SessionId) {
    const agent = this.ctx.agents.get(id)
    if (agent === undefined) throw new Error('test Session is not live')
    return { agent }
  }
}

class TestWorkspaceController extends WorkspaceController {
  static override inject = ['workspaceRegistry', 'typert']
  async [Service.init](): Promise<void> {}
}

/** Create a real ordinary Agent with explicit creation metadata and preset contributions. */
export async function makeAgent(ctx: Context, id: SessionId, preset: string, cwd = '/main'): Promise<Agent> {
  const handle = await ctx.agents.create({ sessionId: id, meta: { cwd, agentPreset: preset },
    agentOptions: { provider: 'mock', model: 'mock' }, setup: async (scope) => {
      if (preset === 'main-session') await scope.plugin(Main)
    } })
  return handle.agent
}

/** Build one fixture with independent scopes; caller owns disposal and its private persistence root. */
export async function setup(root: string, script: ConstructorParameters<typeof MockAdapter>[0], pool = new MemoryMediaPool()) {
  const ctx = new Context()
  try {
    await mountAgentLoopTestDependencies(ctx)
    await ctx.plugin(TypertRegistry)
    await ctx.plugin(Persistence, { root })
    await ctx.plugin(TestSessionQuery)
    await ctx.plugin(AgentLoop, { agents: [] })
    provideWorkingDirectoryFixture(ctx)
    await ctx.plugin(SubagentRuntime)
    await ctx.plugin(Storage)
    ctx.storage.backend.register('memory', new MemoryStorageBackend(pool))
    const domain = new DomainFacility(ctx, { backend: 'memory', routes: {} })
    ctx.storage.mount('domain', domain)
    ctx.provide('storageDomain', domain)
    ctx.effect(() => () => domain.closeAll())
    await ctx.plugin(WorkspaceRegistry)
    await ctx.plugin(TestWorkspaceController, { documentsDirectory: root })
    await ctx.workspaceController.initializeDefault(new AbortController().signal)
    await ctx.plugin(JobsLocal, {})
    ctx.jobs.attachController('coordination-test')
    await ctx.plugin(TestController, {})
    const adapter = new MockAdapter(script)
    ctx.llm.registerAdapter(['mock'], adapter)
    const fiber = await ctx.plugin(Coordinator, {})
    await ctx.plugin(Worker)
    if (ctx.tools.get('coordinator_report') === undefined) throw new Error('Worker report did not mount')
    return { ctx, adapter, pool, fiber, service: ctx.sessionCoordinator, makeAgent: (id: string, preset = 'short-drama', cwd?: string) => makeAgent(ctx, SessionId(id), preset, cwd) }
  } catch (error) {
    await ctx.fiber.dispose()
    throw error
  }
}

export { textResponse }
