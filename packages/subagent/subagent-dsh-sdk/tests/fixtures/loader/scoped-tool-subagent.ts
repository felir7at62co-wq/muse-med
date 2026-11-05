/** Mount the SDK delegation tool in each fixture Agent's scope. */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import * as ToolSubagent from '@deepseek-ai/dsh-tool-subagent'
import type { Config } from '@deepseek-ai/dsh-tool-subagent'

export const name = 'scoped-tool-subagent'
export const inject = ['agents', 'subagentModelSelection']

/**
 * Install the configured delegation tool before a published Agent starts its loop.
 * @param ctx - fixture Host context carrying Agent lifecycle events.
 * @param config - delegation-tool configuration forwarded into each Agent scope.
 */
export async function apply(ctx: Context, config: Config): Promise<void> {
  const install = async (agent: Agent): Promise<void> => {
    await agent.ctx.inject(ToolSubagent.inject, (runtimeCtx) => {
      return ToolSubagent.apply(runtimeCtx, {
        provider: config.provider,
        modelSelection: true,
        modelDiscovery: true,
        ...(config.toolName === undefined ? {} : { toolName: config.toolName }),
        ...(config.agentOptions === undefined ? {} : { agentOptions: config.agentOptions }),
        ...(config.maxDepth === undefined ? {} : { maxDepth: config.maxDepth }),
      })
    })
  }
  ctx.on('agent/created', async ({ agent }) => { await install(agent) })
  for (const agent of ctx.agents.list()) await install(agent)
}
